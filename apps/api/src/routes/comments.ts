/**
 * Comments API — Stage 6 (read-only at this layer; reply via `parentId`):
 *
 *   GET    /api/comments?pageId=X&limit=&offset=  → top-level + replies
 *                                                    grouped under top-level
 *   GET    /api/comments/mention-candidates?pageId=X&q=Y  → candidate user list
 *   POST   /api/comments                           → create (mention/reply/thread)
 *   PATCH  /api/comments/:id                       → edit content (author or admin)
 *   DELETE /api/comments/:id                       → soft-delete (author or admin)
 *
 * All routes are gated by `requireAuth` (no admin bypass — personal-space
 * guard applies to writes; reads follow `canAccessSpace`).
 *
 * Visibility policy (mirrors pages.ts):
 *   - Inaccessible page → 404 (NEVER 403 — avoid leaking page existence).
 *   - Disabled user / soft-deleted page → 404.
 *   - Admin writing a personal-space page → 403 personal_space_readonly.
 *   - Comment edit/delete: author-or-admin (after visibility gates).
 *
 * Thread shape (v0):
 *   - Top-level comments: parent_id IS NULL.
 *   - Replies: parent_id = some top-level id. v0 does NOT support reply-on-reply;
 *     composer can only attach to top-level.
 *   - List response is a flat array of top-level comments with each carrying
 *     `replies: Comment[]` (NOT a recursive nesting — max depth is 2 levels).
 *
 * Mention semantics:
 *   - `mentionedUserIds` in the response is the snapshot used at write time.
 *     It's rewritten on PATCH (last-write-wins — see Stage 6 risk log).
 *   - Notification fan-out is driven from this column by `enqueueNotifications`.
 *
 * The single transaction boundary in POST:
 *   - insert comment row
 *   - (reply) enqueueNotification(kind='reply')
 *   - (top-level) enqueueNotification(kind='comment_on_my_page')
 *   - (mentions) enqueueNotification(kind='mention') — all in one tx
 */

import { Hono } from 'hono'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  CommentSchema,
  CreateCommentInputSchema,
  MentionCandidateSchema,
  MentionCandidatesQuerySchema,
  UpdateCommentInputSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { comments, pages, users } from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { stripMarkdown } from '../lib/stripMarkdown'
import {
  guardCreateComment,
  guardMutateComment,
  guardReadPage,
} from '../lib/commentGuards'
import { rowToComment } from '../lib/commentRowMappers'
import { getMentionCandidates } from '../lib/mentionCandidates'
import { enqueueNotifications } from '../lib/notify'

export const commentsRouter = new Hono<{ Variables: Variables }>()
commentsRouter.use('*', requireAuth)

/* ─── GET /api/comments?pageId=X ──────────────────────────────────────
 *
 * Two-step fetch (matches the plan):
 *   1. SELECT top-level comments on this page (paginated, with optional LIMIT).
 *   2. SELECT ALL replies whose parent_id IN topLevelIds (single batched query,
 *      no pagination — total reply volume per page is small in v0).
 *   3. Stitch into the top-level rows as a `replies: Comment[]` field.
 *
 * Note: the response shape is a FLAT ARRAY of top-level comments with embedded
 * replies, NOT PaginatedList. The pagination is applied to the top-level set
 * only. The query string `?limit=&offset=` applies to top-level.
 *
 * We DO NOT use PaginatedList here because the schema is non-uniform (each
 * item carries `replies`). The frontend renders the top-level count + loadMore
 * itself by paging the list.
 */
