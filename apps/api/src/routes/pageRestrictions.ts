/**
 * Page-level restrictions routes — Phase B (Confluence 风格 view/edit 限制)。
 *
 *   GET    /api/pages/:id/restrictions                              — canReadPage
 *   PUT    /api/pages/:id/restrictions                              — page author / space admin / global admin
 *   POST   /api/pages/:id/restrictions/{view|edit}/users/:userId    — 同 PUT 权限
 *   DELETE /api/pages/:id/restrictions/{view|edit}/users/:userId    — 同 PUT 权限
 *   POST   /api/pages/:id/restrictions/{view|edit}/groups/:groupId  — 同 PUT 权限
 *   DELETE /api/pages/:id/restrictions/{view|edit}/groups/:groupId  — 同 PUT 权限
 *
 * 设计要点:
 *   - 跟 spacePermissions.ts 对称(同样 requireAuth 兜底 + handler 内细判)。
 *   - 编辑权限 gate = `canEditPage`(蕴含 read,见 permissions.ts)+ global
 *     admin 短路 —— 因此 global admin / 页作者 / 空间 editor 都能配
 *     restrictions;空间 viewer 不能。这是 Confluence 的既定行为。
 *   - 整组替换走 PUT,跟 spacePermissions 一致;单行 UPSERT 走
 *     POST .../users/:id 或 .../groups/:groupId(ON CONFLICT DO UPDATE
 *     幂等)。
 *   - 404-not-403 政策:对 view-restricted page,GET 路由仍返 404(读不到
 *     page 就读不到 restrictions),与现有 canAccessSpace 策略对齐。
 *   - 个人空间(phase A 的 pg-<ownerId> 组):全局 admin 仍受
 *     assertAdminNotWritingPersonalSpace 保护 —— 但 RESTRICTIONS 是
 *     metadata,不是 page content,这条 guard 不挡(plan 明确)。
 *   - No FK(CLAUDE.md):disabled/deleted user / group 的 restrictions 行
 *     保留(audit 可见),由 admin 端 sweep。
 *
 * Phase C 引入 permission_audit 日志;mutation handler 统一在事务内调
 * `recordPermissionAudit(tx, ...)`,audit 行跟业务变更同事务同生死。
 */
import { Hono } from 'hono'
import { and, eq, inArray, notLike } from 'drizzle-orm'
import {
  SetPageRestrictionsInputSchema,
  UpsertPageRestrictionInputSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import {
  pageRestrictions,
  pages,
  userGroups,
  users,
} from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import {
  canEditPage,
  canReadPage,
  loadPageMeta,
  principalFromUser,
  type Principal,
} from '../lib/permissions'
import { recordPermissionAudit } from '../lib/auditLog'
import type { PageRestriction, PageRestrictions } from '@power-wiki/shared'

export const pageRestrictionsRouter = new Hono<{ Variables: Variables }>()

// requireAuth 兜底;handler 内细判 canReadPage(GET) / canEditPage-equivalent(写)。
pageRestrictionsRouter.use('*', requireAuth)

/* ─── Helpers ─────────────────────────────────────────────────────── */

interface PageRestrictionRowInput {
  principalKind: 'user' | 'group'
  principalId: string
}

/**
 * 校验传入 restrictions 的 principal 全部存在(分 user / group 一次查)。
 * - 存在性:user 在 users 表、group 在 user_groups 表。
 * - 缺失集合原样回传便于前端 debug。
 * - 与 spacePermissions 的 "用户/用户组不存在" 错误格式保持对称。
 */
async function validatePrincipals(
  items: PageRestrictionRowInput[],
): Promise<{ ok: true } | { ok: false; missingUserIds: string[]; missingGroupIds: string[] }> {
  const userIds = items.filter((i) => i.principalKind === 'user').map((i) => i.principalId)
  const groupIds = items.filter((i) => i.principalKind === 'group').map((i) => i.principalId)
  const missingUserIds: string[] = []
  const missingGroupIds: string[] = []
  if (userIds.length > 0) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, userIds))
    const foundSet = new Set(found.map((r) => r.id))
    for (const id of userIds) if (!foundSet.has(id)) missingUserIds.push(id)
  }
  if (groupIds.length > 0) {
    const found = await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(inArray(userGroups.id, groupIds))
    const foundSet = new Set(found.map((r) => r.id))
    for (const id of groupIds) if (!foundSet.has(id)) missingGroupIds.push(id)
  }
  if (missingUserIds.length > 0 || missingGroupIds.length > 0) {
    return { ok: false, missingUserIds, missingGroupIds }
  }
  return { ok: true }
}

