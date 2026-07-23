/**
 * 权限解析中心库(Phase A + Phase B)。
 *
 * 这是项目里**唯一**允许写权限 SQL 的文件。所有路由 / guard / 谓词都通过
 * 这个文件来问「subject S 能否对 space SP / page P 做 op」—— 任何业务代码
 * 都不应自己写 `JOIN space_group_access` / `JOIN space_role_grants` /
 * `JOIN page_restrictions`。
 *
 * 设计要点:
 *   - 三个空间角色:viewer / editor / admin(roles: 1 / 2 / 3)。无自定义
 *     角色,无 deny 语义,纯正向 grant + 默认拒绝。
 *   - 主体(Principal)可以是 user / group / anonymous。Phase A 落地
 *     user + admin 短路;anonymous 留 Phase D 用。
 *   - 向后兼容:legacy `space_group_access` 行继续有效,`effectiveSpaceRole`
 *     UNION 读两表,legacy 行视为 `editor`(最宽松,保留旧行为)。
 *   - admin 语义:全局 admin 是 shared space 的 super admin,personal
 *     space 的写操作由 `assertAdminNotWritingPersonalSpace` 在路由层
 *     单独拦截(CLAUDE.md 硬约束:不引入 admin 写个人空间内容)。
 *   - Phase B 页面级限制:view 继承父链,edit 不继承(参 B.2 实现)。
 *     作者本人 + global admin 始终 full(短路,不走 allow-list 校验)。
 *   - 无 FK(CLAUDE.md):cleanup 由 adminGroups / adminUsers / adminSpaces
 *     DELETE handler / pages.ts DELETE ?purge=true 在事务内显式 sweep。
 *
 * 性能:
 *   - 每次单空间判定是 ~2-3ms(3 个子查询各走 index)。
 *   - 每次单 page 判定:view 走 BFS 父链,深度一般 < 10 层,O(depth) 可接受。
 *   - listReadableSpaceIds 一次 SQL 出所有 readable space,UI 列表/侧栏
 *     走这个,不要 N+1。
 *
 * 替换关系:
 *   - 旧 `canAccessSpace(userId, isAdmin, spaceId)` ─→ 新
 *     `canReadSpace({kind:'user', id, isAdmin}, spaceId)`。兼容 shim
 *     `canAccessSpace` 仍然存在(委托给 canReadSpace),Phase B 后删除。
 *   - 旧 `getAccessibleSpaceIds(userId, isAdmin)` ─→ 新
 *     `listReadableSpaceIds(me)`,返回 `'*' | string[]`。
 *     accessibleSpaceIds.ts 保留 wrapper,Phase B 后删除。
 */
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import {
  pageRestrictions,
  pages,
  spaceGroupAccess,
  spaceRoleGrants,
  userGroupMembers,
} from '../db/schema'

/* ─── Types ──────────────────────────────────────────────────────── */

export type SpaceRole = 'viewer' | 'editor' | 'admin'

export type PrincipalKind = 'user' | 'group' | 'anonymous'

/**
 * 主体:权限解析的"问询方"。每个 route 入口把 c.var.user 转成
 * Principal,后续所有权限判断都走 Principal。
 *
 * - kind='user' + isAdmin=true:全局管理员(常见路径:c.var.user.role === 'admin')
 * - kind='user' + isAdmin=false:普通登录用户
 * - kind='anonymous':匿名主体(Phase D,公开分享链接场景)
 * - kind='group':(预留)代表「以组身份问权限」的形态,目前未使用
 */
export interface Principal {
  kind: PrincipalKind
  id: string
  isAdmin: boolean
}

/** 从 c.var.user 快速构造 Principal 的工厂。 */
export function principalFromUser(user: {
  id: string
  role: 'admin' | 'user'
}): Principal {
  return { kind: 'user', id: user.id, isAdmin: user.role === 'admin' }
}

/* ─── Role helpers ───────────────────────────────────────────────── */

const ROLE_RANK: Record<SpaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

function rankToRole(rank: number): SpaceRole | null {
  if (rank >= ROLE_RANK.admin) return 'admin'
  if (rank >= ROLE_RANK.editor) return 'editor'
  if (rank >= ROLE_RANK.viewer) return 'viewer'
  return null
}

/* ─── Core: effectiveSpaceRole ───────────────────────────────────── */

