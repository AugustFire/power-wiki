/**
 * Pages API — 9 routes (Stage 5 — soft-delete / trash / restore):
 *
 *   GET    /api/pages                  → PageNode[] (filtered by visible spaces, excludes trashed)
 *   GET    /api/pages/trash?space=     → PageNode[] (admin only, trashed pages in space)
 *   GET    /api/pages/:id              → PageNode (404 if not in visible space, excludes trashed)
 *   POST   /api/pages                  → 201 + PageNode (spaceId required + access check)
 *   PATCH  /api/pages/:id              → PageNode (404 if not in visible space, excludes trashed)
 *   PATCH  /api/pages/:id/move         → PageNode (404 if not in visible space, excludes trashed)
 *   POST   /api/pages/:id/restore      → 204 (admin only, 409 parent_trashed / not_trashed)
 *   DELETE /api/pages/:id              → 204 soft-delete (409 has_children, 404 not accessible)
 *   DELETE /api/pages/:id?purge=true   → 204 hard-delete (admin only, must already be trashed)
 *
 * Space scoping (Stage 4c):
 *   - Admin sees all spaces and all pages.
 *   - Regular user sees pages in spaces they have access to (via group
 *     membership × space_group_access).
 *   - All single-page operations (GET /:id, PATCH, MOVE, DELETE) return 404
 *     for pages in inaccessible spaces — NOT 403. This prevents the API
 *     from leaking which page IDs exist in which spaces.
 *
 * Soft-delete semantics (Stage 5):
 *   - All read paths go through `selectPagesWithAuthor(...)` which adds
 *     `isNull(deletedAt)` by default. Only `/api/pages/trash` opts in via
 *     `includeDeleted: true`.
 *   - `DELETE /:id` flips `deleted_at` on the row itself (no recursion — the
 *     router refuses with 409 `has_children` if non-trashed children exist).
 *   - `POST /:id/restore` clears `deleted_at` on one row; refuses 409 if the
 *     row's `parent_id` points at a still-trashed page (parent must be
 *     restored first).
 *   - `DELETE /:id?purge=true` runs the original recursive hard-delete CTE
 *     for admin cleanup of the trash.
 *
 * Validation: hand-rolled zod safeParse per handler. Hono's zValidator would
 * save boilerplate but adds a dep for ~3 lines saved per route.
 *
 * Errors: 400 zod, 403 admin-only, 404 not found / not accessible, 409
 *         has_children / parent_trashed / not_trashed, 500 internal.
 */