/** 把 loadPageRestrictions(Set 形态)转成 DTO 数组(含 grantedBy/grantedAt
 *  元信息)。需要一次额外查询把 (principalKind, principalId) 拼回去 ——
 *  loadPageRestrictions 只返了 kind + principalKind + principalId,granted
 *  元信息走另一条 SQL 拿全。 */
async function loadPageRestrictionsFull(pageId: string): Promise<PageRestrictions> {
  const rows = await db
    .select({
      kind: pageRestrictions.kind,
      principalKind: pageRestrictions.principalKind,
      principalId: pageRestrictions.principalId,
      grantedBy: pageRestrictions.grantedBy,
      grantedAt: pageRestrictions.grantedAt,
    })
    .from(pageRestrictions)
    .where(eq(pageRestrictions.pageId, pageId))
  const view: PageRestriction[] = []
  const edit: PageRestriction[] = []
  for (const r of rows) {
    const target = r.kind === 'view' ? view : edit
    target.push({
      principalKind: r.principalKind,
      principalId: r.principalId,
      grantedBy: r.grantedBy,
      grantedAt: typeof r.grantedAt === 'string' ? Number(r.grantedAt) : r.grantedAt,
    })
  }
  return { view, edit }
}

/* ─── 写权限 gate(作者 / space-admin / global admin / space-editor 四选一) ─ */

/**
 * 判断当前 user 能否修改 page 的 restrictions。Confluence 行为:能配
 * 置 page 限制的人 = 能编辑该 page 的人 + global admin + space-admin。
 *
 * 直接复用 `canEditPage`(2026-07-22 起蕴含 read):
 *  - global admin / page 作者:短路 true
 *  - 空间 editor:在能读的页(没 view 限制,或在 view allow-list)上能
 *    管 restrictions
 *  - 空间 viewer:永远 false(viewer 本来就不能编辑)
 *
 * view 限制的场景处理:空间 editor X 看不到 view-restricted page P
 * (X 不在 allow-list)→ canReadPage false → canEditPage false → 返
 * false。X 不能管理一个他看不到的页的限制,跟「edit 蕴含 read」同套
 * 语义,符合 Confluence 行为(防止「暗箱配置别人看不到的内容」)。
 */
async function canManageRestrictions(
  me: Principal,
  pageId: string,
  spaceId: string,
): Promise<boolean> {
  if (me.kind !== 'user' && !me.isAdmin) return false
  const meta = await loadPageMeta(pageId)
  if (!meta) return false
  return canEditPage(me, pageId, meta.spaceId, meta.authorId)
}

/* ─── GET /api/pages/:id/restrictions ─────────────────────────────── */