/**
 * 解析一个主体在某个空间上的有效角色。
 *
 * 返回:
 *   - 'admin' / 'editor' / 'viewer':有显式或隐式授权
 *   - null:无任何授权(默认拒绝)
 *
 * 行为细节:
 *   - admin:返回 'admin'(包括 personal space)。**写 personal space
 *     的 403 由路由层的 `assertAdminNotWritingPersonalSpace` 拦截,
 *     不在这个文件里**。
 *   - anonymous:返回 null(匿名用户只能走公开分享链接,Phase D
 *     在 `canReadPage` 里 token 命中后短路放行,不走本函数)。
 *   - regular user:UNION space_role_grants(direct user grant + group
 *     grant)+ space_group_access(legacy,视作 'editor'),取 MAX(role)。
 *
 * SQL 走 raw 是因为 drizle 的 CASE/UNION 嵌套写出来很啰嗦,且
 * effectiveSpaceRole 跟 listReadableSpaceIds 共享一个 CTE 的可能性
 * 留作未来优化点(避免重复 UNION)。
 */
export async function effectiveSpaceRole(
  me: Principal,
  spaceId: string,
): Promise<SpaceRole | null> {
  if (me.kind === 'anonymous') return null
  if (me.isAdmin) return 'admin'

  const result = await db.execute<{ rank: number | null }>(sql`
    SELECT COALESCE(
      MAX(CASE role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 END),
      0
    )::int AS rank
    FROM (
      SELECT role FROM space_role_grants
        WHERE space_id = ${spaceId}
          AND (
            (principal_kind = 'user' AND principal_id = ${me.id})
            OR (principal_kind = 'group' AND principal_id IN (
              SELECT group_id FROM user_group_members WHERE user_id = ${me.id}
            ))
          )
      UNION ALL
      SELECT 'editor'::text AS role
        FROM space_group_access sga
        JOIN user_group_members ugm ON sga.group_id = ugm.group_id
        WHERE sga.space_id = ${spaceId} AND ugm.user_id = ${me.id}
    ) all_grants
  `)
  return rankToRole(result.rows[0]?.rank ?? 0)
}

/* ─── Predicates ─────────────────────────────────────────────────── */

/**
 * 主体能否读该空间。read 在 viewer / editor / admin 三个角色下都允许。
 *
 *  - admin 永远 true(共享空间 super admin,personal space 也读得到,
 *    后者由 listVisibleSpaces 在 admin 路径专门暴露)。
 *  - anonymous 永远 false(走公开分享的 page-level 路径,不问 space)。
 */
export async function canReadSpace(me: Principal, spaceId: string): Promise<boolean> {
  if (me.kind === 'anonymous') return false
  if (me.isAdmin) return true
  const role = await effectiveSpaceRole(me, spaceId)
  return role !== null
}

/**
 * 主体能否编辑该空间的内容(创建/修改/删除页面、附件、评论)。
 *
 *  - admin:永远 true。**personal space 的 403 拦截由
 *    `assertAdminNotWritingPersonalSpace` 在调用 canEditSpace
 *    之后独立完成**,不在这层做(保留个人空间 owner-only 语义)。
 *  - viewer:false。editor / admin:true。
 */
export async function canEditSpace(me: Principal, spaceId: string): Promise<boolean> {
  if (me.kind === 'anonymous') return false
  if (me.isAdmin) return true
  const role = await effectiveSpaceRole(me, spaceId)
  return role === 'admin' || role === 'editor'
}

/**
 * 主体是否是该空间的 admin(可以管理权限 / 改空间元信息 / 删空间)。
 *
 *  - 全局 admin:是任何 shared space 的 admin(personal space 走
 *    personalSpaceGuard,虽然本函数返回 true,delete space 路由会另判)。
 *  - viewer / editor:false。space-admin:仅当显式 / 隐式 grant 是 admin。
 */
export async function canAdminSpace(me: Principal, spaceId: string): Promise<boolean> {
  if (me.kind === 'anonymous') return false
  if (me.isAdmin) return true
  const role = await effectiveSpaceRole(me, spaceId)
  return role === 'admin'
}

/* ─── Bulk: listReadableSpaceIds ──────────────────────────────────── */

export type ListReadableSpaceIdsResult = '*' | string[]

