/**
 * Admin space routes — Stage 4c.
 *
 *   GET    /api/admin/spaces                    list all spaces + accessGroupIds
 *   POST   /api/admin/spaces                    create
 *   GET    /api/admin/spaces/:id                single space + accessGroupIds
 *   PATCH  /api/admin/spaces/:id                update name/description/color/icon
 *   DELETE /api/admin/spaces/:id                delete (refuses if pages exist)
 *   PUT    /api/admin/spaces/:id/access         replace the full set of access groups
 *
 * All routes require admin role. Non-admin users go through /api/spaces
 * (apps/api/src/routes/spaces.ts) which filters by their group memberships.
 *
 * setAccess replaces the full group set in a single transaction (delete +
 * bulk insert). The single-toggle UI uses POST/DELETE on /:id/access/:groupId
 * for optimistic per-group updates; PUT stays for batch ops.
 */
import { Hono } from 'hono'
import { eq, inArray, sql, and } from 'drizzle-orm'
import {
  CreateSpaceInputSchema,
  SetSpaceAccessInputSchema,
  SpaceSchema,
  UpdateSpaceInputSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { pages, spaceGroupAccess, spaces, userGroups } from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import type { Space } from '@power-wiki/shared'
import type { SpaceRow } from '../db/schema'

export const adminSpacesRouter = new Hono<{ Variables: Variables }>()

adminSpacesRouter.use('*', requireAdmin)

/* ─── helpers ─────────────────────────────────────────────────────────── */

function rowToSpace(row: SpaceRow, accessGroupIds: string[] = []): Space {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color,
    icon: row.icon ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accessGroupIds,
  }
}

async function getAccessGroupIds(spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: spaceGroupAccess.groupId })
    .from(spaceGroupAccess)
    .where(eq(spaceGroupAccess.spaceId, spaceId))
  return rows.map((r) => r.groupId)
}

/** Count pages in a space — used by GET single + admin list. */
async function countPagesInSpace(spaceId: string): Promise<number> {
  const result = await db.execute<{ count: number }>(
    sql`SELECT COUNT(*)::int AS count FROM pages WHERE space_id = ${spaceId}`,
  )
  return result.rows[0]?.count ?? 0
}

/* ─── GET /api/admin/spaces ───────────────────────────────────────────── */
adminSpacesRouter.get('/', async (c) => {
  const rows = await db.select().from(spaces)
  // Pull all access mappings in one query to avoid N+1.
  const accessRows = await db
    .select({ spaceId: spaceGroupAccess.spaceId, groupId: spaceGroupAccess.groupId })
    .from(spaceGroupAccess)
  const accessBySpace = new Map<string, string[]>()
  for (const r of accessRows) {
    const list = accessBySpace.get(r.spaceId) ?? []
    list.push(r.groupId)
    accessBySpace.set(r.spaceId, list)
  }
  return c.json(rows.map((r) => rowToSpace(r, accessBySpace.get(r.id) ?? [])))
})

/* ─── POST /api/admin/spaces ──────────────────────────────────────────── */
adminSpacesRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateSpaceInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const id = generatePageId()
  const now = Date.now()
  await db.insert(spaces).values({
    id,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    color: parsed.data.color ?? '#0052CC',
    icon: parsed.data.icon ?? null,
    createdAt: now,
    updatedAt: now,
  })
  const created = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  return c.json(rowToSpace(created), 201)
})

/* ─── GET /api/admin/spaces/:id ───────────────────────────────────────── */
adminSpacesRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]
  if (!row) return c.json({ error: 'not_found' }, 404)
  const accessGroupIds = await getAccessGroupIds(id)
  return c.json(rowToSpace(row, accessGroupIds))
})

/* ─── PATCH /api/admin/spaces/:id ─────────────────────────────────────── */
adminSpacesRouter.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateSpaceInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'invalid_input', message: '至少需要更新一个字段' }, 400)
  }
  const existing = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: Date.now() }
  if (parsed.data.name !== undefined) patch.name = parsed.data.name
  if (parsed.data.description !== undefined) patch.description = parsed.data.description ?? null
  if (parsed.data.color !== undefined) patch.color = parsed.data.color
  if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon ?? null

  await db.update(spaces).set(patch).where(eq(spaces.id, id))
  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  const accessGroupIds = await getAccessGroupIds(id)
  return c.json(rowToSpace(updated, accessGroupIds))
})