pageRestrictionsRouter.get('/:id/restrictions', async (c) => {
  const pageId = c.req.param('id')
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return c.json({ error: 'not_found' }, 404)
  if (meta.deletedAt !== null) return c.json({ error: 'not_found' }, 404)
  // 读 restrictions 需要至少能读 page(404-not-403 一致)
  if (!(await canReadPage(me, pageId, meta.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  const restrictions = await loadPageRestrictionsFull(pageId)
  return c.json(restrictions)
})

/* ─── GET /api/pages/:id/restrictions/candidates ──────────────────────
 *  给限制 dialog 的 people/group picker 用。管理限制的人可能是页面作者
 *  (非全局 admin),拿不到 admin.users.list —— 这里用同一个
 *  canManageRestrictions gate 放行,返回全部活跃用户 + 非个人组。
 *  前端做本地过滤(数据量小,当前规模无需服务端搜索)。 */
pageRestrictionsRouter.get('/:id/restrictions/candidates', async (c) => {
  const pageId = c.req.param('id')
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return c.json({ error: 'not_found' }, 404)
  if (meta.deletedAt !== null) return c.json({ error: 'not_found' }, 404)
  if (!(await canManageRestrictions(me, pageId, meta.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const [userRows, groupRows] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        color: users.color,
        avatarKind: users.avatarKind,
        avatarRef: users.avatarRef,
      })
      .from(users)
      .where(eq(users.status, 'active'))
      .orderBy(users.name)
      .limit(500),
    db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        description: userGroups.description,
      })
      .from(userGroups)
      // 个人组(pg-<userId>)不作为限制候选 —— 它只代表单个 owner,
      // 直接选那个 user 更直观。
      .where(notLike(userGroups.id, 'pg-%'))
      .orderBy(userGroups.name)
      .limit(500),
  ])

  return c.json({ users: userRows, groups: groupRows })
})

