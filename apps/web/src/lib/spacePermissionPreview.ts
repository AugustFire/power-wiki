/**
 * Effective role preview — P1-4 Phase 3.2。
 *
 * 后端在 `apps/api/src/routes/spacePermissions.ts` 的 members 端点用 SQL
 * 一次聚合所有 grant(直接 user + N 个 group),按 MAX-rank 合并得出
 * effective role。前端在 grants tab 改待保存草稿时,需要在保存条上方
 * 提示「谁的权限将变化 / 谁会失去访问权」—— 不能每次都 round-trip 一次
 * 后端,要在前端用同一份规则做 dry-run 预览。
 *
 * 关键约束:
 *  - 角色 rank:viewer(1) < editor(2) < admin(3),对齐后端 permissions.ts
 *    ROLE_RANK 表 —— 改后端时必须同步这里。
 *  - 多来源合并:同一个 user 通过 group A 拿到 editor、通过 group B 拿到
 *    viewer、再有直接 grant admin,最终 effective = admin(MAX)。
 *  - 不引入跨空间概念:本工具只看一个 space 的 grants 集合。
 *  - 不查后端:仅靠传入的 grants + allUsers + allGroups 数据做纯计算。
 *    真正的保存仍由后端在 PUT 端点里写库 + audit。
 *  - group 成员数据来源:UserGroup.memberIds(由 `api.admin.groups.get`
 *    单条端点返回,list 端点不带)。grants tab 在挂载时按需把 allGroups
 *    升级到含 memberIds 的版本,见 SpaceGrantsTab 的 fetchGroupMembers。
 */
import type {
  SpaceGrants,
  SpaceRole,
  User,
  UserGroup,
} from '@power-wiki/shared'

const ROLE_RANK: Record<SpaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

function roleRank(r: SpaceRole): number {
  return ROLE_RANK[r]
}

function rankToRole(rank: number): SpaceRole | null {
  if (rank >= ROLE_RANK.admin) return 'admin'
  if (rank >= ROLE_RANK.editor) return 'editor'
  if (rank >= ROLE_RANK.viewer) return 'viewer'
  return null
}

/**
 * 一次 grants 集合 → 该 user 的 effective role(纯前端,跟后端
 * SQL 行为一致)。不传 allGroups / allUsers 时只看直接 user grant;
 * 全传时计算「直接 + 所有继承 group」的 MAX。
 *
 * @param userId 要查 effective 的 user
 * @param grants 草稿或已保存的 grants 集合
 * @param allGroups 用于展开 group 成员;省略时只算直接 grant
 * @param allUsers 仅校验存在性,不影响计算结果
 */
export function effectiveRoleForUser(
  userId: string,
  grants: SpaceGrants,
  allGroups?: UserGroup[],
  allUsers?: User[],
): SpaceRole | null {
  void allUsers
  let rank = 0
  for (const u of grants.users) {
    if (u.userId === userId && roleRank(u.role) > rank) {
      rank = roleRank(u.role)
    }
  }
  if (allGroups) {
    const userGroupIds = new Set(
      allGroups
        .filter((g) => g.memberIds?.includes(userId))
        .map((g) => g.id),
    )
    for (const g of grants.groups) {
      if (userGroupIds.has(g.groupId) && roleRank(g.role) > rank) {
        rank = roleRank(g.role)
      }
    }
  }
  return rankToRole(rank)
}

/**
 * 草稿保存前预览:对比 `originalGrants` 与 `nextGrants`,返回
 * 每个 user 的角色变化。
 *
 * 输出形状(给 UI 直接 for 渲染):
 *   - promoted:   from=viewer|editor, to=editor|admin
 *   - demoted:    from=admin|editor, to=editor|viewer
 *   - lostAccess: 原来有 role (任意档),现在 null
 *   - gainedAccess: 原来 null,现在有 role
 *   - unchanged:  角色相同的 user
 *
 * 每个 user 都用 user 对象(id + name + email)而非裸 id,UI 直接展示。
 *
 * 注意:这里「unchanged」是按 effective role 比较,不是按 grants 集合
 * 字面比较 —— 删 A 加 B、effective role 不变,就归为 unchanged。这是
 * 跟后端 members 端点输出的同语义。
 */
export interface MemberChange {
  user: User
  fromRole: SpaceRole | null
  toRole: SpaceRole | null
}

export interface RoleDiff {
  promoted: MemberChange[]
  demoted: MemberChange[]
  lostAccess: MemberChange[]
  gainedAccess: MemberChange[]
  unchanged: User[]
}

export function diffEffectiveRoles(
  originalGrants: SpaceGrants,
  nextGrants: SpaceGrants,
  allGroups: UserGroup[],
  allUsers: User[],
): RoleDiff {
  const userById = new Map(allUsers.map((u) => [u.id, u]))
  // 收集两个 grants 集合中出现过的 user id 集合(去重)
  const touched = new Set<string>()
  for (const g of nextGrants.users) touched.add(g.userId)
  for (const g of originalGrants.users) touched.add(g.userId)
  for (const g of nextGrants.groups) {
    const grp = allGroups.find((x) => x.id === g.groupId)
    if (grp?.memberIds) for (const id of grp.memberIds) touched.add(id)
  }
  for (const g of originalGrants.groups) {
    const grp = allGroups.find((x) => x.id === g.groupId)
    if (grp?.memberIds) for (const id of grp.memberIds) touched.add(id)
  }

  const diff: RoleDiff = {
    promoted: [],
    demoted: [],
    lostAccess: [],
    gainedAccess: [],
    unchanged: [],
  }

  for (const userId of touched) {
    const user = userById.get(userId)
    if (!user) continue
    const fromRole = effectiveRoleForUser(userId, originalGrants, allGroups, allUsers)
    const toRole = effectiveRoleForUser(userId, nextGrants, allGroups, allUsers)
    if (fromRole === toRole) {
      if (toRole !== null) diff.unchanged.push(user)
      continue
    }
    const change: MemberChange = { user, fromRole, toRole }
    if (fromRole === null && toRole !== null) {
      diff.gainedAccess.push(change)
    } else if (fromRole !== null && toRole === null) {
      diff.lostAccess.push(change)
    } else if (fromRole && toRole && roleRank(toRole) > roleRank(fromRole)) {
      diff.promoted.push(change)
    } else if (fromRole && toRole && roleRank(toRole) < roleRank(fromRole)) {
      diff.demoted.push(change)
    }
  }

  return diff
}

/**
 * Diff 统计:数字 + label,直接给 UI 「N 人升级 / M 人降级 / K 人失去
 * 访问权」 summary 用。空 diff 返回 null(consumer 隐藏整条 banner)。
 */
export function summarizeDiff(diff: RoleDiff): {
  promoted: number
  demoted: number
  lostAccess: number
  gainedAccess: number
  hasChanges: boolean
} {
  const hasChanges =
    diff.promoted.length +
    diff.demoted.length +
    diff.lostAccess.length +
    diff.gainedAccess.length >
    0
  return {
    promoted: diff.promoted.length,
    demoted: diff.demoted.length,
    lostAccess: diff.lostAccess.length,
    gainedAccess: diff.gainedAccess.length,
    hasChanges,
  }
}
