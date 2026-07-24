/**
 * Space permissions routes — Phase A (Confluence 风格空间角色分层)。
 *
 *   GET    /api/spaces/:id/permissions                   admin 或 space-admin
 *   PUT    /api/spaces/:id/permissions                   同上,full-replace
 *   POST   /api/spaces/:id/permissions/groups/:groupId   body: {role}
 *   DELETE /api/spaces/:id/permissions/groups/:groupId
 *   POST   /api/spaces/:id/permissions/users/:userId     body: {role}
 *   DELETE /api/spaces/:id/permissions/users/:userId
 *
 * 区别于 /api/admin/spaces/:id/access(legacy,只管 group 授权,视作
 * editor):这套端点操作 Phase A 的 `space_role_grants` 表,完整表达
 * (space, principal, role) 三元,允许 group 和 user 两种 principal,
 * 三种 role 任意组合。
 *
 * 权限:
 *   - 全局 admin:任何 space 的 permissions 都能管。
 *   - space-admin(对该 space 有 admin role):也能管本空间 permissions。
 *   - 其他人:404(对齐现有 canAccessSpace 的「不泄漏」策略)。
 *
 * 关键约束:
 *   1. role='admin' 不能授予 group —— 路由层 assertNotAdminToGroup 拒绝。
 *   2. 个人空间:替换后若没有 user-level admin grant,返回 409
 *      cannot_remove_last_admin —— owner 永远要保留对自己的 personal
 *      space 的 admin 角色。
 *   3. 共享空间:全局 admin 始终兜底(由 lib/permissions.effectiveSpaceRole
 *      短路),不需要 user-level admin grant。PUT 可以把所有 user-admin
 *      移除,只留 viewer / editor。
 *
 * Phase C 引入 permission_audit 日志;mutation 路由统一在事务内调
 * `recordPermissionAudit(tx, …)`,audit 行跟业务变更同事务同生死。
 */
import { Hono } from 'hono'
import { and, eq, ilike, inArray, like, not, notInArray, or, sql } from 'drizzle-orm'
import {
  PaginatedListSchema,
  SetSpacePermissionsInputSchema,
  UpsertGroupGrantInputSchema,
  UpsertUserGrantInputSchema,
  UserGroupSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import {
  spaceRoleGrants,
  spaces,
  userGroupMembers,
  userGroups,
  users,
} from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import {
  canAdminSpace,
  loadGrantsForSpace,
  migrateLegacyGroupGrant,
  principalFromUser,
  type SpaceGrants,
} from '../lib/permissions'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { rowToUser } from '../lib/rowMappers'
import { recordPermissionAudit } from '../lib/auditLog'

export const spacePermissionsRouter = new Hono<{ Variables: Variables }>()

// requireAuth 兜底;每个 handler 内部再判 isGlobalAdmin || canAdminSpace。
// 不挂 requireAdmin 是因为 space-admin 也能访问。
spacePermissionsRouter.use('*', requireAuth)

/* ─── Helpers ─────────────────────────────────────────────────────── */

function assertNotAdminToGroup(role: string, principalKind: 'user' | 'group'): void {
  if (role === 'admin' && principalKind === 'group') {
    const err = new Error('不能把管理权限授予用户组') as Error & {
      status: number
      code: string
    }
    err.status = 400
    err.code = 'admin_role_to_group'
    throw err
  }
}

async function loadSpaceOr404(spaceId: string): Promise<
  { id: string; kind: 'personal' | 'shared' | null; ownerId: string | null } | null
> {
  const row = (
    await db
      .select({ id: spaces.id, kind: spaces.kind, ownerId: spaces.ownerId })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1)
  )[0]
  if (!row) return null
  return { id: row.id, kind: row.kind, ownerId: row.ownerId }
}

/**
 * 写完后 count user-level admin grants(principal_kind='user' AND
 * role='admin')。共享空间 0 合法(全局 admin 兜底);个人空间必须 ≥ 1
 * (owner 始终要保留 admin 角色)。
 */