import { Hono } from 'hono'
import { and, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm'
import {
  CreatePageInputSchema,
  PageNodeSchema,
  UpdatePageInputSchema,
  MovePageInputSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { pages, users } from '../db/schema'
import { rowToPageNode } from '../lib/rowToPageNode'
import { generatePageId, isDescendantOrSelf } from '../lib/ids'
import { canAccessSpace, getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { type Variables } from '../auth/middleware'

const PAGE_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // matches apps/web/src/lib/id.ts (10 chars)

export const pagesRouter = new Hono<{ Variables: Variables }>()

/**
 * `pages` + LEFT JOIN `users` for the author's name/color. Used by every
 * handler that returns a page to the client so ReadView can render the
 * creator without a separate user lookup.
 *
 * By default this ALSO filters out trashed rows (`deleted_at IS NULL`) so
 * every existing read path is automatically safe. Pass `includeDeleted: true`
 * to opt out — only the trash listing does this.
 *
 * Pass an optional WHERE clause; undefined = no extra filter beyond the
 * default deletedAt guard.
 */
function selectPagesWithAuthor(
  where?: SQL,
  opts: { includeDeleted?: boolean } = {},
) {
  const q = db
    .select({
      ...getTableColumns(pages),
      authorName: users.name,
      authorColor: users.color,
    })
    .from(pages)
    .leftJoin(users, eq(pages.authorId, users.id))
  const filters: SQL[] = []
  if (!opts.includeDeleted) filters.push(isNull(pages.deletedAt))
  if (where) filters.push(where)
  return filters.length ? q.where(and(...filters)) : q
}

/* ─── GET /api/pages ─────────────────────────────────────────────────────
 *  Optional ?space=<id> scopes the list to a single space. The space must be
 *  visible to the current user, otherwise we 404 (not 403) to avoid leaking
 *  the existence of spaces the user shouldn't see.
 */
pagesRouter.get('/', async (c) => {
  const me = c.get('user')
  const querySpace = c.req.query('space')

  // Build the WHERE clause. For admin, skip the filter entirely.
  if (me.role !== 'admin') {
    const visible = await getAccessibleSpaceIds(me.id, false)
    if (visible === '*' || visible.length === 0) {
      // Shouldn't happen for non-admin, but be defensive.
      return c.json([])
    }

    if (querySpace) {
      // Single-space query — must be in the visible set.
      if (!visible.includes(querySpace)) {
        return c.json({ error: 'not_found' }, 404)
      }
      const rows = await selectPagesWithAuthor(eq(pages.spaceId, querySpace))
      return c.json(rows.map(rowToPageNode))
    }

    const rows = await selectPagesWithAuthor(inArray(pages.spaceId, visible))
    return c.json(rows.map(rowToPageNode))
  }

  // Admin path.
  if (querySpace) {
    const rows = await selectPagesWithAuthor(eq(pages.spaceId, querySpace))
    return c.json(rows.map(rowToPageNode))
  }
  const rows = await selectPagesWithAuthor()
  return c.json(rows.map(rowToPageNode))
})

/* ─── GET /api/pages/trash ─────────────────────────────────────────────
 *  Admin-only. `?space=<id>` is REQUIRED — admins pick a space to inspect.
 *  Returns the trashed pages in that space (deleted_at IS NOT NULL),
 *  ordered by deletion time DESC so the most recent deletion sits on top.
 *
 *  Registered BEFORE GET /:id so Hono's first-match dispatch doesn't route
 *  "/trash" to the dynamic param handler.
 */
pagesRouter.get('/trash', async (c) => {
  if (c.get('user').role !== 'admin') {
    return c.json({ error: 'forbidden', message: '需要管理员权限' }, 403)
  }
  const querySpace = c.req.query('space')
  if (!querySpace) {
    return c.json({ error: 'space_required' }, 400)
  }
  const rows = await selectPagesWithAuthor(
    and(eq(pages.spaceId, querySpace), isNotNull(pages.deletedAt)),
    { includeDeleted: true },
  ).orderBy(sql`${pages.deletedAt} DESC`)
  return c.json(rows.map(rowToPageNode))
})

/* ─── GET /api/pages/:id ──────────────────────────────────────────────
 *  Returns 404 if the page is in a space the current user can't access.
 *  Existence in inaccessible spaces is intentionally indistinguishable from
 *  "page doesn't exist".
 */
pagesRouter.get('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const [row] = await selectPagesWithAuthor(eq(pages.id, id))
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.spaceId === null) return c.json({ error: 'not_found' }, 404)
  if (!(await canAccessSpace(me.id, me.role === 'admin', row.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  return c.json(rowToPageNode(row))
})

/* ─── POST /api/pages ─────────────────────────────────────────────────
 *  spaceId is required by the schema. We additionally verify the user has
 *  access to the target space — for non-admin users this means the page
 *  will actually be visible to them after creation. (Same check is used
 *  for read and write in 4c; finer-grained perms come later if needed.)
 */
pagesRouter.post('/', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreatePageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  if (!(await canAccessSpace(me.id, me.role === 'admin', input.spaceId))) {
    // Hide whether the space exists at all.
    return c.json({ error: 'not_found' }, 404)
  }

  // sortOrder: 显式传入则用,否则追加到末尾。
  let sortOrder = input.order
  if (sortOrder === undefined) {
    const nextOrderResult = await db.execute<{ nextOrder: number }>(sql`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS "nextOrder"
      FROM pages
      WHERE space_id = ${input.spaceId}
        AND ${input.parentId == null ? sql`parent_id IS NULL` : sql`parent_id = ${input.parentId}`}
    `)
    sortOrder = nextOrderResult.rows[0]?.nextOrder ?? 0
  }

  const now = Date.now()
  // Prefer client-supplied id (so optimistic inserts don't need a swap on response).
  const id = input.id ?? generatePageId()
  await db
    .insert(pages)
    .values({
      id,
      parentId: input.parentId ?? null,
      spaceId: input.spaceId,
      title: input.title ?? '',
      icon: input.icon ?? null,
      contentJson: input.contentJSON ?? {},
      contentHtml: input.contentHTML ?? '',
      sortOrder,
      createdAt: now,
      updatedAt: now,
      authorId: me.id,
    })

  // Re-fetch via the LEFT JOIN helper so authorName / authorColor are populated.
  const [row] = await selectPagesWithAuthor(eq(pages.id, id))
  if (!row) return c.json({ error: 'not_found' }, 404)
  const node = rowToPageNode(row)
  // Validate the response shape with the same schema the frontend will use —
  // surfaces drift between Drizzle and PageNode at the boundary, not at runtime.
  return c.json(PageNodeSchema.parse(node), 201)
})

/* ─── PATCH /api/pages/:id ──────────────────────────────────────────── */
pagesRouter.patch('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdatePageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  // Pre-check: page must exist AND be in an accessible space AND not be trashed.
  const existing = (await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const patch: Partial<typeof pages.$inferInsert> = { updatedAt: Date.now() }
  if (input.title !== undefined) patch.title = input.title
  if (input.contentJSON !== undefined) patch.contentJson = input.contentJSON
  if (input.contentHTML !== undefined) patch.contentHtml = input.contentHTML
  if (input.icon !== undefined) patch.icon = input.icon
  if (input.starred !== undefined) patch.starred = input.starred

  await db.update(pages).set(patch).where(eq(pages.id, id))

  const [row] = await selectPagesWithAuthor(eq(pages.id, id))
  if (!row) return c.json({ error: 'not_found' }, 404)

  return c.json(PageNodeSchema.parse(rowToPageNode(row)))
})

/* ─── PATCH /api/pages/:id/move ────────────────────────────────────── */
pagesRouter.patch('/:id/move', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = MovePageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  // Pre-check: target page must be in an accessible space AND not be trashed.
  const existing = (await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // If the new parent is set, it must be in the SAME space as the page being
  // moved (move only re-parents, doesn't cross spaces — cross-space moves
  // would need a separate endpoint).
  if (input.newParentId !== null) {
    const [parent] = await db
      .select({ spaceId: pages.spaceId })
      .from(pages)
      .where(eq(pages.id, input.newParentId))
      .limit(1)
    if (!parent || parent.spaceId !== existing.spaceId) {
      return c.json({ error: 'not_found' }, 404)
    }
  }

  // Cycle protection: can't move into self or a descendant of self.
  if (input.newParentId !== null && (await isDescendantOrSelf(input.newParentId, id))) {
    return c.json({ error: 'cycle' }, 409)
  }

  const targetSpaceId = existing.spaceId
  const targetParentId = input.newParentId
  const insertAt = input.newOrder ?? Number.MAX_SAFE_INTEGER // sentinel: "append"

  // Collect the target parent's current children (excluding self), ordered.
  // This becomes the basis for the new sortOrder sequence after the move.
  const targetSiblings = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, targetSpaceId),
        targetParentId === null
          ? isNull(pages.parentId)
          : eq(pages.parentId, targetParentId),
        ne(pages.id, id),
      ),
    )
    .orderBy(pages.sortOrder)

  const others = targetSiblings.map((s) => s.id)
  const clamped = Math.max(0, Math.min(insertAt, others.length))
  const orderedIds = [...others.slice(0, clamped), id, ...others.slice(clamped)]

  // One transaction: bump self to a temporary sortOrder (so the loop below
  // doesn't fight itself when reparenting within the same parent), then
  // rewrite every sibling in the target list to its new 0-based order.
  await db.transaction(async (tx) => {
    await tx
      .update(pages)
      .set({ parentId: targetParentId, sortOrder: -1, updatedAt: Date.now() })
      .where(eq(pages.id, id))
    orderedIds.forEach((pageId, i) => {
      void tx
        .update(pages)
        .set({ sortOrder: i })
        .where(eq(pages.id, pageId))
    })
  })

  const [row] = await selectPagesWithAuthor(eq(pages.id, id)).limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageNodeSchema.parse(rowToPageNode(row)))
})