/**
 * 批量拿当前用户在多个 space 上的 effective role(供 list 路径用)。
 *
 * 调用场景:pages list 一次返 N 页,跨 M 个 space。在每行 PageNode 上
 * 注入 `viewerRole`,前端用这个 gate 编辑/+ 创建/复制按钮(避免 viewer
 * 点了之后被后端 404)。M 一般 < 10,做 N+1 也能接受,但这里走一次
 * SQL 聚合更干净。
 *
 * 语义对齐 `effectiveSpaceRole`:
 *   - admin:返回 map 全 'admin'。**personal space 也算 'admin'**;
 *     写 personal space 的拦截在路由层 assertAdminNotWritingPersonalSpace,
 *     不影响 role 计算。
 *   - anonymous:返回空 map(无访问)。
 *   - regular user:一次 SQL,UNION space_role_grants(直 user grant ∪
 *     group grant)+ space_group_access(legacy,视为 editor),按 space_id
 *     GROUP BY 后取 MAX(rank)。
 *
 * @returns Map<spaceId, SpaceRole | null>。Map 永远包含传入的每个
 *   spaceId(没授权 = null),调用方无需做 has 检查。
 */
export async function getEffectiveSpaceRolesForUser(
  me: Principal,
  spaceIds: string[],
): Promise<Map<string, SpaceRole | null>> {
  const out = new Map<string, SpaceRole | null>()
  for (const id of spaceIds) out.set(id, null)
  if (spaceIds.length === 0) return out

  if (me.kind === 'anonymous') return out
  if (me.isAdmin) {
    for (const id of spaceIds) out.set(id, 'admin')
    return out
  }

  const idList = sql.join(spaceIds.map((id) => sql`${id}`), sql`, `)
  const result = await db.execute<{ spaceId: string; rank: number | null }>(sql`
    SELECT space_id AS "spaceId",
           COALESCE(
             MAX(CASE role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 END),
             0
           )::int AS rank
      FROM (
        SELECT space_id, role FROM space_role_grants
          WHERE (principal_kind = 'user' AND principal_id = ${me.id})
             OR (principal_kind = 'group' AND principal_id IN (
               SELECT group_id FROM user_group_members WHERE user_id = ${me.id}
             ))
          UNION ALL
        SELECT sga.space_id, 'editor'::text AS role
          FROM space_group_access sga
          JOIN user_group_members ugm ON sga.group_id = ugm.group_id
          WHERE ugm.user_id = ${me.id}
      ) all_grants
     WHERE space_id IN (${idList})
     GROUP BY space_id
  `)
  for (const r of result.rows) {
    const role = rankToRole(r.rank ?? 0)
    out.set(r.spaceId, role)
  }
  return out
}

/**
 * 主体能读的所有 space id。admin 返回 '*' 哨兵(调用方应当作
 * "不过滤"处理,跳过 WHERE 走全表)。
 *
 * regular user 走一次 SQL 出所有 space_id:
 *   - space_role_grants (direct user grant ∪ group grant)
 *   - UNION space_group_access(legacy)
 *   - 去重
 *
 * 调用方应把 '*' 跟 string[] 一视同仁地处理。返回 string[] 时
 * 已 dedupe,可直接 `new Set(ids)`。
 */
export async function listReadableSpaceIds(
  me: Principal,
): Promise<ListReadableSpaceIdsResult> {
  if (me.kind === 'anonymous') return []
  if (me.isAdmin) return '*'

  const result = await db.execute<{ spaceId: string }>(sql`
    SELECT DISTINCT space_id AS "spaceId"
    FROM (
      SELECT space_id FROM space_role_grants
        WHERE (principal_kind = 'user' AND principal_id = ${me.id})
           OR (principal_kind = 'group' AND principal_id IN (
             SELECT group_id FROM user_group_members WHERE user_id = ${me.id}
           ))
      UNION
      SELECT sga.space_id
        FROM space_group_access sga
        JOIN user_group_members ugm ON sga.group_id = ugm.group_id
        WHERE ugm.user_id = ${me.id}
    ) all_spaces
  `)
  return result.rows.map((r) => r.spaceId)
}

/* ─── Backward-compat shim (Phase A) ──────────────────────────────── */

/**
 * Phase A 期间旧 `canAccessSpace(userId, isAdmin, spaceId)` 调用点
 * 仍然保留(由 `accessibleSpaceIds.ts` 转发到这里)。语义对齐:
 * admin → true,否则走 space-level readable 判定。Phase B 后
 * 全部迁移到 canReadPage / canEditPage,这个 shim 删除。
 *
 * @deprecated use canReadSpace({ kind: 'user', id, isAdmin }, spaceId)
 */
export async function canAccessSpace(
  userId: string,
  isAdmin: boolean,
  spaceId: string,
): Promise<boolean> {
  return canReadSpace({ kind: 'user', id: userId, isAdmin }, spaceId)
}

/* ─── Grants loader (for UI) ─────────────────────────────────────── */