async function countUserAdminGrants(spaceId: string): Promise<number> {
  const result = await db
    .select({ id: spaceRoleGrants.id })
    .from(spaceRoleGrants)
    .where(
      and(
        eq(spaceRoleGrants.spaceId, spaceId),
        eq(spaceRoleGrants.principalKind, 'user'),
        eq(spaceRoleGrants.role, 'admin'),
      ),
    )
  return result.length
}

/* ─── Auth gate ───────────────────────────────────────────────────── */

async function requireSpaceAdmin(
  c: { req: { param: (k: string) => string }; var: { user: { id: string; role: 'admin' | 'user' } } },
): Promise<
  | { ok: true; spaceId: string; space: NonNullable<Awaited<ReturnType<typeof loadSpaceOr404>>> }
  | { ok: false; response: Response }
> {
  const spaceId = c.req.param('id')
  const me = principalFromUser(c.var.user)
  const space = await loadSpaceOr404(spaceId)
  if (!space) {
    return { ok: false, response: new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }) }
  }
  if (!me.isAdmin && !(await canAdminSpace(me, spaceId))) {
    return { ok: false, response: new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }) }
  }
  return { ok: true, spaceId, space }
}

/* ─── GET /api/spaces/:id/permissions ─────────────────────────────── */

spacePermissionsRouter.get('/:id/permissions', async (c) => {
  const gate = await requireSpaceAdmin(c)
  if (!gate.ok) return gate.response
  const grants: SpaceGrants = await loadGrantsForSpace(gate.spaceId)
  return c.json(grants)
})

/* ─── PUT /api/spaces/:id/permissions ─────────────────────────────── */

spacePermissionsRouter.put('/:id/permissions', async (c) => {
  const gate = await requireSpaceAdmin(c)
  if (!gate.ok) return gate.response
  const { spaceId, space } = gate
  const me = principalFromUser(c.var.user)

  const body = await c.req.json().catch(() => ({}))
  const parsed = SetSpacePermissionsInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { groups = [], users: userGrants = [] } = parsed.data

  // 1) 校验所有 groupId 存在
  if (groups.length > 0) {
    const found = await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(inArray(userGroups.id, groups.map((g) => g.groupId)))
    if (found.length !== groups.length) {
      const foundSet = new Set(found.map((r) => r.id))
      const missing = groups
        .map((g) => g.groupId)
        .filter((g) => !foundSet.has(g))
      return c.json(
        { error: 'invalid_input', message: '用户组不存在', missingGroupIds: missing },
        400,
      )
    }
  }

  // 2) 校验所有 userId 存在
  if (userGrants.length > 0) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, userGrants.map((u) => u.userId)))
    if (found.length !== userGrants.length) {
      const foundSet = new Set(found.map((r) => r.id))
      const missing = userGrants
        .map((u) => u.userId)
        .filter((u) => !foundSet.has(u))
      return c.json(
        { error: 'invalid_input', message: '用户不存在', missingUserIds: missing },
        400,
      )
    }
  }

  // 3) assertNotAdminToGroup
  for (const g of groups) {
    try {
      assertNotAdminToGroup(g.role, 'group')
    } catch (e) {
      const err = e as Error & { status?: number; code?: string }
      if (err.status) {
        return c.json(
          { error: err.code ?? 'invalid_input', message: err.message },
          400,
        )
      }
      throw e
    }
  }

  // 4) Full-replace 事务 + 审计日志
  const now = Date.now()
  const actorId = me.id
  // 拍 before 快照:事务前查一次,放进 audit payload 的 { before, after }
  const before = await loadGrantsForSpace(spaceId)
  await db.transaction(async (tx) => {
    await tx.delete(spaceRoleGrants).where(eq(spaceRoleGrants.spaceId, spaceId))
    const rows = [
      ...groups.map((g) => ({
        id: generatePageId(),
        spaceId,
        principalKind: 'group' as const,
        principalId: g.groupId,
        role: g.role,
        grantedBy: actorId,
        grantedAt: now,
      })),
      ...userGrants.map((u) => ({
        id: generatePageId(),
        spaceId,
        principalKind: 'user' as const,
        principalId: u.userId,
        role: u.role,
        grantedBy: actorId,
        grantedAt: now,
      })),
    ]
    if (rows.length > 0) {
      await tx.insert(spaceRoleGrants).values(rows)
    }
    await tx.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, spaceId))
    // after 在 tx 内现拉(确保拿到的是本次写入后的真实状态,不受外部
    // 并发写干扰 —— 但 recordPermissionAudit 在事务末尾,跟业务变更一同
    // commit / rollback,这是关键不变量)。
    const after = await loadGrantsForSpace(spaceId)
    await recordPermissionAudit(tx, {
      kind: 'space_grant_set',
      actorId,
      targetKind: 'space',
      targetId: spaceId,
      payload: { before, after },
    })
  })

  // 5) Personal-space 必须保留 user-level admin grant 的 invariant 校验
  if (space.kind === 'personal') {
    const count = await countUserAdminGrants(spaceId)
    if (count === 0) {
      return c.json(
        {
          error: 'conflict',
          code: 'cannot_remove_last_admin',
          message: '个人空间必须至少保留一个用户级管理员',
        },
        409,
      )
    }
  }

  const grants = await loadGrantsForSpace(spaceId)
  return c.json(grants)
})

