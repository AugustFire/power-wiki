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
import { PaginatedListSchema, SpaceSchema } from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { spaceGroupAccess, spaces } from '../db/schema'
import { getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { rowToSpace } from '../lib/rowMappers'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { getSpacePageStats, getSpaceOwnerNames, type SpacePageStats } from '../lib/spaceStats'
import type { Variables } from '../auth/middleware'

export const spacesRouter = new Hono<{ Variables: Variables }>()

/**
 * Build space list response.
 *  - Admin → all spaces, each with its `accessGroupIds`
 *  - Non-admin → only spaces in `accessible`, no `accessGroupIds`
 *
 * `limit` undefined = 全量(向后兼容 stores);否则取前 limit+1 行用于
 * hasMore 探测,accessRows 仍然一次性拉全(只为聚合 accessGroupIds),
 * 因为单次 admin list 的总 space 数本身就在可接受量级。
 */
async function listVisibleSpaces(
  isAdmin: boolean,
  accessible: string[] | '*',
  limit?: number,
  offset = 0,
) {
  if (isAdmin) {
    let q = db.select().from(spaces).orderBy(asc(spaces.createdAt)).$dynamic()
    if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
    const rows = await q
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
    // Per-space page stats in one GROUP BY — replaces N frontend pages.list
    // calls when the manager UI renders space cards.
    const statsBySpace = await getSpacePageStats(rows.map((r) => r.id))
    // Owner names for personal spaces — admin path only. Non-admin never
    // sees other users' personal space names (info leak protection).
    const ownerNameBySpace = await getSpaceOwnerNames(rows.map((r) => r.id))
    return rows.map((row) => {
      const ownerName = ownerNameBySpace.get(row.id)
      return SpaceSchema.parse({
        ...rowToSpace(row, { includeOwner: true }),
        accessGroupIds: accessBySpace.get(row.id) ?? [],
        ...statsToDto(statsBySpace.get(row.id)),
        ...(ownerName ? { ownerName } : {}),
      })
    })
  }

  // Non-admin — restrict to accessible. Narrow the union for inArray's typing.
  if (accessible === '*' || accessible.length === 0) return []
  const ids: string[] = accessible
  let q = db
    .select()
    .from(spaces)
    .where(inArray(spaces.id, ids))
    .orderBy(asc(spaces.createdAt))
    .$dynamic()
  if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
  const rows = await q
  // Non-admin: also include stats so any client building a list view from this
  // payload (e.g. spaces store consumers) doesn't need extra round-trips.
  const statsBySpace = await getSpacePageStats(rows.map((r) => r.id))
  return rows.map((row) =>
    SpaceSchema.parse({
      ...rowToSpace(row, { includeOwner: false }),
      ...statsToDto(statsBySpace.get(row.id)),
    }),
  )
}

/**
 * Map an aggregate row onto the 3 new optional DTO fields. Spaces with no pages
 * are simply absent from the stats map → defaults to 0/null.
 */
function statsToDto(stats: SpacePageStats | undefined) {
  return {
    pageCount: stats?.pageCount ?? 0,
    childPageCount: stats?.childPageCount ?? 0,
    lastPageUpdatedAt: stats?.lastPageUpdatedAt ?? null,
  }
}

/* ─── GET /api/spaces ────────────────────────────────────────────────── */
spacesRouter.get('/', async (c) => {
  const me = c.get('user')
  const isAdmin = me.role === 'admin'
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args
  const accessible = await getAccessibleSpaceIds(me.id, isAdmin)
  const items = await listVisibleSpaces(isAdmin, accessible, limit, offset)
  const result = applyPagination(items, limit, offset)
  return c.json(PaginatedListSchema(SpaceSchema).parse(result))
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
    const statsBySpace = await getSpacePageStats([id])
    const ownerNameBySpace = await getSpaceOwnerNames([id])
    const ownerName = ownerNameBySpace.get(id)
    return c.json(
      SpaceSchema.parse({
        ...rowToSpace(row, { includeOwner: true }),
        accessGroupIds: accessRows.map((r) => r.groupId),
        ...statsToDto(statsBySpace.get(id)),
        ...(ownerName ? { ownerName } : {}),
      }),
    )
  }

  const statsBySpace = await getSpacePageStats([id])
  return c.json(
    SpaceSchema.parse({
      ...rowToSpace(row, { includeOwner: false }),
      ...statsToDto(statsBySpace.get(id)),
    }),
  )
})
