/**
 * Admin group routes — Stage 4b (refined in 4d — no FK CASCADE).
 *
 *   GET    /api/admin/groups              list groups (no memberIds — UI shows count)
 *   POST   /api/admin/groups              create group
 *   GET    /api/admin/groups/:id          single group WITH memberIds array
 *   PATCH  /api/admin/groups/:id          update name/description
 *   DELETE /api/admin/groups/:id          delete group (sweeps members + access +
 *                                              page restrictions; audit row written)
 *   POST   /api/admin/groups/:id/members           body {userId}; idempotent
 *   DELETE /api/admin/groups/:id/members/:userId   idempotent (404 only if group missing)
 *
 * All routes require admin role. Members are managed via the separate
 * /members sub-resource — the group body itself never carries memberIds in
 * PATCH. Use addMember / removeMember instead.
 *
 * `pg-*` prefix is reserved for the personal-group auto-created by
 * ensurePersonalSpace() (one per user, gives that user access to their own
 * personal space). These are system artifacts — every endpoint below
 * either filters them out of list responses or 404s on direct access, so
 * admin never sees or edits them through /manager/groups. The 1-person
 * group + space_group_access row keep working underneath; we just hide
 * the row from the admin UI.
 *
 * DELETE sweeps (all in one transaction):
 *   - user_group_members: user → group membership
 *   - space_group_access (legacy): group → space grant
 *   - space_role_grants where principal_kind='group': group → space grant (Phase A)
 *   - page_restrictions where principal_kind='group': page-level view/edit allow-list
 *     (sweeping this relaxes the affected pages' restrictions — expected behavior,
 *     documented in the UI confirm dialog)
 *   - permission_audit row: 'group_deleted' in same tx (rolls back together)
 */
import { Hono } from 'hono'
import { and, eq, not, like, sql } from 'drizzle-orm'
import {
  CreateGroupInputSchema,
  PaginatedListSchema,
  UpdateGroupInputSchema,
  UserGroupSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import {
  pageRestrictions,
  spaceGroupAccess,
  spaceRoleGrants,
  userGroupMembers,
  userGroups,
  users,
} from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { recordPermissionAudit } from '../lib/auditLog'
import type { UserGroup } from '@power-wiki/shared'
import type { UserGroupRow as DbUserGroupRow } from '../db/schema'

export const adminGroupsRouter = new Hono<{ Variables: Variables }>()

adminGroupsRouter.use('*', requireAdmin)

/** True if the id is the auto-created personal-group for some user. */
function isPersonalGroupId(id: string): boolean {
  return id.startsWith('pg-')
}

/* ─── Row mappers ───────────────────────────────────────────────────── */

/** DB row → API DTO (without memberIds; used by list endpoint).
 *  Pass `memberCount` from the LEFT JOIN aggregate. */
function rowToGroup(row: DbUserGroupRow, memberCount: number): UserGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
    memberCount,
  }
}

/** DB row + memberIds → API DTO (used by get endpoint).
 *  memberCount mirrors memberIds.length — gives the UI a number without
 *  re-deriving it client-side. */
function rowToGroupWithMembers(row: DbUserGroupRow, memberIds: string[]): UserGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
    memberCount: memberIds.length,
    memberIds,
  }
}

/* ─── Routes ────────────────────────────────────────────────────────── */

// GET /api/admin/groups — list all groups (memberIds omitted for compactness).
// `pg-*` rows (the auto-created per-user groups for personal-space access)
// are filtered out — they're system artifacts, not admin-managed groups.
// memberCount comes from a single LEFT JOIN + GROUP BY (no N+1).
adminGroupsRouter.get('/', async (c) => {
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args
  let q = db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      description: userGroups.description,
      createdAt: userGroups.createdAt,
      memberCount: sql<number>`COUNT(${userGroupMembers.userId})::int`,
    })
    .from(userGroups)
    .leftJoin(userGroupMembers, eq(userGroupMembers.groupId, userGroups.id))
    .where(not(like(userGroups.id, 'pg-%')))
    .groupBy(userGroups.id)
    .$dynamic()
  if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
  const rows = await q
  const items = rows.map((r) =>
    UserGroupSchema.parse(
      rowToGroup(
        r as Pick<DbUserGroupRow, 'id' | 'name' | 'description' | 'createdAt'>,
        r.memberCount,
      ),
    ),
  )
  const result = applyPagination(items, limit, offset)
  return c.json(PaginatedListSchema(UserGroupSchema).parse(result))
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
  return c.json(UserGroupSchema.parse(rowToGroup(created, 0)), 201)
})

// GET /api/admin/groups/:id — single group with members. `pg-*` ids 404.
adminGroupsRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (isPersonalGroupId(id)) return c.json({ error: 'not_found' }, 404)
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