/* ─── POST /api/spaces/:id/permissions/groups/:groupId ────────────── */

spacePermissionsRouter.post('/:id/permissions/groups/:groupId', async (c) => {
  const gate = await requireSpaceAdmin(c)
  if (!gate.ok) return gate.response
  const { spaceId } = gate
  const groupId = c.req.param('groupId')
  const me = principalFromUser(c.var.user)

  const grp = (
    await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(eq(userGroups.id, groupId))
      .limit(1)
  )[0]
  if (!grp) return c.json({ error: 'not_found', message: '用户组不存在' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = UpsertGroupGrantInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { role } = parsed.data

  try {
    assertNotAdminToGroup(role, 'group')
  } catch (e) {
    const err = e as Error & { status?: number; code?: string }
    if (err.status) {
      return c.json(
        { error: err.code ?? 'invalid_input', message: err.message },
        400,
      )
    }
    throw e
  }

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .insert(spaceRoleGrants)
      .values({
        id: generatePageId(),
        spaceId,
        principalKind: 'group',
        principalId: groupId,
        role,
        grantedBy: me.id,
        grantedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          spaceRoleGrants.spaceId,
          spaceRoleGrants.principalKind,
          spaceRoleGrants.principalId,
        ],
        set: { role, grantedBy: me.id, grantedAt: now },
      })
    // 隐式迁移(Phase A.5):同 (space, group) 的 legacy space_group_access
    // 行就地迁成 space_role_grants role='editor'。在主 INSERT 之后跑,
    // helper 用 onConflictDoNothing 保证不覆盖用户选的 viewer/admin。
    await migrateLegacyGroupGrant(
      tx,
      spaceId,
      groupId,
      generatePageId(),
      me.id,
      now,
    )
    await tx.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, spaceId))
    await recordPermissionAudit(tx, {
      kind: 'space_grant_add',
      actorId: me.id,
      targetKind: 'space',
      targetId: spaceId,
      payload: {
        after: {
          principalKind: 'group',
          principalId: groupId,
          role,
          grantedBy: me.id,
          grantedAt: now,
        },
      },
    })
  })

  const grants = await loadGrantsForSpace(spaceId)
  return c.json(grants)
})

/* ─── DELETE /api/spaces/:id/permissions/groups/:groupId ──────────── */

