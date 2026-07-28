/**
 * Comment write-path guards (Stage 6).
 *
 * Why a centralized guard:
 *   - comment POST / PATCH / DELETE / undelete(?) all touch the SAME
 *     composite permission predicate (page visibility + admin-on-personal).
 *     Three handlers re-implementing the same predicate is a leak surface
 *     — a forgotten `assertAdminNotWritingPersonalSpace` somewhere would
 *     silently let admin edit a personal-space page.
 *   - This file is the single source of truth. Every write handler calls
 *     one of these helpers at the top, before doing any side-effect.
 *
 * Visibility policy matches pages.ts:
 *   - Inaccessible page → 404 (NEVER 403, to avoid leaking which page ids
 *     exist in which spaces).
 *   - Admin writing a personal-space page → 403 `personal_space_readonly`
 *     (Consistent with pages POST / PATCH / move / DELETE-soft).
 *   - Disabled user / soft-deleted page → 404.
 */
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { comments, pages, spaces } from '../db/schema'
import {
  canEditPage,
  canReadPage,
  principalFromUser,
} from './permissions'
import { assertCanWriteToPersonalSpace } from './personalSpaceGuard'
import type { AuthenticatedUser } from '../auth/session'

export interface GuardResult {
  /** The page the comment hangs off — useful in POST to skip a re-fetch. */
  page: {
    id: string
    spaceId: string | null
    deletedAt: number | null
    spaceKind: 'personal' | 'shared' | null
    spaceOwnerId: string | null
  }
  /** The loaded comment row, if `commentId` was provided. */
  comment?: { id: string; pageId: string; authorId: string; deletedAt: number | null }
}

export type GuardOutcome =
  | { ok: true; data: GuardResult }
  | { ok: false; response: Response }

interface BaseArgs {
  c: Context
  me: AuthenticatedUser
}

interface PostArgs extends BaseArgs {
  pageId: string
}

/**
 * Guard for POST /api/comments:
 *   - page must exist + not be soft-deleted
 *   - page.spaceId must be writable (Phase A.5: canEditPage 替代 canReadPage;
 *     viewer 不能发评论;author 自身可发)
 *   - admin → must not be writing a personal space (矩阵:全局 admin 不能写
 *     personal space 内容,即便 own;见 lib/personalSpaceGuard.ts 头注释)
 */
export async function guardCreateComment(args: PostArgs): Promise<GuardOutcome> {
  const { c, me, pageId } = args
  const page = await loadPageRow(pageId)
  if (!page || page.deletedAt !== null || page.spaceId === null) {
    return notFound(c)
  }
  const writable = await canEditPage(
    principalFromUser(me),
    page.id,
    page.spaceId,
    page.authorId,
  )
  if (!writable) return notFound(c)
  const blocked = await assertCanWriteToPersonalSpace(
    c,
    me,
    page.spaceKind,
    page.spaceOwnerId,
  )
  if (blocked) return { ok: false, response: blocked }
  return { ok: true, data: { page } }
}

interface MutateArgs extends BaseArgs {
  commentId: string
  /** Required write op — `'delete'` lets admin delete someone else's comment;
   *  `'edit'` is author-only (admin cannot edit others' comments — matches
   *  Confluence / Notion / 飞书 default). */
  op: 'edit' | 'delete'
}

/**
 * Guard for PATCH / DELETE on existing comments.
 *
 *   - comment must exist + not be soft-deleted (for edit; delete can hit a
 *     already-trashed row idempotently — caller decides)
 *   - the page must still be accessible
 *   - admin-on-personal guard still applies (we don't allow admin to edit
 *     a personal-space comment even if they're listed on the personal group
 *     as a collaborator)
 *   - caller must satisfy author-or-admin for the requested op
 */
export async function guardMutateComment(args: MutateArgs): Promise<GuardOutcome> {
  const { c, me, commentId, op } = args
  const row = (
    await db
      .select({
        id: comments.id,
        pageId: comments.pageId,
        authorId: comments.authorId,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1)
  )[0]
  if (!row) return notFound(c)
  // Editing a soft-deleted comment is meaningless — refuse (caller checks
  // for 409 / treats as not-found-equivalent). Deletion of already-deleted
  // is idempotent (no-op success) — we let the caller decide policy.

  const page = await loadPageRow(row.pageId)
  if (!page || page.spaceId === null) return notFound(c)

  const accessible = await canReadPage(principalFromUser(me), page.id, page.spaceId)
  if (!accessible) return notFound(c)

  const blocked = await assertCanWriteToPersonalSpace(
    c,
    me,
    page.spaceKind,
    page.spaceOwnerId,
  )
  if (blocked) return { ok: false, response: blocked }

  if (op === 'edit' && row.deletedAt !== null) return notFound(c)

  // Per-op authorization (post-visibility):
  //   - edit   : author only. Admin cannot edit others' comments (Confluence /
  //              Notion / 飞书 default; edits rewrite content history which is
  //              harder to audit than deletes).
  //   - delete : author or admin. Admin is allowed to delete comments on
  //              non-personal pages, but admin on a personal-space page is
  //              rejected above before this check.
  const isAdmin = me.role === 'admin'
  const isAuthor = row.authorId === me.id
  if (op === 'edit' && !isAuthor) {
    return {
      ok: false,
      response: c.json({ error: 'forbidden', message: '只有评论作者本人可以编辑' }, 403),
    }
  }
  if (op === 'delete' && !isAdmin && !isAuthor) {
    return {
      ok: false,
      response: c.json({ error: 'forbidden', message: '只有评论作者本人或管理员可以删除' }, 403),
    }
  }

  return {
    ok: true,
    data: { page, comment: row },
  }
}

interface ListArgs extends BaseArgs {
  pageId: string
}

/**
 * Guard for GET /api/comments?pageId=X and GET mention-candidates.
 *
 *   - page must exist + not be soft-deleted
 *   - space must be accessible
 *
 * Admin-on-personal is NOT applied here (read-only access is fine).
 */
export async function guardReadPage(args: ListArgs): Promise<GuardOutcome> {
  const { c, me, pageId } = args
  const page = await loadPageRow(pageId)
  if (!page || page.deletedAt !== null || page.spaceId === null) {
    return notFound(c)
  }
  const accessible = await canReadPage(principalFromUser(me), page.id, page.spaceId)
  if (!accessible) return notFound(c)
  return { ok: true, data: { page } }
}

/* ── helpers ────────────────────────────────────────────────────── */

/**
 * 加载 page 元数据 + 所在 space 的 kind / ownerId(为 assertCanWriteToPersonalSpace
 * 提供矩阵所需参数)。一次 JOIN 拿全,避免 canEditPage 之外再多一次 SELECT。
 */
async function loadPageRow(pageId: string) {
  const rows = await db
    .select({
      id: pages.id,
      spaceId: pages.spaceId,
      deletedAt: pages.deletedAt,
      authorId: pages.authorId,
      spaceKind: spaces.kind,
      spaceOwnerId: spaces.ownerId,
    })
    .from(pages)
    .leftJoin(spaces, eq(spaces.id, pages.spaceId))
    .where(eq(pages.id, pageId))
    .limit(1)
  const r = rows[0]
  if (!r) return undefined
  return {
    id: r.id,
    spaceId: r.spaceId,
    deletedAt: r.deletedAt,
    authorId: r.authorId,
    spaceKind: r.spaceKind ?? null,
    spaceOwnerId: r.spaceOwnerId ?? null,
  }
}

function notFound(c: Context): { ok: false; response: Response } {
  return { ok: false, response: c.json({ error: 'not_found' }, 404) }
}