// PATCH /api/admin/groups/:id — update name/description. `pg-*` ids 404.
adminGroupsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (isPersonalGroupId(id)) return c.json({ error: 'not_found' }, 404)
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
  return c.json(UserGroupSchema.parse(rowToGroup(updated, 0)))
})

// DELETE /api/admin/groups/:id — refuses to delete personal groups (system
// artifact; the owning user's personal space depends on this row, deleting
// it would silently lock them out of their personal space). Sweeps all
// references in one transaction: members, both grant tables (legacy +
// Phase A), and Phase B page-level restrictions.
adminGroupsRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  if (isPersonalGroupId(id)) return c.json({ error: 'not_found' }, 404)
  const existing = (await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)
  // No FK CASCADE in the schema — sweep the join tables explicitly inside a
  // transaction so we never leave dangling rows pointing at a deleted group.
  await db.transaction(async (tx) => {
    await tx.delete(userGroupMembers).where(eq(userGroupMembers.groupId, id))
    await tx.delete(spaceGroupAccess).where(eq(spaceGroupAccess.groupId, id))
    await tx
      .delete(spaceRoleGrants)
      .where(
        and(
          eq(spaceRoleGrants.principalKind, 'group'),
          eq(spaceRoleGrants.principalId, id),
        ),
      )
    // Phase B: page-level restrictions also reference this group as a
    // principal. Sweeping these relaxes the affected pages' view/edit
    // allow-lists (any user no longer covered by an allow-list loses
    // access — same semantic as manually removing the group from the
    // restrictions UI). The UI confirm dialog previews the affected count
    // so admins know what they're about to relax.
    await tx
      .delete(pageRestrictions)
      .where(
        and(
          eq(pageRestrictions.principalKind, 'group'),
          eq(pageRestrictions.principalId, id),
        ),
      )
    await tx.delete(userGroups).where(eq(userGroups.id, id))
    // Audit row written inside the same transaction — rolls back together
    // with the deletes if any sweep fails (Phase C invariant).
    await recordPermissionAudit(tx, {
      kind: 'group_deleted',
      actorId: me.id,
      targetKind: 'group',
      targetId: id,
      payload: { before: { id, name: existing.name } },
    })
  })
  return c.body(null, 204)
})

// GET /api/admin/groups/:id/impact — dry-run counts for the delete confirmation
// dialog. Returns how many rows the cascading delete would touch, so the UI can
// show concrete numbers ("会删除 X 个成员、Y 个空间授权、Z 个页面限制")
// instead of a generic "members will be removed". `pg-*` ids 404.
adminGroupsRouter.get('/:id/impact', async (c) => {
  const id = c.req.param('id')
  if (isPersonalGroupId(id)) return c.json({ error: 'not_found' }, 404)
  const existing = (await db.select({ id: userGroups.id }).from(userGroups).where(eq(userGroups.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)
  // Four count queries, all by-index PK lookups — cheap. Run sequentially
  // since each is a small point query and parallelizing via Promise.all
  // doesn't save meaningful round-trips on a single Postgres connection.
  // `rows[0] ?? { count: 0 }` defends against the (impossible-but-typed)
  // empty-rows case — COUNT(*) always returns exactly one row.
  const memberCount =
    (await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(userGroupMembers)
      .where(eq(userGroupMembers.groupId, id)))[0]?.count ?? 0
  const legacyGrantCount =
    (await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(spaceGroupAccess)
      .where(eq(spaceGroupAccess.groupId, id)))[0]?.count ?? 0
  const roleGrantCount =
    (await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(spaceRoleGrants)
      .where(
        and(
          eq(spaceRoleGrants.principalKind, 'group'),
          eq(spaceRoleGrants.principalId, id),
        ),
      ))[0]?.count ?? 0
  const restrictionCount =
    (await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(pageRestrictions)
      .where(
        and(
          eq(pageRestrictions.principalKind, 'group'),
          eq(pageRestrictions.principalId, id),
        ),
      ))[0]?.count ?? 0
  return c.json({ memberCount, legacyGrantCount, roleGrantCount, restrictionCount })
})

// POST /api/admin/groups/:id/members — add member. `pg-*` groupId 404.
adminGroupsRouter.post('/:id/members', async (c) => {
  const groupId = c.req.param('id')
  if (isPersonalGroupId(groupId)) return c.json({ error: 'not_found' }, 404)
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

// DELETE /api/admin/groups/:id/members/:userId — `pg-*` groupId 404.
adminGroupsRouter.delete('/:id/members/:userId', async (c) => {
  const groupId = c.req.param('id')
  if (isPersonalGroupId(groupId)) return c.json({ error: 'not_found' }, 404)
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