/* ─── DELETE /api/admin/spaces/:id ────────────────────────────────────── */
// Refuses if the space has any pages. Cascade delete would silently drop
// the entire subtree, which is the kind of action that should require an
// extra confirmation in the UI rather than be triggered by accident.
adminSpacesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = (await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const pageCount = await countPagesInSpace(id)
  if (pageCount > 0) {
    return c.json(
      {
        error: 'space_not_empty',
        message: `该空间下还有 ${pageCount} 个页面,请先删除或移动这些页面`,
        pageCount,
      },
      409,
    )
  }
  // No FK CASCADE — sweep the access join table explicitly so we don't
  // leave rows pointing at a deleted space.
  await db.transaction(async (tx) => {
    await tx.delete(spaceGroupAccess).where(eq(spaceGroupAccess.spaceId, id))
    await tx.delete(spaces).where(eq(spaces.id, id))
  })
  return c.body(null, 204)
})

/* ─── PUT /api/admin/spaces/:id/access ────────────────────────────────── */
// Replaces the full set of access groups in a single transaction.
adminSpacesRouter.put('/:id/access', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = SetSpaceAccessInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { groupIds } = parsed.data

  const existing = (await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  // Validate all groupIds exist — prevents dangling FKs.
  if (groupIds.length > 0) {
    const found = await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(inArray(userGroups.id, groupIds))
    if (found.length !== groupIds.length) {
      const foundSet = new Set(found.map((r) => r.id))
      const missing = groupIds.filter((g) => !foundSet.has(g))
      return c.json(
        { error: 'invalid_input', message: '用户组不存在', missingGroupIds: missing },
        400,
      )
    }
  }

  // Replace in two statements: delete old, insert new. Wrap in a transaction
  // so a partial failure doesn't leave the space with empty access.
  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx.delete(spaceGroupAccess).where(eq(spaceGroupAccess.spaceId, id))
    if (groupIds.length > 0) {
      await tx.insert(spaceGroupAccess).values(
        groupIds.map((groupId) => ({ spaceId: id, groupId, grantedAt: now })),
      )
    }
    await tx.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, id))
  })

  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  return c.json(rowToSpace(updated, groupIds))
})

/* ─── POST /api/admin/spaces/:id/access/:groupId ──────────────────────── */
// Grants a single group access to the space. Idempotent — re-adding an
// already-authorized group is a no-op (returns 200, not 409) so the frontend
// can fire-and-forget without tracking prior state.
adminSpacesRouter.post('/:id/access/:groupId', async (c) => {
  const id = c.req.param('id')
  const groupId = c.req.param('groupId')

  const [space] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, id))
    .limit(1)
  if (!space) return c.json({ error: 'not_found' }, 404)

  const [group] = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(eq(userGroups.id, groupId))
    .limit(1)
  if (!group) {
    return c.json({ error: 'invalid_input', message: '用户组不存在' }, 400)
  }

  const now = Date.now()
  // ON CONFLICT DO NOTHING keeps this idempotent — the frontend doesn't have
  // to track prior membership, and a stale tab clicking again is harmless.
  await db
    .insert(spaceGroupAccess)
    .values({ spaceId: id, groupId, grantedAt: now })
    .onConflictDoNothing()
  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, id))

  const accessGroupIds = await getAccessGroupIds(id)
  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  return c.json(rowToSpace(updated, accessGroupIds))
})

/* ─── DELETE /api/admin/spaces/:id/access/:groupId ───────────────────── */
// Revokes a single group's access. Idempotent — removing an already-unauthorized
// group returns 200 with the current set, not 404.
adminSpacesRouter.delete('/:id/access/:groupId', async (c) => {
  const id = c.req.param('id')
  const groupId = c.req.param('groupId')

  const [space] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, id))
    .limit(1)
  if (!space) return c.json({ error: 'not_found' }, 404)

  const now = Date.now()
  await db
    .delete(spaceGroupAccess)
    .where(
      and(eq(spaceGroupAccess.spaceId, id), eq(spaceGroupAccess.groupId, groupId)),
    )
  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, id))

  const accessGroupIds = await getAccessGroupIds(id)
  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  return c.json(rowToSpace(updated, accessGroupIds))
})

// Re-export for tests / introspection.
export { countPagesInSpace, getAccessGroupIds }