pageRestrictionsRouter.put('/:id/restrictions', async (c) => {
  const pageId = c.req.param('id')
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return c.json({ error: 'not_found' }, 404)
  if (meta.deletedAt !== null) return c.json({ error: 'not_found' }, 404)

  if (!(await canManageRestrictions(me, pageId, meta.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = SetPageRestrictionsInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { view = [], edit = [] } = parsed.data

  // 1) 校验 principal 全部存在
  const principalsCheck = await validatePrincipals([
    ...view.map((v) => ({ principalKind: v.principalKind, principalId: v.principalId })),
    ...edit.map((e) => ({ principalKind: e.principalKind, principalId: e.principalId })),
  ])
  if (!principalsCheck.ok) {
    return c.json(
      {
        error: 'invalid_input',
        message: '主体不存在',
        missingUserIds: principalsCheck.missingUserIds,
        missingGroupIds: principalsCheck.missingGroupIds,
      },
      400,
    )
  }

  // 2) Full-replace 事务 + 审计日志
  const now = Date.now()
  const actorId = me.id
  // 拍 before 快照(事务前的 view/edit 数组)。Phase B 已经有 loadPageRestrictionsFull,
  // 复用它拿 before。
  const before = await loadPageRestrictionsFull(pageId)
  await db.transaction(async (tx) => {
    await tx.delete(pageRestrictions).where(eq(pageRestrictions.pageId, pageId))
    const rows = [
      ...view.map((v) => ({
        id: generatePageId(),
        spaceId: meta.spaceId,
        pageId,
        kind: 'view' as const,
        principalKind: v.principalKind,
        principalId: v.principalId,
        grantedBy: v.grantedBy ?? actorId,
        grantedAt: v.grantedAt > 0 ? v.grantedAt : now,
      })),
      ...edit.map((e) => ({
        id: generatePageId(),
        spaceId: meta.spaceId,
        pageId,
        kind: 'edit' as const,
        principalKind: e.principalKind,
        principalId: e.principalId,
        grantedBy: e.grantedBy ?? actorId,
        grantedAt: e.grantedAt > 0 ? e.grantedAt : now,
      })),
    ]
    if (rows.length > 0) {
      await tx.insert(pageRestrictions).values(rows)
    }
    // 触发 page.updatedAt 同步,UI 列表的 updatedAt DESC 排序会反映
    // 「限制被改了」事件。
    await tx.update(pages).set({ updatedAt: now }).where(eq(pages.id, pageId))
    // 拍 after 快照(事务内,跟业务变更同 commit / rollback)。
    const after = await loadPageRestrictionsFull(pageId)
    await recordPermissionAudit(tx, {
      kind: 'page_restriction_set',
      actorId,
      targetKind: 'page',
      targetId: pageId,
      payload: { before, after },
    })
  })

  const restrictions = await loadPageRestrictionsFull(pageId)
  return c.json(restrictions)
})

/* ─── POST /api/pages/:id/restrictions/{view|edit}/users/:userId ──── */

pageRestrictionsRouter.post('/:id/restrictions/:kind/users/:userId', async (c) => {
  const pageId = c.req.param('id')
  const kind = c.req.param('kind')
  const userId = c.req.param('userId')
  if (kind !== 'view' && kind !== 'edit') {
    return c.json({ error: 'invalid_input', message: 'kind 必须为 view 或 edit' }, 400)
  }
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return c.json({ error: 'not_found' }, 404)
  if (meta.deletedAt !== null) return c.json({ error: 'not_found' }, 404)
  if (!(await canManageRestrictions(me, pageId, meta.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const usr = (
    await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  )[0]
  if (!usr) {
    return c.json({ error: 'invalid_input', message: '用户不存在' }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = UpsertPageRestrictionInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .insert(pageRestrictions)
      .values({
        id: generatePageId(),
        spaceId: meta.spaceId,
        pageId,
        kind,
        principalKind: 'user',
        principalId: userId,
        grantedBy: me.id,
        grantedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pageRestrictions.pageId,
          pageRestrictions.kind,
          pageRestrictions.principalKind,
          pageRestrictions.principalId,
        ],
        set: { grantedBy: me.id, grantedAt: now },
      })
    await tx.update(pages).set({ updatedAt: now }).where(eq(pages.id, pageId))
    await recordPermissionAudit(tx, {
      kind: 'page_restriction_add',
      actorId: me.id,
      targetKind: 'page',
      targetId: pageId,
      payload: {
        after: {
          kind,
          principalKind: 'user',
          principalId: userId,
          grantedBy: me.id,
          grantedAt: now,
        },
      },
    })
  })

  const restrictions = await loadPageRestrictionsFull(pageId)
  return c.json(restrictions)
})

/* ─── DELETE /api/pages/:id/restrictions/{view|edit}/users/:userId ── */

pageRestrictionsRouter.delete('/:id/restrictions/:kind/users/:userId', async (c) => {
  const pageId = c.req.param('id')
  const kind = c.req.param('kind')
  const userId = c.req.param('userId')
  if (kind !== 'view' && kind !== 'edit') {
    return c.json({ error: 'invalid_input', message: 'kind 必须为 view 或 edit' }, 400)
  }
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return c.json({ error: 'not_found' }, 404)
  if (meta.deletedAt !== null) return c.json({ error: 'not_found' }, 404)
  if (!(await canManageRestrictions(me, pageId, meta.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // 拍 before:拿到这条限制的快照(仅当行存在)。
  const existing = (
    await db
      .select({
        id: pageRestrictions.id,
        kind: pageRestrictions.kind,
        principalKind: pageRestrictions.principalKind,
        principalId: pageRestrictions.principalId,
        grantedBy: pageRestrictions.grantedBy,
        grantedAt: pageRestrictions.grantedAt,
      })
      .from(pageRestrictions)
      .where(
        and(
          eq(pageRestrictions.pageId, pageId),
          eq(pageRestrictions.kind, kind),
          eq(pageRestrictions.principalKind, 'user'),
          eq(pageRestrictions.principalId, userId),
        ),
      )
      .limit(1)
  )[0]

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .delete(pageRestrictions)
      .where(
        and(
          eq(pageRestrictions.pageId, pageId),
          eq(pageRestrictions.kind, kind),
          eq(pageRestrictions.principalKind, 'user'),
          eq(pageRestrictions.principalId, userId),
        ),
      )
    await tx.update(pages).set({ updatedAt: now }).where(eq(pages.id, pageId))
    if (existing) {
      await recordPermissionAudit(tx, {
        kind: 'page_restriction_remove',
        actorId: me.id,
        targetKind: 'page',
        targetId: pageId,
        payload: {
          before: {
            kind: existing.kind,
            principalKind: existing.principalKind,
            principalId: existing.principalId,
            grantedBy: existing.grantedBy,
            grantedAt: existing.grantedAt,
          },
        },
      })
    }
  })

  const restrictions = await loadPageRestrictionsFull(pageId)
  return c.json(restrictions)
})

/* ─── POST /api/pages/:id/restrictions/{view|edit}/groups/:groupId ── */

pageRestrictionsRouter.post('/:id/restrictions/:kind/groups/:groupId', async (c) => {
  const pageId = c.req.param('id')
  const kind = c.req.param('kind')
  const groupId = c.req.param('groupId')
  if (kind !== 'view' && kind !== 'edit') {
    return c.json({ error: 'invalid_input', message: 'kind 必须为 view 或 edit' }, 400)
  }
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return c.json({ error: 'not_found' }, 404)
  if (meta.deletedAt !== null) return c.json({ error: 'not_found' }, 404)
  if (!(await canManageRestrictions(me, pageId, meta.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const grp = (
    await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(eq(userGroups.id, groupId))
      .limit(1)
  )[0]
  if (!grp) {
    return c.json({ error: 'invalid_input', message: '用户组不存在' }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = UpsertPageRestrictionInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .insert(pageRestrictions)
      .values({
        id: generatePageId(),
        spaceId: meta.spaceId,
        pageId,
        kind,
        principalKind: 'group',
        principalId: groupId,
        grantedBy: me.id,
        grantedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pageRestrictions.pageId,
          pageRestrictions.kind,
          pageRestrictions.principalKind,
          pageRestrictions.principalId,
        ],
        set: { grantedBy: me.id, grantedAt: now },
      })
    await tx.update(pages).set({ updatedAt: now }).where(eq(pages.id, pageId))
    await recordPermissionAudit(tx, {
      kind: 'page_restriction_add',
      actorId: me.id,
      targetKind: 'page',
      targetId: pageId,
      payload: {
        after: {
          kind,
          principalKind: 'group',
          principalId: groupId,
          grantedBy: me.id,
          grantedAt: now,
        },
      },
    })
  })

  const restrictions = await loadPageRestrictionsFull(pageId)
  return c.json(restrictions)
})

/* ─── DELETE /api/pages/:id/restrictions/{view|edit}/groups/:groupId */

pageRestrictionsRouter.delete('/:id/restrictions/:kind/groups/:groupId', async (c) => {
  const pageId = c.req.param('id')
  const kind = c.req.param('kind')
  const groupId = c.req.param('groupId')
  if (kind !== 'view' && kind !== 'edit') {
    return c.json({ error: 'invalid_input', message: 'kind 必须为 view 或 edit' }, 400)
  }
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return c.json({ error: 'not_found' }, 404)
  if (meta.deletedAt !== null) return c.json({ error: 'not_found' }, 404)
  if (!(await canManageRestrictions(me, pageId, meta.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const existing = (
    await db
      .select({
        id: pageRestrictions.id,
        kind: pageRestrictions.kind,
        principalKind: pageRestrictions.principalKind,
        principalId: pageRestrictions.principalId,
        grantedBy: pageRestrictions.grantedBy,
        grantedAt: pageRestrictions.grantedAt,
      })
      .from(pageRestrictions)
      .where(
        and(
          eq(pageRestrictions.pageId, pageId),
          eq(pageRestrictions.kind, kind),
          eq(pageRestrictions.principalKind, 'group'),
          eq(pageRestrictions.principalId, groupId),
        ),
      )
      .limit(1)
  )[0]

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .delete(pageRestrictions)
      .where(
        and(
          eq(pageRestrictions.pageId, pageId),
          eq(pageRestrictions.kind, kind),
          eq(pageRestrictions.principalKind, 'group'),
          eq(pageRestrictions.principalId, groupId),
        ),
      )
    await tx.update(pages).set({ updatedAt: now }).where(eq(pages.id, pageId))
    if (existing) {
      await recordPermissionAudit(tx, {
        kind: 'page_restriction_remove',
        actorId: me.id,
        targetKind: 'page',
        targetId: pageId,
        payload: {
          before: {
            kind: existing.kind,
            principalKind: existing.principalKind,
            principalId: existing.principalId,
            grantedBy: existing.grantedBy,
            grantedAt: existing.grantedAt,
          },
        },
      })
    }
  })

  const restrictions = await loadPageRestrictionsFull(pageId)
  return c.json(restrictions)
})
