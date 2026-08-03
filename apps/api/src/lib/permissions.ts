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
 *     作者本人 + global admin + space admin 始终 full(短路,不走 allow-list
 *     校验)—— 2026-08-03 旅程 B 收口:用户 case「A 把 view 限制设成只让自己」
 *     不应缩小其他 space-admin 的访问权,否则共享空间退化成「A 一言堂」。
 *     effectivePageReadAccess / effectivePageEditAccess / pageReadableDirectFilter
 *     三处都加 canAdminSpace bypass。
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
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import type { AnyTx } from './auditLog'
import {
  pageRestrictions,
  pages,
  spaceGroupAccess,
  spaceRoleGrants,
  userGroupMembers,
  userGroups,
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

/* ─── SpaceAccessSource —— 授权来源(P1-14)─────────────────────────
 * 一个 subject 在某 space 上的有效角色可能由多条 grant 共同决定:
 *   - direct grant(user → space_role_grants,principal_kind='user')
 *   - 组授权(user 在组里 + 组 → space_role_grants,principal_kind='group')
 *   - legacy 组(user 在组里 + 旧 space_group_access 行)
 * effective role = max(所有 sources),但用户需要看到「是哪些来源」
 * 才能判断「我可以删除这条直接授权来缩窄权限吗」「我在工程组里
 * 就能进,要把工程组从空间里 remove 吗」。本结构给前端足够信息
 * 渲染「via 工程组 / 直接授权 / 两路合一」。
 *
 * role 字段对 owner / legacy_group 都被强约束:owner 是 personal
 * space 专属、role 始终生效;legacy_group 跟 lib/permissions.ts
 * effectiveSpaceRole 行为对齐(视作 'editor')。*/
export interface SpaceAccessSource {
  /** direct / group(Phase A) / legacy_group(旧 space_group_access) / owner(personal space)
   * —— owner 跟其他三类互斥(kind='personal' 的空间只会有 owner)。 */
  kind: 'direct' | 'group' | 'legacy_group' | 'owner'
  /** 该 source 授予的角色。owner 永远 'admin';legacy_group 永远 'editor';
   * direct + group 带 grants 表里的实际值。 */
  role: SpaceRole
  /** 组授权专属:组的 id(用于前端跳 GroupEditView)。direct / owner 无此字段。 */
  groupId?: string
  /** 组授权专属:组当前的名字(denormalize,前端不用再拉 user_groups)。
   * 找不到时返回 '' 空串(组已被删或 pg-* 个人组,前端视情况隐藏)。*/
  groupName?: string
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
 *   - admin:返回 'admin'(包括 personal space)。**写「他人」personal
 *     space 的 403 由路由层的 `assertCanWriteToPersonalSpace` /
 *     `assertAdminNotWritingPersonalSpace` 拦截,不在这个文件里**(admin
 *     写「own」personal 是允许的,2026-07-29 起)。
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
 * P1-1: 查空间是否归档。一行 SELECT,共享团队的 archived 状态。
 *
 * 性能:写入路径(canEditSpace / canEditPage)每条 page 写大约多 1 个
 * SELECT,代价 1-2ms,可接受;读路径不调(读不受归档影响)。高频 list
 * 读路径反而因为 archived_at 已删除的 list 走更窄的 WHERE,反而更快。
 */
export async function isSpaceArchived(spaceId: string): Promise<boolean> {
  const rows = await db.execute<{ archivedAt: number | null }>(sql`
    SELECT archived_at AS "archivedAt" FROM spaces WHERE id = ${spaceId} LIMIT 1
  `)
  const v = rows.rows[0]?.archivedAt
  return v !== null && v !== undefined
}

/**
 * 主体能否编辑该空间的内容(创建/修改/删除页面、附件、评论)。
 *
 *  - admin:永远 true。**「他人」personal space 的 403 拦截由
 *    `assertCanWriteToPersonalSpace`(优先)或
 *    `assertAdminNotWritingPersonalSpace` 在调用 canEditSpace
 *    之后独立完成**,不在这层做。admin 写 own personal 走个人空间 owner-id
 *    矩阵(2026-07-29 起 P0-3 放宽)。
 *  - viewer:false。editor / admin:true。
 *  - **archived(P1-1)**:永远 false —— 归档后 team space 默认禁止新增
 *    和编辑,包含 admin(spec: admin 想改先 unarchive)。personal space
 *    永远不会被归档(CHECK spaces_archived_kind_check 限制),不影响。
 *    由于这是 hot path 同步多一个 SELECT,需要确保 archived_at 的 SELECT
 *    走 spaces_pkey(主键索引) —— 见 isSpaceArchived 的 SQL。
 */
export async function canEditSpace(me: Principal, spaceId: string): Promise<boolean> {
  if (me.kind === 'anonymous') return false
  if (await isSpaceArchived(spaceId)) return false
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
 *     写「他人」personal space 的拦截在路由层 assertCanWriteToPersonalSpace,
 *     不影响 role 计算。admin 写 own personal 走矩阵允许(2026-07-29 起)。
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

/* ─── getSpaceAccessSourcesForUser —— P1-14 ──────────────────────────
 * 返回 subject(userId) 在每个 space 上有哪些 grant 来源。
 *
 * 实现:
 *   1) space_role_grants 里 (user → space) 的 direct grant —— → direct source
 *   2) space_role_grants 里 (group ∈ userGroupMembers(userId) → space) —— → group source
 *   3) legacy space_group_access 里 (group ∈ userGroupMembers(userId) → space) —— → legacy_group source
 *      (与 effectiveSpaceRole 行为对齐,记为 editor)
 *   4) 个人空间 owner —— 由 caller 在 space 是 personal 时单独 push。
 *      跟 (1-3) 互斥,本函数不处理。
 *
 * SQL 走 raw 一条 query,UNION + JOIN。返回 groupId 顺序稳定(id ASC)。
 * groupName 通过一次 batched inArray 拉取(避免 N+1)。
 *
 * Map 永远包含传入的每个 spaceId(空数组表示无授权)。*/
export async function getSpaceAccessSourcesForUser(
  userId: string,
  spaceIds: string[],
): Promise<Map<string, SpaceAccessSource[]>> {
  const out = new Map<string, SpaceAccessSource[]>()
  for (const id of spaceIds) out.set(id, [])
  if (spaceIds.length === 0) return out

  const idList = sql.join(spaceIds.map((id) => sql`${id}`), sql`, `)

  // Phase A grants + legacy grants UNION,一条 SQL 全拿,GROUP BY 聚合前按
  // (spaceId, principalKind, principalId) 二维排序用于 dedupe 复用
  // Phase A group 跟 legacy_group(同组可能两条):优先 Phase A,后者在前
  // 面 dedupe 里被踢掉 —— groupId 一致就只保留 Phase A 行(角色更准确)。
  const result = await db.execute<{
    spaceId: string
    srcKind: 'phase_a' | 'legacy' | null
    principalKind: 'user' | 'group' | 'legacy_group' | null
    principalId: string | null
    role: string | null
  }>(sql`
    SELECT * FROM (
      SELECT g.space_id AS "spaceId",
             'phase_a'::text AS "srcKind",
             g.principal_kind AS "principalKind",
             g.principal_id AS "principalId",
             g.role AS role
        FROM space_role_grants g
        WHERE g.space_id IN (${idList})
          AND ((g.principal_kind = 'user' AND g.principal_id = ${userId})
               OR (g.principal_kind = 'group'
                   AND g.principal_id IN (
                     SELECT group_id FROM user_group_members WHERE user_id = ${userId}
                   )))
      UNION ALL
      SELECT sga.space_id AS "spaceId",
             'legacy'::text AS "srcKind",
             'legacy_group'::text AS "principalKind",
             sga.group_id AS "principalId",
             'editor'::text AS role
        FROM space_group_access sga
        JOIN user_group_members ugm ON sga.group_id = ugm.group_id
        WHERE sga.space_id IN (${idList}) AND ugm.user_id = ${userId}
    ) raw
    ORDER BY "spaceId", "srcKind", "principalKind", "principalId"
  `)

  // Collect groupIds once for batch name lookup.
  const groupIds = new Set<string>()
  for (const r of result.rows) {
    if (
      (r.srcKind === 'phase_a' && r.principalKind === 'group') ||
      r.principalKind === 'legacy_group'
    ) {
      if (r.principalId) groupIds.add(r.principalId)
    }
  }
  const groupNameById = new Map<string, string>()
  if (groupIds.size > 0) {
    const rows = await db
      .select({ id: userGroups.id, name: userGroups.name })
      .from(userGroups)
      .where(inArray(userGroups.id, [...groupIds]))
    for (const r of rows) groupNameById.set(r.id, r.name)
  }

  // Dedupe:同一 (spaceId, groupId) 不重复添加 —— Phase A group 优先,
  // legacy_group 同组同 space 不会再被推入。
  const seen = new Set<string>()
  for (const r of result.rows) {
    let source: SpaceAccessSource
    if (r.srcKind === 'phase_a' && r.principalKind === 'user') {
      source = {
        kind: 'direct',
        role: rankToRole(ROLE_RANK[r.role as SpaceRole] ?? 0) ?? 'viewer',
      }
    } else if (r.srcKind === 'phase_a' && r.principalKind === 'group' && r.principalId) {
      const key = `${r.spaceId}:${r.principalId}`
      if (seen.has(key)) continue
      seen.add(key)
      source = {
        kind: 'group',
        role: rankToRole(ROLE_RANK[r.role as SpaceRole] ?? 0) ?? 'viewer',
        groupId: r.principalId,
        groupName: groupNameById.get(r.principalId) ?? '',
      }
    } else if (r.principalKind === 'legacy_group' && r.principalId) {
      // 已 dedupe 过的 phase_a group 跳过 legacy
      const key = `${r.spaceId}:${r.principalId}`
      if (seen.has(key)) continue
      seen.add(key)
      source = {
        kind: 'legacy_group',
        role: 'editor',
        groupId: r.principalId,
        groupName: groupNameById.get(r.principalId) ?? '',
      }
    } else {
      continue
    }
    out.get(r.spaceId)?.push(source)
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
 *
 * 第二参数可选:tx(drizzle transaction 句柄)。传入 tx 时所有 SQL 走
 * 事务连接,看到的是 in-tx 状态;不传默认走 `db.execute` 全局连接,
 * 只能看到已 committed 状态。PUT /permissions 的 diff 算法需要在事务内
 * 拍「写完之后的快照」,必须用 tx 避免「拿不到本事务写入」的脏读。
 */
export async function loadGrantsForSpace(
  spaceId: string,
  executor: typeof db | AnyTx = db,
): Promise<SpaceGrants> {
  // 1) space_role_grants 全部行
  const newRows = await executor.execute<{
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
  const legacyRows = await executor.execute<{ groupId: string }>(sql`
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

/** 一个 page 的最小元信息(loadPageMeta 返回的形状)。
 *  2026-08-03 P1-3 起增加 inheritViewRestrictions(对应 pages.inherit_view_restrictions
 *  列)和 title(供 findInheritedViewSource 沿父链 walk 时附带在
 *  inheritedFrom DTO 里返回,避免再发一次 SELECT)。所有现存的 loadPageMeta
 *  调用点都通过 PageMeta 这个 interface 拿到这些字段 —— 没有 caller 需要
 *  改写,只是 PageMeta 字段更多而已。
 *  PageMetaWithInherit 是历史 alias,留给 Phase B 之前已经显式 import 这个
 *  名字的代码(目前已经全部统一到 PageMeta,这个 alias 保留以防外部代码)。 */
export interface PageMeta {
  id: string
  spaceId: string
  parentId: string | null
  authorId: string
  /** 页面标题 —— findInheritedViewSource 用它组装 inheritedFrom {pageId, title}
   *  DTO,前端 dialog 直接渲染不需要再发请求。 */
  title: string
  /** Date.now() ms;null = live page,非 null = 已在回收站。
   *  Phase B 的 restrictions 路由需要这个判断 trashed page → 404。 */
  deletedAt: number | null
  /** 是否继承父级 view 限制(2026-08-03 P1-3)。见 findInheritedViewSource
   *  注释;pageReadableDirectFilter 也用它决定父链 walk 是否继续。 */
  inheritViewRestrictions: boolean
}

/** @deprecated 已合并到 PageMeta,保留 alias 避免外部 import 报错。 */
export type PageMetaWithInherit = PageMeta

/**
 * 列表路径(GET /api/pages)的 SQL 过滤 —— 在 SELECT WHERE 里直接判 page
 * 可读性,避免 N+1 跑 canReadPage。
 *
 * 覆盖三类可读情况(OR):
 *   1. **author**:本用户是 page 作者(author 始终 full,不进 allow-list)。
 *   2. **space-admin**:本用户在 page 所在空间是 admin(2026-08-03 加)。
 *      理由同 effectivePageReadAccess —— 不能用 view 限制反过来把空间
 *      管理员挡在列表外,否则他们的 sidebar 是「空白 + 能管限制」的反
 *      直觉状态。匹配 space_role_grants 上 role='admin' + (user 直接
 *      命中 OR user 所属 group 命中),legacy space_group_access 视为
 *      editor 这里不命中,但 admin / 编辑者不被影响(legacy 不参与 view
 *      限制 bypass,因为 legacy 是 editor 角色,不是 admin)。
 *   3. **整条父链 + 本页的所有 view 限制都在 allow-list 内**:NOT EXISTS
 *      一个 CTE,该 CTE 沿 pages.parent_id 上溯本页祖先链,链上每条 view
 *      限制都必须满足 user 直接命中或 user 所属组命中。空链(即本页无 view
 *      限制、祖先也无 view 限制)vacuously 通过 → 走调用方的 space filter
 *      兜底 canReadSpace。
 *
 * 性能:页深度一般 < 10,CTE 50 层硬上限(防御 parent_id 循环 + 极端深树);
 * 配合 (page_id, kind) 上的 page_restrictions_page_idx,单页 NOT EXISTS
 * 是 O(depth) 的 index seek,实测 list 端点 P95 不退化。space_role_grants
 * 是 page.space_id 上的 index seek,常数级。admin / author 是常数判定。
 *
 * 实现时间:2026-08-03,fix journey-B-1(替换 v0 折衷的「只查本页 view 限制」,
 * 父链 view 限制子页不再出现在 sidebar / 列表,避免「幽灵条目 → 404」反 UX)。
 * 同日新增 space-admin bypass(旅程 B 收口,见 effectivePageReadAccess 注释)。
 */
export function pageReadableDirectFilter(me: Principal): SQL {
  if (me.isAdmin) return sql`TRUE`
  if (me.kind !== 'user') return sql`FALSE`
  return sql`(
    ${pages.authorId} = ${me.id}
    OR EXISTS (
      SELECT 1 FROM space_role_grants srg
        WHERE srg.space_id = ${pages.spaceId}
          AND srg.role = 'admin'
          AND (
            (srg.principal_kind = 'user' AND srg.principal_id = ${me.id})
            OR (srg.principal_kind = 'group' AND srg.principal_id IN (
              SELECT ugm.group_id FROM user_group_members ugm
              WHERE ugm.user_id = ${me.id}
            ))
          )
    )
    OR NOT EXISTS (
      WITH RECURSIVE page_ancestors(id, depth) AS (
        SELECT ${pages.id}, 0
        UNION ALL
        SELECT p.parent_id, pa.depth + 1
        FROM pages p
        INNER JOIN page_ancestors pa ON p.id = pa.id
        INNER JOIN pages cur ON cur.id = pa.id
        WHERE pa.depth < 50
          AND p.parent_id IS NOT NULL
          AND cur.inherit_view_restrictions = TRUE
      )
      SELECT 1 FROM page_restrictions pr
      WHERE pr.kind = 'view'
        AND pr.page_id IN (SELECT id FROM page_ancestors)
        AND NOT (
          (pr.principal_kind = 'user' AND pr.principal_id = ${me.id})
          OR (pr.principal_kind = 'group' AND pr.principal_id IN (
            SELECT ugm.group_id FROM user_group_members ugm
            WHERE ugm.user_id = ${me.id}
          ))
        )
    )
  )`
}

/** 加载一个 page 的最小元信息(id / spaceId / parentId / authorId /
 *  deletedAt / inheritViewRestrictions),不存在返回 null。trashed page
 *  也照样返回(由调用方按需 404 短路)。
 *
 * inheritViewRestrictions 是 2026-08-03 P1-3 加的字段,findInheritedViewSource
 * + effectivePageReadAccess / pageReadableDirectFilter 都需要它来决策父
 * 链 walk 是否继续上溯。 */
export async function loadPageMeta(pageId: string): Promise<PageMetaWithInherit | null> {
  const [row] = await db
    .select({
      id: pages.id,
      spaceId: pages.spaceId,
      parentId: pages.parentId,
      authorId: pages.authorId,
      title: pages.title,
      deletedAt: pages.deletedAt,
      inheritViewRestrictions: pages.inheritViewRestrictions,
    })
    .from(pages)
    .where(sql`${pages.id} = ${pageId}`)
    .limit(1)
  if (!row || row.spaceId === null) return null
  // pg driver returns bigint as string by default. Coerce to number.
  const deletedAt = typeof row.deletedAt === 'string' ? Number(row.deletedAt) : row.deletedAt
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    authorId: row.authorId,
    title: row.title,
    deletedAt,
    inheritViewRestrictions: row.inheritViewRestrictions,
  }
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

/** PageMeta 上附加 inherit_view_restrictions 字段(2026-08-03 P1-3)已合并
 *  到 PageMeta 主定义,见上方 PageMeta 注释。这里删除独立的 extends 别名,
 *  避免重复 export。 */

/**
 * 沿父链 walk 找到本页 view 限制的「最近有效父级来源」。
 * 用于 GET /api/pages/:id/restrictions 的 inheritedFrom 字段 —— dialog
 * 解释「本页继承自父页面 X 的查看限制」+ 跳到父页限制面板的入口。
 *
 * 语义:
 *   - 本页 inherit_view_restrictions=false → null(本页是新规则的起点,
 *     不继承任何祖先)。
 *   - 沿 parentId 上溯,每页的 inherit_view_restrictions=true 才能继续
 *     上溯(等于 false 意味着该祖先自己就是新起点,前面的祖先不再约束)。
 *   - 找最近一条「本页 view 有 allow-list」的祖先,返回其 {pageId, title};
 *     链上无 view allow-list → null(本页是新规则的起点)。
 *
 * 性能:深度一般 < 10,O(depth) 个 SELECT(共享 effectivePageReadAccess 的
 * walk 路径,数据不变)。
 */
export async function findInheritedViewSource(
  pageId: string,
): Promise<{ pageId: string; title: string } | null> {
  // 第一步:确认本页本身的状态。本页 inherit=false → 无继承来源。
  const selfMeta = await loadPageMeta(pageId)
  if (!selfMeta) return null
  if (!selfMeta.inheritViewRestrictions) return null
  if (!selfMeta.parentId) return null

  // 第二步:从父开始 walk。visited 防 parent_id 循环。
  const visited = new Set<string>()
  let cur: string | null = selfMeta.parentId
  while (cur && !visited.has(cur)) {
    visited.add(cur)
    const parentMeta = await loadPageMeta(cur)
    if (!parentMeta) return null
    // parent 是不是 view 限制来源?
    const { view } = await loadPageRestrictions(parentMeta.id, parentMeta.spaceId)
    const hasView = view.users.size + view.groups.size > 0
    if (hasView) {
      return { pageId: parentMeta.id, title: parentMeta.title || '(无标题)' }
    }
    // parent 不是限制来源 → 看 parent 自己是不是新起点(inherit=false)
    if (!parentMeta.inheritViewRestrictions) return null
    // 继续上溯
    cur = parentMeta.parentId
  }
  return null
}

/**
 * 当前用户在该 page 享受哪些高权限保护(global admin / space admin /
 * page author)。三选多,用于 GET /api/pages/:id/restrictions 的
 * protectedSources 字段 —— dialog 解释「你作为 XX,不受本页限制约束」。
 *
 * 与 effectivePageReadAccess 的语义对齐:
 *   - globalAdmin:me.isAdmin(覆盖 personal space)
 *   - spaceAdmin:canAdminSpace(me, spaceId) 对非 global admin 的 user
 *   - pageAuthor:meta.authorId === me.id,且能在空间内(canReadSpace)
 */
export async function getProtectedSourcesForPage(
  me: Principal,
  pageId: string,
  spaceId: string,
): Promise<{ globalAdmin: boolean; spaceAdmin: boolean; pageAuthor: boolean }> {
  const meta = await loadPageMeta(pageId)
  const pageAuthor =
    !!meta && me.kind === 'user' && meta.authorId === me.id &&
    (await canReadSpace(me, spaceId))
  const spaceAdmin = me.kind === 'user' && !me.isAdmin && (await canAdminSpace(me, spaceId))
  return {
    globalAdmin: me.isAdmin,
    spaceAdmin,
    pageAuthor,
  }
}

/**
 * 解析 view 限制(沿父链 BFS 累计 allow-list)。
 *
 * 关键不变量(对齐 Confluence):
 *   - 任一祖先有 view 限制 → 子页 view 默认收紧,子页必须满足该 allow-list
 *   - 没限制:沿父链上溯到 root,都没限制就回退到 canReadSpace
 *   - global admin + page 作者 + space admin 始终短路 true(不受 view 限制约束)
 *   - visited 集合防 parent_id 循环(理论上 PATCH 已防,defensive)
 *
 * 性能:深度一般 < 10 层,O(depth) 个 SQL。depth cache(denormalized JSONB
 * 列 + trigger)留后续优化。
 *
 * Space admin 短路(2026-08-03 旅程 B 收口):用户提的 case「A 把 view 限制
 * 设成只让自己能读 + 编辑」不应缩小其他 space-admin 的访问权 —— 否则共享
 * 空间内的协作就退化成「A 一言堂」,违背 Confluence 的「限制是收窄默认
 * 行为,不覆盖高权限角色」语义。本函数 + pageReadableDirectFilter 同时加
 * canAdminSpace bypass。
 */
export async function effectivePageReadAccess(
  me: Principal,
  pageId: string,
  spaceId: string,
): Promise<boolean> {
  // global admin 始终 true(覆盖 personal space;个人空间「他人」写仍由
  // assertCanWriteToPersonalSpace / assertAdminNotWritingPersonalSpace 在
  // 路由层挡 —— admin 写 own personal 自 2026-07-29 起放行)。
  if (me.isAdmin) return true
  // anonymous 永远走 /api/public/pages/:token 那条独立路由(挂在
  // requireAuth 之前,自管 share 校验);这里不接,确保「匿名读」只能
  // 通过显式 share,不会从别的口子漏进来。
  if (me.kind !== 'user') return false
  // page 作者本人:被移除出空间后,author 短路失效 → 走完整流程(canReadSpace
  // false / view 限制父链 fail)→ 404。这是 E-1 (2026-08-03) 之前的安全
  // 语义偏离 —— author 在被移除出空间后仍能 GET/PATCH/share 自己写的页
  // 绕过空间隔离承诺。Plan A:author 短路**前**先 canReadSpace;仍在空间内
  // 才保留「无视 view 限制读自己页」的权限(原 author 特殊待遇)。
  const meta = await loadPageMeta(pageId)
  if (meta?.authorId === me.id && (await canReadSpace(me, spaceId))) return true
  // space admin(2026-08-03):受任一祖先 view 限制约束?不。理由同 global
  // admin —— 空间元数据 + 成员授权是他们的本职工作,view 限制是 metadata
  // 维度,不应该反而把「能管限制」的人挡在页外,否则他们看不见页面谈何
  // 管理限制。canAdminSpace 已经内含 canReadSpace 判定(grant 必须存在),
  // 不会把「不在空间内」的人误放进来。
  if (await canAdminSpace(me, spaceId)) return true

  const myGroupIds = await userGroupIds(me)
  const visited = new Set<string>()
  let cur: string | null = pageId
  while (cur && !visited.has(cur)) {
    visited.add(cur)
    // 用 cur 重新 load meta(取 parentId);首次 cur === pageId
    const nodeMeta: PageMeta | null = cur === pageId ? meta : await loadPageMeta(cur)
    if (!nodeMeta) break
    // inherit_view_restrictions=false → 本页是新规则的起点,不再上溯祖先。
    // 本页 view 限制仍按下面的 hasRestriction 判断(没限制 → fallthrough)。
    if (!nodeMeta.inheritViewRestrictions) {
      const { view } = await loadPageRestrictions(cur, nodeMeta.spaceId)
      if (view.users.size + view.groups.size > 0) {
        return isInAllowList(me, myGroupIds, view)
      }
      return canReadSpace(me, spaceId)
    }
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
 *  - global admin + page 作者 + space admin 始终 true(不受 edit 限制约束)
 *   - 有 edit 限制:S 必须在 allow-list 内
 *   - 无 edit 限制:回退到 canEditSpace
 *
 * Space admin 短路(2026-08-03):同 effectivePageReadAccess 注释里描述的
 * 「A 把 view 限制设成只让自己」case —— 同样不能用来缩小其他 space-admin
 * 的编辑权。
 *
 * 注意:space admin bypass **仍然受 archived 阻断**(P1-1 设计)。归档后整
 * 个空间禁止写 —— 包括 admin,「admin 想改先 unarchive」。canAdminSpace
 * 自己不查 archive(space-level metadata 写路径用 canAdminSpace 的 caller
 * 自己挡,见 spaces.ts 的 PATCH /api/spaces/:id handler);page-level edit
 * 这里必须显式查一次 archive,否则 spadmin 在归档空间里仍能 PATCH page
 * —— 跟 canEditSpace 的语义不一致。
 */
export async function effectivePageEditAccess(
  me: Principal,
  pageId: string,
  spaceId: string,
  authorId: string,
): Promise<boolean> {
  if (me.isAdmin) return true
  if (me.kind !== 'user') return false
  // P1-1:归档阻断先于所有 bypass —— archived → false 对所有人,含 admin。
  if (await isSpaceArchived(spaceId)) return false
  // page 作者本人:E-1 (2026-08-03) — author 短路**前**先 canEditSpace。
  // 被移除出空间 → canEditSpace false → 短路不生效 → 走完整流程(edit
  // 限制 / canEditSpace)→ false → PATCH 404。降级为 viewer 时也走同
  // 路径 —— canEditSpace false,author 不能编辑自己写的页(对齐 Confluence
  // 「空间角色决定可写性」语义,而不是 author 永远可写)。
  if (authorId === me.id && (await canEditSpace(me, spaceId))) return true
  // space admin 短路(2026-08-03):理由同 effectivePageReadAccess。空间
  // 管理员需要随时调整限制 / metadata,不应被自己的限制规则挡在外面。
  if (await canAdminSpace(me, spaceId)) return true

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