spacePermissionsRouter.delete('/:id/permissions/groups/:groupId', async (c) => {
  const gate = await requireSpaceAdmin(c)
  if (!gate.ok) return gate.response
  const { spaceId, space } = gate
  const me = principalFromUser(c.var.user)

  const groupId = c.req.param('groupId')
  // 拍 before:拿到这条 grant 的快照,事务内 audit 用。
  const existing = (
    await db
      .select({
        id: spaceRoleGrants.id,
        principalKind: spaceRoleGrants.principalKind,
        principalId: spaceRoleGrants.principalId,
        role: spaceRoleGrants.role,
        grantedBy: spaceRoleGrants.grantedBy,
        grantedAt: spaceRoleGrants.grantedAt,
      })
      .from(spaceRoleGrants)
      .where(
        and(
          eq(spaceRoleGrants.spaceId, spaceId),
          eq(spaceRoleGrants.principalKind, 'group'),
          eq(spaceRoleGrants.principalId, groupId),
        ),
      )
      .limit(1)
  )[0]
  if (!existing) {
    // 行已不存在,no-op 但仍 200/204 —— PUT 是 idempotent。
    return c.body(null, 204)
  }

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .delete(spaceRoleGrants)
      .where(
        and(
          eq(spaceRoleGrants.spaceId, spaceId),
          eq(spaceRoleGrants.principalKind, 'group'),
          eq(spaceRoleGrants.principalId, groupId),
        ),
      )
    await tx.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, spaceId))
    await recordPermissionAudit(tx, {
      kind: 'space_grant_remove',
      actorId: me.id,
      targetKind: 'space',
      targetId: spaceId,
      payload: {
        before: {
          principalKind: existing.principalKind,
          principalId: existing.principalId,
          role: existing.role,
          grantedBy: existing.grantedBy,
          grantedAt: existing.grantedAt,
        },
      },
    })
  })

  if (space.kind === 'personal') {
    const count = await countUserAdminGrants(spaceId)
    if (count === 0) {
      return c.json(
        {
          error: 'conflict',
          code: 'cannot_remove_last_admin',
          message: '个人空间必须至少保留一个用户级管理员',
        },
        409,
      )
    }
  }

  return c.body(null, 204)
})

/* ─── POST /api/spaces/:id/permissions/users/:userId ──────────────── */

spacePermissionsRouter.post('/:id/permissions/users/:userId', async (c) => {
  const gate = await requireSpaceAdmin(c)
  if (!gate.ok) return gate.response
  const { spaceId } = gate
  const userId = c.req.param('userId')
  const me = principalFromUser(c.var.user)

  const usr = (
    await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  )[0]
  if (!usr) return c.json({ error: 'not_found', message: '用户不存在' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = UpsertUserGrantInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { role } = parsed.data

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .insert(spaceRoleGrants)
      .values({
        id: generatePageId(),
        spaceId,
        principalKind: 'user',
        principalId: userId,
        role,
        grantedBy: me.id,
        grantedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          spaceRoleGrants.spaceId,
          spaceRoleGrants.principalKind,
          spaceRoleGrants.principalId,
        ],
        set: { role, grantedBy: me.id, grantedAt: now },
      })
    await tx.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, spaceId))
    await recordPermissionAudit(tx, {
      kind: 'space_grant_add',
      actorId: me.id,
      targetKind: 'space',
      targetId: spaceId,
      payload: {
        after: {
          principalKind: 'user',
          principalId: userId,
          role,
          grantedBy: me.id,
          grantedAt: now,
        },
      },
    })
  })

  const grants = await loadGrantsForSpace(spaceId)
  return c.json(grants)
})

/* ─── DELETE /api/spaces/:id/permissions/users/:userId ────────────── */

