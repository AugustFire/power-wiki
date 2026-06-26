/**
 * Pages API — 6 routes (Stage 4c — space-scoped):
 *
 *   GET    /api/pages              → PageNode[] (filtered by visible spaces)
 *   GET    /api/pages/:id          → PageNode (404 if not in visible space)
 *   POST   /api/pages              → 201 + PageNode (spaceId required + access check)
 *   PATCH  /api/pages/:id          → PageNode (404 if not in visible space)
 *   PATCH  /api/pages/:id/move     → PageNode (404 if not in visible space)
 *   DELETE /api/pages/:id          → 204 (404 if not in visible space)
 *
 * Space scoping (Stage 4c):
 *   - Admin sees all spaces and all pages.
 *   - Regular user sees pages in spaces they have access to (via group
 *     membership × space_group_access).
 *   - All single-page operations (GET /:id, PATCH, MOVE, DELETE) return 404
 *     for pages in inaccessible spaces — NOT 403. This prevents the API
 *     from leaking which page IDs exist in which spaces.
 *
 *   - The GET list supports `?space=<id>` to scope to a single space, again
 *     404'ing if the user can't access that space.
 *
 * Validation: hand-rolled zod safeParse per handler. Hono's zValidator would
 * save boilerplate but adds a dep for ~3 lines saved per route.
 *
 * Errors: 400 zod, 404 not found / not accessible, 409 move cycle, 500 internal.
 */

import { Hono } from 'hono'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  CreatePageInputSchema,
  PageNodeSchema,
  UpdatePageInputSchema,
  MovePageInputSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { pages } from '../db/schema'
import { rowToPageNode } from '../lib/rowToPageNode'
import { generatePageId, isDescendantOrSelf } from '../lib/ids'
import { canAccessSpace, getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { type Variables } from '../auth/middleware'

const PAGE_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // matches apps/web/src/lib/id.ts (10 chars)

export const pagesRouter = new Hono<{ Variables: Variables }>()

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
      const rows = await db.select().from(pages).where(eq(pages.spaceId, querySpace))
      return c.json(rows.map(rowToPageNode))
    }

    const rows = await db
      .select()
      .from(pages)
      .where(inArray(pages.spaceId, visible))
    return c.json(rows.map(rowToPageNode))
  }

  // Admin path.
  if (querySpace) {
    const rows = await db.select().from(pages).where(eq(pages.spaceId, querySpace))
    return c.json(rows.map(rowToPageNode))
  }
  const rows = await db.select().from(pages)
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
  const [row] = await db.select().from(pages).where(eq(pages.id, id))
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
  const [row] = await db
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
    })
    .returning()

  const node = rowToPageNode(row!)
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

  // Pre-check: page must exist AND be in an accessible space.
  const existing = (await db.select().from(pages).where(eq(pages.id, id)).limit(1))[0]
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

  const [row] = await db.update(pages).set(patch).where(eq(pages.id, id)).returning()
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

  // Pre-check: target page must be in an accessible space.
  const existing = (await db.select().from(pages).where(eq(pages.id, id)).limit(1))[0]
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

  // Default newOrder = append to end of target siblings.
  let newOrder = input.newOrder
  if (newOrder === undefined) {
    const nextOrderResult = await db.execute<{ nextOrder: number }>(sql`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS "nextOrder"
      FROM pages
      WHERE space_id = ${existing.spaceId}
        AND ${input.newParentId == null ? sql`parent_id IS NULL` : sql`parent_id = ${input.newParentId}`}
        AND id <> ${id}
    `)
    newOrder = nextOrderResult.rows[0]?.nextOrder ?? 0
  }

  const [row] = await db
    .update(pages)
    .set({ parentId: input.newParentId, sortOrder: newOrder, updatedAt: Date.now() })
    .where(eq(pages.id, id))
    .returning()

  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageNodeSchema.parse(rowToPageNode(row)))
})

/* ─── DELETE /api/pages/:id ─────────────────────────────────────────── */
// We don't use FK ON DELETE CASCADE (see schema.ts header), so descendants
// are removed explicitly with a recursive CTE — one statement, all the way
// down the subtree. Same cost as the old cascade, just owned by app code.
pagesRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  // Pre-check accessibility — same 404 pattern as the other routes.
  const existing = (await db
    .select({ spaceId: pages.spaceId })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Recursive CTE: collect ids in the subtree rooted at `id`, then DELETE
  // them all. Running in one statement so the visibility window is tight.
  const result = await db.execute<{ deleted: number }>(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM pages WHERE id = ${id}
      UNION ALL
      SELECT p.id FROM pages p INNER JOIN subtree s ON p.parent_id = s.id
    )
    DELETE FROM pages WHERE id IN (SELECT id FROM subtree)
  `)
  // pg node-postgres returns rowCount on result, not in row rows; cast accordingly.
  const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0
  if (deleted === 0) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

// Re-export the alphabet for tests / fixtures.
export { PAGE_ID_ALPHABET }