/* ─── POST /api/pages/:id/restore ─────────────────────────────────────
 *  Admin-only. Restores a single trashed page by clearing its deleted_at.
 *  Refuses 409 parent_trashed if the page's parent_id points at a still-
 *  trashed row (admin must restore the parent first). Refuses 409
 *  not_trashed if the row isn't in the trash (idempotency: a no-op double
 *  restore shouldn't silently succeed).
 */
pagesRouter.post('/:id/restore', async (c) => {
  if (c.get('user').role !== 'admin') {
    return c.json({ error: 'forbidden', message: '需要管理员权限' }, 403)
  }
  const id = c.req.param('id')

  // Load the row regardless of trash state — we need parent_id and spaceId
  // even on trashed rows to validate the parent chain.
  const existing = (await db.select().from(pages).where(eq(pages.id, id)).limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (existing.deletedAt == null) {
    return c.json({ error: 'not_trashed' }, 409)
  }
  // Parent must exist AND not be trashed (null parent is fine — root).
  if (existing.parentId !== null) {
    const [parent] = await db
      .select({ deletedAt: pages.deletedAt })
      .from(pages)
      .where(eq(pages.id, existing.parentId))
      .limit(1)
    if (!parent || parent.deletedAt !== null) {
      return c.json(
        { error: 'parent_trashed', parentId: existing.parentId },
        409,
      )
    }
  }

  await db
    .update(pages)
    .set({ deletedAt: null, deletedBy: null, updatedAt: Date.now() })
    .where(and(eq(pages.id, id), isNotNull(pages.deletedAt)))

  return c.body(null, 204)
})

/* ─── DELETE /api/pages/:id ───────────────────────────────────────────
 *  Stage 5: soft-delete by default. Hard-delete is admin-only via
 *  `?purge=true` and requires the row to already be trashed.
 *
 *  Soft-delete:
 *    - Refuses 409 has_children if non-trashed children exist (admin/user
 *      must delete children first).
 *    - Single-row UPDATE — no recursion needed because we don't allow
 *      trashing parents.
 *    - Anyone with access to the page's space can soft-delete (matches
 *      pre-Stage 5 DELETE behaviour for permissions).
 *
 *  Purge (admin only):
 *    - Row must already be trashed, else 409 not_trashed.
 *    - Recursive CTE hard-delete of the subtree (handles the case where
 *      descendants were individually trashed earlier).
 */
pagesRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const purge = c.req.query('purge') === 'true'

  if (purge && me.role !== 'admin') {
    return c.json({ error: 'forbidden', message: '需要管理员权限' }, 403)
  }

  // Pre-check: load row regardless of trash state — purge needs to see
  // already-trashed rows. Soft-delete filters them out so we don't
  // double-trash.
  const existing = (await db
    .select({
      spaceId: pages.spaceId,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  if (purge) {
    if (existing.deletedAt == null) {
      return c.json({ error: 'not_trashed' }, 409)
    }
    // Recursive CTE: hard-delete the subtree (admin-only path). The CTE
    // doesn't filter deleted_at because an admin purging a parent may
    // also be purging descendants that were individually trashed.
    const result = await db.execute<{ deleted: number }>(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM pages WHERE id = ${id}
        UNION ALL
        SELECT p.id FROM pages p INNER JOIN subtree s ON p.parent_id = s.id
      )
      DELETE FROM pages WHERE id IN (SELECT id FROM subtree)
    `)
    const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0
    if (deleted === 0) return c.json({ error: 'not_found' }, 404)
    return c.body(null, 204)
  }

  // Soft-delete path. The row must not already be trashed (idempotency).
  if (existing.deletedAt !== null) {
    return c.json({ error: 'not_trashed' }, 409)
  }

  // Count non-trashed children with the same parent_id = this page.
  // Cheap (already covered by `pages_parent_idx`) and avoids any
  // cross-space / recursive CTE.
  const childRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.parentId, id),
        isNull(pages.deletedAt),
      ),
    )
  if (childRows.length > 0) {
    return c.json(
      { error: 'has_children', childCount: childRows.length },
      409,
    )
  }

  await db
    .update(pages)
    .set({ deletedAt: Date.now(), deletedBy: me.id, updatedAt: Date.now() })
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))

  return c.body(null, 204)
})

// Re-export the alphabet for tests / fixtures.
export { PAGE_ID_ALPHABET }