spacePermissionsRouter.delete('/:id/permissions/users/:userId', async (c) => {
  const gate = await requireSpaceAdmin(c)
  if (!gate.ok) return gate.response
  const { spaceId, space } = gate
  const me = principalFromUser(c.var.user)

  const userId = c.req.param('userId')

  // owner 不能撤销自己的 admin
  if (space.kind === 'personal' && space.ownerId === userId) {
    return c.json(
      {
        error: 'conflict',
        code: 'cannot_remove_last_admin',
        message: '不能撤销所有者对自己个人空间的管理权限',
      },
      409,
    )
  }

  const existing = (
    await db
      .select({
        id: spaceRoleGrants.id,
        principalKind: spaceRoleGrants.principalKind,
        principalId: spaceRoleGrants.principalId,
        role: spaceRoleGrants.role,
        grantedBy: spaceRoleGrants.grantedBy,
        grantedAt: spaceRoleGrants.grantedAt,
      })
      .from(spaceRoleGrants)
      .where(
        and(
          eq(spaceRoleGrants.spaceId, spaceId),
          eq(spaceRoleGrants.principalKind, 'user'),
          eq(spaceRoleGrants.principalId, userId),
        ),
      )
      .limit(1)
  )[0]
  if (!existing) {
    return c.body(null, 204)
  }

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .delete(spaceRoleGrants)
      .where(
        and(
          eq(spaceRoleGrants.spaceId, spaceId),
          eq(spaceRoleGrants.principalKind, 'user'),
          eq(spaceRoleGrants.principalId, userId),
        ),
      )
    await tx.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, spaceId))
    await recordPermissionAudit(tx, {
      kind: 'space_grant_remove',
      actorId: me.id,
      targetKind: 'space',
      targetId: spaceId,
      payload: {
        before: {
          principalKind: existing.principalKind,
          principalId: existing.principalId,
          role: existing.role,
          grantedBy: existing.grantedBy,
          grantedAt: existing.grantedAt,
        },
      },
    })
  })

  if (space.kind === 'personal') {
    const count = await countUserAdminGrants(spaceId)
    if (count === 0) {
      return c.json(
        {
          error: 'conflict',
          code: 'cannot_remove_last_admin',
          message: '个人空间必须至少保留一个用户级管理员',
        },
        409,
      )
    }
  }

  return c.body(null, 204)
})

/* ─── GET /api/spaces/:id/permissions/candidates ─────────────────── */
/**
 * 列出"可被授权进本空间的候选 group + user"。给 SpaceEditView 的
 * 「+ 添加组 / + 添加用户」下拉用。
 *
 * 复用 admin-groups / admin-users 的形状(都通过 zod schema 校验),
 * 但权限 gate 放宽到 space-admin(不只 global admin)。这是让
 * space-admin 能进 SpaceEditView 的关键路径 —— 后端不提供这个
 * endpoint,前端就只能用 `api.admin.groups.list` 那条 requireAdmin
 * 路径,space-admin 一进就 403。
 *
 * 字段裁剪:
 *   - groups:同 adminGroups.list(id/name/description/createdAt/
 *     memberCount),剔除 pg-* personal-space 组。
 *   - users:同 adminUsers.list shape,排除 disabled 账号。
 *
 * 不分页:UI 下拉是单页全量过滤,limit 仅作上限兜底。
 */
spacePermissionsRouter.get('/:id/permissions/candidates', async (c) => {
  const gate = await requireSpaceAdmin(c)
  if (!gate.ok) return gate.response
  const { spaceId: _spaceId } = gate

  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit } = parsed.args
  const max = Math.min(limit ?? 200, 500)

  const q = (c.req.query('q') ?? '').trim()
  const search = q ? `%${q}%` : null

  const [groupRows, userRows] = await Promise.all([
    search
      ? db
          .select({
            id: userGroups.id,
            name: userGroups.name,
            description: userGroups.description,
            createdAt: userGroups.createdAt,
            memberCount: sql<number>`COUNT(${userGroupMembers.userId})::int`,
          })
          .from(userGroups)
          .leftJoin(userGroupMembers, eq(userGroupMembers.groupId, userGroups.id))
          .where(
            and(
              not(like(userGroups.id, 'pg-%')),
              or(
                ilike(userGroups.name, search),
                sql`${userGroups.description} ILIKE ${search}`,
              ),
            ),
          )
          .groupBy(userGroups.id)
          .orderBy(userGroups.name)
          .limit(max)
      : db
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
          .orderBy(userGroups.name)
          .limit(max),
    search
      ? db
          .select()
          .from(users)
          .where(
            and(
              notInArray(users.status, ['disabled', 'anonymized']),
              or(ilike(users.name, search), ilike(users.email, search)),
            ),
          )
          .limit(max)
      : db
          .select()
          .from(users)
          .where(notInArray(users.status, ['disabled', 'anonymized']))
          .limit(max),
  ])

  const result = {
    groups: groupRows.map((r) => UserGroupSchema.parse({ ...r, memberCount: r.memberCount })),
    users: userRows.map((r) => UserSchema.parse(rowToUser(r))),
  }
  return c.json(result)
})
