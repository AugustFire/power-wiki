/**
 * Spaces routes (Stage 4c — access-scoped).
 *
 *   GET /api/spaces         list spaces visible to the current user
 *   GET /api/spaces/:id     single space (must be visible to current user)
 *
 * Visibility:
 *   - admin sees every space, with full `accessGroupIds`.
 *   - regular user only sees spaces whose access groups intersect with their
 *     own group memberships (single query: space_group_access × user_group_members).
 *     `accessGroupIds` is omitted from the response — it's admin metadata.
 *
 * Inaccessible spaces are indistinguishable from non-existent ones (404, not 403)
 * to prevent probing the space list.
 */

import { Hono } from 'hono'
import { asc, eq, inArray } from 'drizzle-orm'
import { SpaceSchema } from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { spaceGroupAccess, spaces } from '../db/schema'
import { getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { rowToSpace } from '../lib/rowMappers'
import type { Variables } from '../auth/middleware'

export const spacesRouter = new Hono<{ Variables: Variables }>()

/**
 * Build space list response.
 *  - Admin → all spaces, each with its `accessGroupIds`
 *  - Non-admin → only spaces in `accessible`, no `accessGroupIds`
 */
async function listVisibleSpaces(isAdmin: boolean, accessible: string[] | '*') {
  if (isAdmin) {
    const rows = await db.select().from(spaces).orderBy(asc(spaces.createdAt))
    // Aggregate accessGroupIds in one query to avoid N+1.
    const accessRows = await db
      .select({ spaceId: spaceGroupAccess.spaceId, groupId: spaceGroupAccess.groupId })
      .from(spaceGroupAccess)
    const accessBySpace = new Map<string, string[]>()
    for (const r of accessRows) {
      const list = accessBySpace.get(r.spaceId) ?? []
      list.push(r.groupId)
      accessBySpace.set(r.spaceId, list)
    }
    return rows.map((row) =>
      SpaceSchema.parse({
        ...rowToSpace(row, { includeOwner: true }),
        accessGroupIds: accessBySpace.get(row.id) ?? [],
      }),
    )
  }

  // Non-admin — restrict to accessible. Narrow the union for inArray's typing.
  if (accessible === '*' || accessible.length === 0) return []
  const ids: string[] = accessible
  const rows = await db
    .select()
    .from(spaces)
    .where(inArray(spaces.id, ids))
    .orderBy(asc(spaces.createdAt))
  return rows.map((row) => SpaceSchema.parse(rowToSpace(row, { includeOwner: false })))
}

/* ─── GET /api/spaces ────────────────────────────────────────────────── */
spacesRouter.get('/', async (c) => {
  const me = c.get('user')
  const isAdmin = me.role === 'admin'
  const accessible = await getAccessibleSpaceIds(me.id, isAdmin)
  return c.json(await listVisibleSpaces(isAdmin, accessible))
})

/* ─── GET /api/spaces/:id ────────────────────────────────────────────── */
spacesRouter.get('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const isAdmin = me.role === 'admin'

  if (!isAdmin) {
    const accessible = await getAccessibleSpaceIds(me.id, false)
    if (!accessible.includes(id)) {
      return c.json({ error: 'not_found' }, 404)
    }
  }

  const [row] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)

  // Only include accessGroupIds for admin — it's management metadata.
  if (isAdmin) {
    const accessRows = await db
      .select({ groupId: spaceGroupAccess.groupId })
      .from(spaceGroupAccess)
      .where(eq(spaceGroupAccess.spaceId, id))
    return c.json(
      SpaceSchema.parse({
        ...rowToSpace(row, { includeOwner: true }),
        accessGroupIds: accessRows.map((r) => r.groupId),
      }),
    )
  }

  return c.json(SpaceSchema.parse(rowToSpace(row, { includeOwner: false })))
})