commentsRouter.get('/', async (c) => {
  const me = c.get('user')

  const pageId = c.req.query('pageId')
  if (!pageId) {
    return c.json({ error: 'invalid_input', message: 'pageId 必填' }, 400)
  }

  const guard = await guardReadPage({ c, me, pageId })
  if (!guard.ok) return guard.response

  // Optional ?limit=&offset= — applied to top-level. Both optional; absent
  // means "return everything" (matches the conservative default for stage 6).
  const limitParam = c.req.query('limit')
  const offsetParam = c.req.query('offset')
  const limit = limitParam ? Math.min(200, Math.max(1, parseInt(limitParam, 10) || 0)) : undefined
  const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0

  // Top-level fetch with author LEFT JOIN.
  const topLevel = await db
    .select({
      id: comments.id,
      pageId: comments.pageId,
      parentId: comments.parentId,
      authorId: comments.authorId,
      contentMd: comments.contentMd,
      contentText: comments.contentText,
      mentionedUserIds: comments.mentionedUserIds,
      isEdited: comments.isEdited,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
      deletedBy: comments.deletedBy,
      authorName: users.name,
      authorColor: users.color,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(and(eq(comments.pageId, pageId), isNull(comments.parentId), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt))
    .limit(limit ?? 1000000)
    .offset(offset)

  const topIds = topLevel.map((r) => r.id)
  if (topIds.length === 0) {
    return c.json({ items: [], hasMore: false, limit: 0, offset: 0 })
  }

  const replyRows = await db
    .select({
      id: comments.id,
      pageId: comments.pageId,
      parentId: comments.parentId,
      authorId: comments.authorId,
      contentMd: comments.contentMd,
      contentText: comments.contentText,
      mentionedUserIds: comments.mentionedUserIds,
      isEdited: comments.isEdited,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
      deletedBy: comments.deletedBy,
      authorName: users.name,
      authorColor: users.color,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(
      and(
        inArray(comments.parentId, topIds),
        isNull(comments.deletedAt),
      ),
    )
    .orderBy(asc(comments.createdAt))

  const repliesByParent = new Map<string, ReturnType<typeof rowToComment>[]>()
  for (const r of replyRows) {
    if (!r.parentId) continue
    const dto = rowToComment(r, { authorName: r.authorName, authorColor: r.authorColor })
    CommentSchema.parse(dto) // boundary validation
    const list = repliesByParent.get(r.parentId) ?? []
    list.push(dto)
    repliesByParent.set(r.parentId, list)
  }

  const items = topLevel.map((r) => ({
    ...rowToComment(r, { authorName: r.authorName, authorColor: r.authorColor }),
    replies: repliesByParent.get(r.id) ?? [],
  }))

  // Boundary validation per item.
  for (const item of items) {
    CommentSchema.parse(item)
  }

  return c.json({
    items,
    limit: limit ?? topLevel.length,
    offset,
    hasMore: limit !== undefined ? topLevel.length === limit : false,
  })
})

/* ─── GET /api/comments/mention-candidates ────────────────────────────
 *
 * Returns the user-id list eligible for `@`-mention on a given page.
 * Hard requirement: limit to users with access to the page's space.
 * Implemented in `lib/mentionCandidates.ts`.
 */
commentsRouter.get('/mention-candidates', async (c) => {
  const me = c.get('user')
  const raw = {
    pageId: c.req.query('pageId'),
    q: c.req.query('q') ?? '',
  }
  const parsed = MentionCandidatesQuerySchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }

  const guard = await guardReadPage({ c, me, pageId: parsed.data.pageId })
  if (!guard.ok) return guard.response

  const candidates = await getMentionCandidates(
    parsed.data.pageId,
    me.id,
    parsed.data.q ?? '',
  )
  return c.json(
    candidates.map((cand) =>
      MentionCandidateSchema.parse({
        id: cand.id,
        name: cand.name,
        color: cand.color,
        email: cand.email,
      }),
    ),
  )
})

/* ─── POST /api/comments ──────────────────────────────────────────────
 *
 * Two notification paths:
 *   - if parentId present → enqueue(kind='reply', target = parent.authorId)
 *   - else (top-level)   → enqueue(kind='comment_on_my_page', target = page.authorId)
 *   - mentionedUserIds (after dedupe vs actor) → enqueue(kind='mention', targets = each id)
 *
 * Mention re-verification: the optional `mentionedUserIds` from the client
 * is validated by re-querying the candidates and intersecting — clients
 * cannot fake mentions for users outside the page's space access set.
 */
commentsRouter.post('/', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateCommentInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  // ── pre-checks ──
  const guard = await guardCreateComment({ c, me, pageId: input.pageId })
  if (!guard.ok) return guard.response
  const page = guard.data.page

  // If this is a reply, the parent comment must exist, be live, and belong
  // to the same page.
  let parentComment: { authorId: string; deletedAt: number | null } | null = null
  if (input.parentId != null) {
    const parentRow = (
      await db
        .select({
          authorId: comments.authorId,
          pageId: comments.pageId,
          deletedAt: comments.deletedAt,
        })
        .from(comments)
        .where(eq(comments.id, input.parentId))
        .limit(1)
    )[0]
    if (!parentRow || parentRow.deletedAt !== null || parentRow.pageId !== input.pageId) {
      return c.json(
        { error: 'invalid_input', message: 'parentId 必须指向同一页的现存活评论' },
        400,
      )
    }
    parentComment = { authorId: parentRow.authorId, deletedAt: parentRow.deletedAt }
  }

  // Re-verify mentions against the live candidate set.
  let mentions: string[] = []
  if (input.mentionedUserIds && input.mentionedUserIds.length > 0) {
    const candidates = await getMentionCandidates(input.pageId, me.id, '', 100)
    const validSet = new Set(candidates.map((c) => c.id))
    // The actor themselves is implicitly not a candidate — but still filter
    // defensively.
    mentions = input.mentionedUserIds.filter(
      (u) => validSet.has(u) && u !== me.id,
    )
  }

  // ── write & fanout in one transaction ──
  const id = generateNewCommentId()
  const now = Date.now()
  const contentText = stripMarkdown(input.contentMd)

  await db.transaction(async (tx) => {
    await tx.insert(comments).values({
      id,
      pageId: input.pageId,
      parentId: input.parentId ?? null,
      authorId: me.id,
      contentMd: input.contentMd,
      contentText,
      mentionedUserIds: mentions,
      isEdited: false,
      createdAt: now,
      updatedAt: now,
    })

    // Fetch the page title once for the notification snapshot.
    const [pageMeta] = await tx
      .select({ title: pages.title })
      .from(pages)
      .where(eq(pages.id, input.pageId))
      .limit(1)
    const pageTitle = pageMeta?.title ?? null

    // Reply notification (target: parent comment's author).
    if (parentComment) {
      await enqueueNotifications(tx, {
        kind: 'reply',
        actor: me,
        pageId: input.pageId,
        pageTitle,
        commentId: id,
        parentAuthorId: parentComment.authorId,
      })
    } else {
      // Top-level comment: notify the page author.
      await enqueueNotifications(tx, {
        kind: 'comment_on_my_page',
        actor: me,
        pageId: input.pageId,
        pageTitle,
        commentId: id,
        pageAuthorId: pageMeta?.title != null ? await getPageAuthorId(tx, input.pageId) : null,
      })
    }

    // Mention notifications (one row per recipient).
    if (mentions.length > 0) {
      await enqueueNotifications(tx, {
        kind: 'mention',
        actor: me,
        pageId: input.pageId,
        pageTitle,
        commentId: id,
        mentionedUserIds: mentions,
      })
    }
  })

  // Re-fetch via row mapper for response (author LEFT JOIN).
  const [row] = await db
    .select({
      id: comments.id,
      pageId: comments.pageId,
      parentId: comments.parentId,
      authorId: comments.authorId,
      contentMd: comments.contentMd,
      contentText: comments.contentText,
      mentionedUserIds: comments.mentionedUserIds,
      isEdited: comments.isEdited,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
      deletedBy: comments.deletedBy,
      authorName: users.name,
      authorColor: users.color,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(eq(comments.id, id))
    .limit(1)

  if (!row) return c.json({ error: 'not_found' }, 404)
  const dto = rowToComment(row, { authorName: row.authorName, authorColor: row.authorColor })
  return c.json(CommentSchema.parse(dto), 201)
})

/* ─── PATCH /api/comments/:id ──────────────────────────────────────── */
commentsRouter.patch('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateCommentInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  const guard = await guardMutateComment({ c, me, commentId: id, op: 'edit' })
  if (!guard.ok) return guard.response

  // If mentionedUserIds is being updated, re-verify against the live candidate set.
  let cleanedMentions: string[] | undefined
  if (input.mentionedUserIds !== undefined) {
    const pageId = guard.data.comment!.pageId
    const candidates = await getMentionCandidates(pageId, me.id, '', 100)
    const validSet = new Set(candidates.map((c) => c.id))
    cleanedMentions = input.mentionedUserIds.filter((u) => validSet.has(u) && u !== me.id)
  }

  const patch: Partial<typeof comments.$inferInsert> = {
    updatedAt: Date.now(),
    isEdited: true,
    editedAt: Date.now(),
  }
  if (input.contentMd !== undefined) {
    patch.contentMd = input.contentMd
    patch.contentText = stripMarkdown(input.contentMd)
  }
  if (cleanedMentions !== undefined) patch.mentionedUserIds = cleanedMentions

  await db.update(comments).set(patch).where(eq(comments.id, id))

  const [row] = await db
    .select({
      id: comments.id,
      pageId: comments.pageId,
      parentId: comments.parentId,
      authorId: comments.authorId,
      contentMd: comments.contentMd,
      contentText: comments.contentText,
      mentionedUserIds: comments.mentionedUserIds,
      isEdited: comments.isEdited,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
      deletedBy: comments.deletedBy,
      authorName: users.name,
      authorColor: users.color,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(eq(comments.id, id))
    .limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(
    CommentSchema.parse(
      rowToComment(row, { authorName: row.authorName, authorColor: row.authorColor }),
    ),
  )
})

/* ─── DELETE /api/comments/:id ───────────────────────────────────────
 *
 * Soft-delete (sets deleted_at + deleted_by). The comment still occupies
 * its row so notifications pointing at it stay valid (UI degrades to a
 * page-level link if the comment is gone). Replies are NOT cascaded.
 */
commentsRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  const guard = await guardMutateComment({ c, me, commentId: id, op: 'delete' })
  if (!guard.ok) return guard.response

  await db
    .update(comments)
    .set({ deletedAt: Date.now(), deletedBy: me.id, updatedAt: Date.now() })
    .where(eq(comments.id, id))
  return c.body(null, 204)
})

/* ─── local helpers ────────────────────────────────────────────────── */

function generateNewCommentId(): string {
  // 10-char ids matching apps/web nanoid(10) / apps/api generatePageId alphabet.
  // We use the stock nanoid alphabet here (different from page ids) — the
  // uniqueness guarantee from 10-char nanoid over 1M rows is fine for comments
  // and notifications. Page ids share a project-specific 31-char alphabet via
  // generatePageId; that constraint doesn't apply here.
  return nanoid(10)
}

type AnyTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
async function getPageAuthorId(tx: AnyTx, pageId: string): Promise<string | null> {
  const [row] = await tx
    .select({ authorId: pages.authorId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  return row?.authorId ?? null
}
