/**
 * Admin group routes — Stage 4b (refined in 4d — no FK CASCADE).
 *
 *   GET    /api/admin/groups              list groups (no memberIds — UI shows count)
 *   POST   /api/admin/groups              create group
 *   GET    /api/admin/groups/:id          single group WITH memberIds array
 *   PATCH  /api/admin/groups/:id          update name/description
 *   DELETE /api/admin/groups/:id          delete group (sweeps members + access)
 *   POST   /api/admin/groups/:id/members           body {userId}; idempotent
 *   DELETE /api/admin/groups/:id/members/:userId   idempotent (404 only if group missing)
 *
 * All routes require admin role. Members are managed via the separate
 * /members sub-resource — the group body itself never carries memberIds in
 * PATCH. Use addMember / removeMember instead.
 */
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import {
  CreateGroupInputSchema,
  UpdateGroupInputSchema,
  UserGroupSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { spaceGroupAccess, userGroupMembers, userGroups, users } from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import type { UserGroup } from '@power-wiki/shared'
import type { UserGroupRow as DbUserGroupRow } from '../db/schema'

export const adminGroupsRouter = new Hono<{ Variables: Variables }>()

adminGroupsRouter.use('*', requireAdmin)

/* ─── Row mappers ───────────────────────────────────────────────────── */

/** DB row → API DTO (without memberIds; used by list endpoint). */
function rowToGroup(row: DbUserGroupRow): UserGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
  }
}

/** DB row + memberIds → API DTO (used by get endpoint). */
function rowToGroupWithMembers(row: DbUserGroupRow, memberIds: string[]): UserGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
    memberIds,
  }
}

/* ─── Routes ────────────────────────────────────────────────────────── */

// GET /api/admin/groups — list all groups (memberIds omitted for compactness)
adminGroupsRouter.get('/', async (c) => {
  const rows = await db.select().from(userGroups)
  return c.json(rows.map((r) => UserGroupSchema.parse(rowToGroup(r))))
})

// POST /api/admin/groups — create
adminGroupsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateGroupInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const id = generatePageId()
  const now = Date.now()
  await db.insert(userGroups).values({
    id,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    createdAt: now,
  })
  const created = (await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1))[0]!
  return c.json(UserGroupSchema.parse(rowToGroup(created)), 201)
})

// GET /api/admin/groups/:id — single group with members
adminGroupsRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = (await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1))[0]
  if (!row) return c.json({ error: 'not_found' }, 404)
  const memberRows = await db
    .select({ userId: userGroupMembers.userId })
    .from(userGroupMembers)
    .where(eq(userGroupMembers.groupId, id))
  return c.json(
    UserGroupSchema.parse(rowToGroupWithMembers(row, memberRows.map((m) => m.userId))),
  )
})

// PATCH /api/admin/groups/:id — update name/description
adminGroupsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateGroupInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'invalid_input', message: '至少需要更新一个字段' }, 400)
  }
  const existing = (await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)
  await db
    .update(userGroups)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description ?? null }
        : {}),
    })
    .where(eq(userGroups.id, id))
  const updated = (await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1))[0]!
  return c.json(UserGroupSchema.parse(rowToGroup(updated)))
})

// DELETE /api/admin/groups/:id
adminGroupsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = (await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)
  // No FK CASCADE in the schema — sweep the join tables explicitly inside a
  // transaction so we never leave dangling rows pointing at a deleted group.
  await db.transaction(async (tx) => {
    await tx.delete(userGroupMembers).where(eq(userGroupMembers.groupId, id))
    await tx.delete(spaceGroupAccess).where(eq(spaceGroupAccess.groupId, id))
    await tx.delete(userGroups).where(eq(userGroups.id, id))
  })
  return c.body(null, 204)
})

// POST /api/admin/groups/:id/members — add member
adminGroupsRouter.post('/:id/members', async (c) => {
  const groupId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const userId = typeof body?.userId === 'string' ? body.userId : null
  if (!userId) {
    return c.json({ error: 'invalid_input', message: 'userId 必填' }, 400)
  }

  const group = (await db.select().from(userGroups).where(eq(userGroups.id, groupId)).limit(1))[0]
  if (!group) return c.json({ error: 'not_found' }, 404)

  const user = (await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!user) return c.json({ error: 'not_found', message: '用户不存在' }, 404)

  // Idempotent: ON CONFLICT DO NOTHING absorbs duplicate adds.
  await db
    .insert(userGroupMembers)
    .values({ groupId, userId, addedAt: Date.now() })
    .onConflictDoNothing()

  // Return the updated group (with memberIds) so the UI can refresh in one round-trip.
  const memberRows = await db
    .select({ userId: userGroupMembers.userId })
    .from(userGroupMembers)
    .where(eq(userGroupMembers.groupId, groupId))
  return c.json(
    UserGroupSchema.parse(
      rowToGroupWithMembers(group, memberRows.map((m) => m.userId)),
    ),
  )
})

// DELETE /api/admin/groups/:id/members/:userId
adminGroupsRouter.delete('/:id/members/:userId', async (c) => {
  const groupId = c.req.param('id')
  const userId = c.req.param('userId')
  const group = (await db.select({ id: userGroups.id }).from(userGroups).where(eq(userGroups.id, groupId)).limit(1))[0]
  if (!group) return c.json({ error: 'not_found' }, 404)
  // Drizzle's chained .where() doesn't compose (the second call overwrites the first),
  // so use and() to combine both conditions.
  await db
    .delete(userGroupMembers)
    .where(and(eq(userGroupMembers.groupId, groupId), eq(userGroupMembers.userId, userId)))
  return c.body(null, 204)
})