export interface SpaceGroupGrant {
  groupId: string
  role: SpaceRole
  grantedBy: string | null
  grantedAt: number
}

export interface SpaceUserGrant {
  userId: string
  role: SpaceRole
  grantedBy: string | null
  grantedAt: number
}

export interface SpaceGrants {
  groups: SpaceGroupGrant[]
  users: SpaceUserGrant[]
}

/**
 * 拉单个空间的全量 grants(用于 SpacePermissionsView 渲染)。
 *
 *  - 新表 `space_role_grants` 全部展开(groups + users)。
 *  - legacy `space_group_access` 补齐:**只补 role='editor'** 的 group
 *    grant(因为 legacy 等价于 'editor' 角色;若同 (space, group) 已经有
 *    新表 grant,优先用新表的 role 覆盖)。
 *
 * 排序:grantedAt ASC(同主体多次 grant 调整时,最新的最后;在 UI 上
 * 自然按时间序列展示)。
 */
export async function loadGrantsForSpace(spaceId: string): Promise<SpaceGrants> {
  // 1) space_role_grants 全部行
  const newRows = await db.execute<{
    principalKind: 'user' | 'group'
    principalId: string
    role: SpaceRole
    grantedBy: string | null
    grantedAt: number
  }>(sql`
    SELECT principal_kind AS "principalKind",
           principal_id   AS "principalId",
           role,
           granted_by     AS "grantedBy",
           granted_at     AS "grantedAt"
      FROM space_role_grants
     WHERE space_id = ${spaceId}
  `)

  // 2) legacy space_group_access 补 'editor' role
  const legacyRows = await db.execute<{ groupId: string }>(sql`
    SELECT sga.group_id AS "groupId"
      FROM space_group_access sga
     WHERE sga.space_id = ${spaceId}
       AND NOT EXISTS (
         SELECT 1 FROM space_role_grants srg
          WHERE srg.space_id = ${spaceId}
            AND srg.principal_kind = 'group'
            AND srg.principal_id = sga.group_id
       )
  `)

  // 3) merge(legacy 行已经在 SQL 端用 NOT EXISTS 排除掉与新表重复的
  //    principal,这里直接拼即可)
  const groups: SpaceGroupGrant[] = []
  const users: SpaceUserGrant[] = []
  for (const r of newRows.rows) {
    // pg driver returns bigint as string by default. Coerce to number —
    // the column holds Date.now() ms timestamps which are safely within
    // Number.MAX_SAFE_INTEGER.
    const grantedAt = typeof r.grantedAt === 'string' ? Number(r.grantedAt) : r.grantedAt
    if (r.principalKind === 'group') {
      groups.push({
        groupId: r.principalId,
        role: r.role,
        grantedBy: r.grantedBy,
        grantedAt,
      })
    } else {
      users.push({
        userId: r.principalId,
        role: r.role,
        grantedBy: r.grantedBy,
        grantedAt,
      })
    }
  }
  // legacy 行的 grantedBy/grantedAt 用 null/0 表示「来自老系统」
  for (const r of legacyRows.rows) {
    groups.push({
      groupId: r.groupId,
      role: 'editor',
      grantedBy: null,
      grantedAt: 0,
    })
  }

  // 排序
  groups.sort((a, b) => a.grantedAt - b.grantedAt || a.groupId.localeCompare(b.groupId))
  users.sort((a, b) => a.grantedAt - b.grantedAt || a.userId.localeCompare(b.userId))

  return { groups, users }
}

/**
 * 批量拉多个空间的 grants(用于 spaces 列表 N+1 优化)。
 *
 * 一次 SQL 拿全所有 grants,JS 端 group by spaceId。返回 Map 形式
 * (缺失 key 表示该 space 无 grant,UI 渲染空 groups/users 即可)。
 *
 * 共享同一段 `legacy_complement` 逻辑(把没有新表覆盖的 legacy
 * space_group_access 补成 role='editor' 的 group grant),只是
 * 在 SQL 端用 LEFT JOIN + CASE 表达:
 *
 *   SELECT srg.space_id, srg.principal_kind, srg.principal_id, srg.role,
 *          srg.granted_by, srg.granted_at
 *     FROM space_role_grants srg
 *    WHERE srg.space_id = ANY($1)
 *   UNION ALL
 *   SELECT sga.space_id, 'group'::text, sga.group_id, 'editor'::text, NULL, 0
 *     FROM space_group_access sga
 *    WHERE sga.space_id = ANY($1)
 *      AND NOT EXISTS (
 *        SELECT 1 FROM space_role_grants srg
 *         WHERE srg.space_id = sga.space_id
 *           AND srg.principal_kind = 'group'
 *           AND srg.principal_id = sga.group_id
 *      )
 */
export async function loadGrantsForSpaces(
  spaceIds: string[],
): Promise<Map<string, SpaceGrants>> {
  const result = new Map<string, SpaceGrants>()
  if (spaceIds.length === 0) return result
  for (const id of spaceIds) {
    result.set(id, { groups: [], users: [] })
  }
  const idList = sql.join(spaceIds.map((id) => sql`${id}`), sql`, `)
  const rows = await db.execute<{
    spaceId: string
    principalKind: 'user' | 'group'
    principalId: string
    role: SpaceRole
    grantedBy: string | null
    grantedAt: number
  }>(sql`
    SELECT srg.space_id   AS "spaceId",
           srg.principal_kind AS "principalKind",
           srg.principal_id   AS "principalId",
           srg.role,
           srg.granted_by     AS "grantedBy",
           srg.granted_at     AS "grantedAt"
      FROM space_role_grants srg
     WHERE srg.space_id IN (${idList})
    UNION ALL
    SELECT sga.space_id, 'group'::text, sga.group_id, 'editor'::text, NULL, 0
      FROM space_group_access sga
     WHERE sga.space_id IN (${idList})
       AND NOT EXISTS (
         SELECT 1 FROM space_role_grants srg
          WHERE srg.space_id = sga.space_id
            AND srg.principal_kind = 'group'
            AND srg.principal_id = sga.group_id
       )
  `)
  for (const r of rows.rows) {
    const g = result.get(r.spaceId)
    if (!g) continue
    // pg driver returns bigint as string by default. Coerce to number —
    // the column holds Date.now() ms timestamps which are safely within
    // Number.MAX_SAFE_INTEGER (~9e15, current epoch ms ≈ 1.78e12).
    const grantedAt = typeof r.grantedAt === 'string' ? Number(r.grantedAt) : r.grantedAt
    if (r.principalKind === 'group') {
      g.groups.push({
        groupId: r.principalId,
        role: r.role,
        grantedBy: r.grantedBy,
        grantedAt,
      })
    } else {
      g.users.push({
        userId: r.principalId,
        role: r.role,
        grantedBy: r.grantedBy,
        grantedAt,
      })
    }
  }
  for (const g of result.values()) {
    g.groups.sort((a, b) => a.grantedAt - b.grantedAt || a.groupId.localeCompare(b.groupId))
    g.users.sort((a, b) => a.grantedAt - b.grantedAt || a.userId.localeCompare(b.userId))
  }
  return result
}

/* ─── Phase B: page-level restrictions ────────────────────────────── */

/**
 * 一个 page 的 view/edit allow-list。空 map = 该 page 该 kind 没限制
 * (回退到 space 角色判定)。
 */
export interface PageAllowList {
  users: Set<string>
  groups: Set<string>
}

/** 单 page 的限制 view。空数组 = 该 kind 没限制(回退到 space 角色)。 */
export interface PageRestrictionsView {
  view: PageAllowList
  edit: PageAllowList
}

/** 一个 page 的最小元信息(loadPageMeta 返回的形状)。 */
export interface PageMeta {
  id: string
  spaceId: string
  parentId: string | null
  authorId: string
  /** Date.now() ms;null = live page,非 null = 已在回收站。
   *  Phase B 的 restrictions 路由需要这个判断 trashed page → 404。 */
  deletedAt: number | null
}

/**
 * 列表路径(GET /api/pages)的 SQL 过滤 —— 在 SELECT WHERE 里直接判 page
 * 可读性,避免 N+1 跑 canReadPage。
 *
 * 覆盖三类可读情况(OR):
 *   1. **admin**:短路 TRUE。
 *   2. **author**:本用户是 page 作者(author 始终 full,不进 allow-list)。
 *   3. **无 view 限制 + 空间可读**:NOT EXISTS 走 page_restrictions_page_idx,
 *      命中就走 canReadSpace 的角色判定(由调用方 space filter 兜底)。
 *   4. **有 view 限制 + 在 allow-list 内**:EXISTS(page_restrictions
 *      WHERE kind='view' AND (user 命中 OR group 命中))。group 命中
 *      通过 IN 子查询 user_group_members(user_id=me) 解析。
 *
 * 已知局限:**不处理 view 沿父链继承**。父页有 view 限制 → 子页即便
 * 不直接受限制,在 list 路径上也可能仍出现(子页不在父链的 allow-list
 * 里时),需要用户点开时由 canReadPage 在 GET /:id 路径返回 404。这
 * 是 v0 的可接受折衷;后续可以做"denormalized 父链 view-inheritance
 * JSONB 列 + trigger"优化,把 BFS 收进 SQL。子页的入口级 404 兜底不
 * 会出现数据错位,只是 sidebar 多 1 个不能点的项 —— 用户能感知但不致命。
 */
export function pageReadableDirectFilter(me: Principal): SQL {
  if (me.isAdmin) return sql`TRUE`
  if (me.kind !== 'user') return sql`FALSE`
  return sql`(
    ${pages.authorId} = ${me.id}
    OR NOT EXISTS (
      SELECT 1 FROM ${pageRestrictions}
      WHERE ${pageRestrictions.pageId} = ${pages.id}
        AND ${pageRestrictions.kind} = 'view'
    )
    OR EXISTS (
      SELECT 1 FROM ${pageRestrictions}
      WHERE ${pageRestrictions.pageId} = ${pages.id}
        AND ${pageRestrictions.kind} = 'view'
        AND (
          (${pageRestrictions.principalKind} = 'user' AND ${pageRestrictions.principalId} = ${me.id})
          OR (${pageRestrictions.principalKind} = 'group' AND ${pageRestrictions.principalId} IN (
            SELECT ${userGroupMembers.groupId} FROM ${userGroupMembers}
            WHERE ${userGroupMembers.userId} = ${me.id}
          ))
        )
    )
  )`
}

/** 加载一个 page 的最小元信息(id / spaceId / parentId / authorId / deletedAt),
 *  不存在返回 null。trashed page 也照样返回(由调用方按需 404 短路)。 */
export async function loadPageMeta(pageId: string): Promise<PageMeta | null> {
  const [row] = await db
    .select({
      id: pages.id,
      spaceId: pages.spaceId,
      parentId: pages.parentId,
      authorId: pages.authorId,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .where(sql`${pages.id} = ${pageId}`)
    .limit(1)
  if (!row || row.spaceId === null) return null
  // pg driver returns bigint as string by default. Coerce to number.
  const deletedAt = typeof row.deletedAt === 'string' ? Number(row.deletedAt) : row.deletedAt
  return { id: row.id, spaceId: row.spaceId, parentId: row.parentId, authorId: row.authorId, deletedAt }
}

/**
 * 加载一个 page 的 view + edit allow-list(一次 SQL 拿两种 kind)。
 *
 *  - 返回的 view.groups / view.users 是 Set,空 Set = 没限制。
 *  - 注意 page_restrictions 行可能引用 deleted user / deleted group,但
 *    effectiveUserGroupMemberships 已经过滤;allow-list 本身保留作为
 *    audit 记录(由 admin 端 sweep)。
 */
export async function loadPageRestrictions(
  pageId: string,
  spaceId: string,
): Promise<PageRestrictionsView> {
  const result = await db.execute<{
    kind: 'view' | 'edit'
    principalKind: 'user' | 'group'
    principalId: string
  }>(sql`
    SELECT kind, principal_kind AS "principalKind", principal_id AS "principalId"
      FROM page_restrictions
     WHERE page_id = ${pageId} AND space_id = ${spaceId}
  `)
  const view: PageAllowList = { users: new Set(), groups: new Set() }
  const edit: PageAllowList = { users: new Set(), groups: new Set() }
  for (const r of result.rows) {
    const list = r.kind === 'view' ? view : edit
    if (r.principalKind === 'user') list.users.add(r.principalId)
    else list.groups.add(r.principalId)
  }
  return { view, edit }
}

/** 一次性「当前用户在哪几个 group 里」。admin / anonymous 短路。 */
async function userGroupIds(me: Principal): Promise<Set<string>> {
  if (me.isAdmin || me.kind === 'anonymous') return new Set()
  const result = await db.execute<{ groupId: string }>(sql`
    SELECT group_id AS "groupId" FROM user_group_members WHERE user_id = ${me.id}
  `)
  return new Set(result.rows.map((r) => r.groupId))
}

/** S 是否在该 allow-list 内(user 直接命中,或 S 的任一 group 命中)。 */
function isInAllowList(
  me: Principal,
  myGroupIds: Set<string>,
  list: PageAllowList,
): boolean {
  if (me.kind !== 'user') return false
  if (list.users.has(me.id)) return true
  for (const g of myGroupIds) {
    if (list.groups.has(g)) return true
  }
  return false
}

/**
 * 解析 view 限制(沿父链 BFS 累计 allow-list)。
 *
 * 关键不变量(对齐 Confluence):
 *   - 任一祖先有 view 限制 → 子页 view 默认收紧,子页必须满足该 allow-list
 *   - 没限制:沿父链上溯到 root,都没限制就回退到 canReadSpace
 *   - global admin + page 作者 始终短路 true(不受 view 限制约束)
 *   - visited 集合防 parent_id 循环(理论上 PATCH 已防,defensive)
 *
 * 性能:深度一般 < 10 层,O(depth) 个 SQL。depth cache(denormalized JSONB
 * 列 + trigger)留后续优化。
 */
export async function effectivePageReadAccess(
  me: Principal,
  pageId: string,
  spaceId: string,
): Promise<boolean> {
  // global admin 始终 true(覆盖 personal space;个人空间 read-only 写入
  // 仍由 assertAdminNotWritingPersonalSpace 在路由层挡)。
  if (me.isAdmin) return true
  // anonymous 永远走 /api/public/pages/:token 那条独立路由(挂在
  // requireAuth 之前,自管 share 校验);这里不接,确保「匿名读」只能
  // 通过显式 share,不会从别的口子漏进来。
  if (me.kind !== 'user') return false
  // page 作者本人:始终能读自己写的页(view 限制也不挡作者自己)
  const meta = await loadPageMeta(pageId)
  if (meta?.authorId === me.id) return true

  const myGroupIds = await userGroupIds(me)
  const visited = new Set<string>()
  let cur: string | null = pageId
  while (cur && !visited.has(cur)) {
    visited.add(cur)
    // 用 cur 重新 load meta(取 parentId);首次 cur === pageId
    const nodeMeta: PageMeta | null = cur === pageId ? meta : await loadPageMeta(cur)
    if (!nodeMeta) break
    const { view } = await loadPageRestrictions(cur, nodeMeta.spaceId)
    const hasRestriction = view.users.size + view.groups.size > 0
    if (hasRestriction) {
      return isInAllowList(me, myGroupIds, view)
    }
    cur = nodeMeta.parentId
  }
  // 父链都没限制 → 回退到 space 角色
  return canReadSpace(me, spaceId)
}

/**
 * 解析 edit 限制(只约束本页,父链无关 —— Confluence 已知行为)。
 *
 *  - global admin + page 作者 始终 true(不受 edit 限制约束)
 *   - 有 edit 限制:S 必须在 allow-list 内
 *   - 无 edit 限制:回退到 canEditSpace
 */
export async function effectivePageEditAccess(
  me: Principal,
  pageId: string,
  spaceId: string,
  authorId: string,
): Promise<boolean> {
  if (me.isAdmin) return true
  if (me.kind !== 'user') return false
  // page 作者本人:始终能改自己写的页(edit 限制也不挡作者)
  if (authorId === me.id) return true

  const { edit } = await loadPageRestrictions(pageId, spaceId)
  if (edit.users.size + edit.groups.size > 0) {
    const myGroupIds = await userGroupIds(me)
    return isInAllowList(me, myGroupIds, edit)
  }
  return canEditSpace(me, spaceId)
}

/**
 * 主体能否读该 page(对外入口)。Phase B 后取代 `canAccessSpace` 的 page
 * 读取路径:从 canReadSpace 升级到 effectivePageReadAccess。
 *
 *  - admin 永远 true
 *   - 没限制:回退 canReadSpace(space 角色)
 *   - 有 view 限制:必须满足 allow-list
 */
export async function canReadPage(
  me: Principal,
  pageId: string,
  spaceId: string,
): Promise<boolean> {
  return effectivePageReadAccess(me, pageId, spaceId)
}

/**
 * 主体能否写该 page(对外入口)。Phase B 后取代 pages.ts 写路径的
 * canEditSpace 调用。
 *
 * 语义:**edit 权限蕴含 read 权限**(Confluence 行为) —— 不能编辑
 * 你看不到的页面,防止「暗箱修改」 / 「绕过 view 限制」的反直觉操作。
 *
 * 解析顺序(短路):
 *  1. admin:edit 短路 true;`canReadPage` 对 admin 也短路 true → AND
 *     后仍 true
 *  2. page 作者:edit 短路 true;`canReadPage` 在作者本人同样短路 true
 *     (作者始终能读自己写的页,不被 view 限制挡)→ AND 后仍 true
 *  3. 其他用户:edit 必须通过(effectivePageEditAccess),**并且** read
 *     必须通过(canReadPage,view 沿父链继承 + view allow-list 校验)
 *
 *  ⚠️ 这个函数假设 pageId 是真实存在的(用于 SQL 查 page_restrictions);
 *   404 短路 / admin 写 personal space 短路都已在调用方处理。
 */
export async function canEditPage(
  me: Principal,
  pageId: string,
  spaceId: string,
  authorId: string,
): Promise<boolean> {
  const canEdit = await effectivePageEditAccess(me, pageId, spaceId, authorId)
  if (!canEdit) return false
  return canReadPage(me, pageId, spaceId)
}

/* ─── Phase A.5: legacy 写入时迁移 ────────────────────────────── */

/**
 * 「写入时迁移」hook:当用户通过新的 permissions 端点为某 space 写入某
 * 个 group grant 时,把同 (space_id, group_id) 的 legacy
 * space_group_access 行就地迁成 space_role_grants role='editor'。
 *
 * 设计:
 *  - **同事务**:调用方必须在 `db.transaction(tx => …)` 里。helper 接
 *    tx 形参,跟主写同一个 tx,业务 rollback 时 legacy 删 / 新表插 一起
 *    回滚,不会留半截。
 *  - **idempotent**:SQL 端 `ON CONFLICT DO NOTHING` —— 若主 INSERT 已
 *    先于本 helper 写入同一 (space, group, 'group') 行(可能 role 是
 *    'viewer' / 'admin'),helper 的 INSERT 直接被 unique index 挡掉,
 *    不覆盖用户选的角色。
 *  - **必须 delete legacy 行**:不删的话 `effectiveSpaceRole` 的 UNION
 *    会双重计算(legacy='editor' + 新表行的 role,SQL 的 MAX 取较大者,
 *    但审计 / UI 会看到两份 grant)。
 *
 * 调用顺序:helper 必须在调用方主 INSERT 之后跑。主 INSERT 用
 * `onConflictDoUpdate`(可以更新 role),helper 用 `onConflictDoNothing`
 * (只在 legacy 残留时补 role='editor' 默认值) —— 这样如果用户指定
 * viewer / admin,主 POST 的 role 优先。
 *
 * 已知边界:`migrateLegacyGroupGrant` 不挂 PUT full-replace handler —
 * `loadGrantsForSpace` 用 `NOT EXISTS` 把 legacy 行在 UI 列表里去重,
 * PUT 保存时这些 legacy 行被 `delete-all + bulk insert` 重新建为新表
 * 行(同 role 'editor'),legacy 行**仍留在 space_group_access**(PUT 只
 * 清新表)但贡献和已迁的新表行完全等价。彻底收尾由 follow-up 全量
 * migration job 负责。
 */
export async function migrateLegacyGroupGrant(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  spaceId: string,
  groupId: string,
  grantIdForNewRow: string,
  grantedBy: string,
  grantedAt: number,
): Promise<void> {
  // 1) legacy 行存在才做迁移 —— SELECT 一次,无 legacy 时整个 helper
  //    是 no-op,零成本。
  const existing = await tx
    .select({ spaceId: spaceGroupAccess.spaceId })
    .from(spaceGroupAccess)
    .where(
      and(
        eq(spaceGroupAccess.spaceId, spaceId),
        eq(spaceGroupAccess.groupId, groupId),
      ),
    )
    .limit(1)
  if (existing.length === 0) return

  // 2) INSERT 新 role='editor' 行 —— onConflictDoNothing 已经从
  //    space_role_grants_space_principal_uq 保证了「已经在新表里就别
  //    覆盖」。如果主 POST 已经先于这个 helper 跑过(onConflictDoUpdate
  //    把 role 设成调用方传入的值),这里就什么都不做,legacy 行照样在
  //    —— 不理想 —— 所以 helper 必须在主 INSERT 之后跑(由调用方约定)。
  await tx
    .insert(spaceRoleGrants)
    .values({
      id: grantIdForNewRow,
      spaceId,
      principalKind: 'group',
      principalId: groupId,
      role: 'editor',
      grantedBy,
      grantedAt,
    })
    .onConflictDoNothing()

  // 3) 删 legacy 行 —— 即使 INSERT 因为 conflict 被跳过,删 legacy 让
  //    effectiveSpaceRole 只剩新表那一行,审计 / UI 列表不再重复。
  await tx
    .delete(spaceGroupAccess)
    .where(
      and(
        eq(spaceGroupAccess.spaceId, spaceId),
        eq(spaceGroupAccess.groupId, groupId),
      ),
    )
}
