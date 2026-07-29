/**
 * Frontend mirror of the personal-space write matrix (P0-3 + 2026-07-29
 * relaxation: admin can write OWN personal space).
 *
 * The backend `lib/personalSpaceGuard.ts` is the single source of truth for
 * who can write — but the frontend has its own short-circuit predicates
 * (canEdit / canManageRestrictions / canShare / canEditPage / canEditSpace)
 * that gate UI affordances like the Edit button, the ⋯ menu items, and
 * the publish/restrict dialogs. Those must stay aligned with the backend
 * or users see ghost affordances that 403 / 404 on click.
 *
 * 矩阵 (与 apps/api/src/lib/personalSpaceGuard.ts 头注释同步):
 *
 *   | 操作        | Owner=me | Admin × owner≠me | Member × owner≠me |
 *   |-------------|:--------:|:-----------------:|:-----------------:|
 *   | 写个人空间  | ✅       | ❌ (supervisor)   | ❌                |
 *
 * Admin 可以写自己 own 的 personal space(原本 P0-3 一刀切 block,admin
 * 即便 own 自己的 personal 也按 supervisor 处理;2026-07-29 改成"admin
 * 可以给自己写私人笔记",但 admin 不能动他人的 personal,继续走 supervisor
 * 语义 — 这是 Confluence 风格的「不对私人笔记越界」保护,不是「admin 不能
 * 写 personal」)。
 *
 * `viewerRole === 'editor'` 之类的空间角色不进 personal space —— personal
 * 永远只有 owner 一个 effective admin。
 *
 * 调用约定:
 *   - `resolvePersonalSpace(page.spaceId)` 先用 page.spaceId 在 spacesStore
 *     里查 kind + ownerId。查不到时返回 null —— 表示空间已被删/未加载,
 *     这种情况默认放行(backend 404 会兜底)。
 *   - `canWritePersonalSpace(me, space)` 返回 false 当且仅当:
 *       space.kind === 'personal' && space.ownerId !== me.id && me.role === 'admin'
 *     (即:目标 personal space 既不是我 own、我又是 admin → 拦截)
 *   - 调用方先算 canWritePersonalSpace,再叠加原来的 isAdmin / viewerRole /
 *     authorId 短路。
 */
import type { User } from '@power-wiki/shared'
import type { PageNode } from '@power-wiki/shared'
import { useSpacesStore } from '@/stores/spaces'

export interface SpaceRef {
  id: string
  /** Shared 是默认值 —— 老 SpaceDTO 不带 kind 字段(都是 shared)。 */
  kind?: 'personal' | 'shared'
  ownerId?: string | null
  /** 后端 Space 注入的 effective role(仅 shared space 有效;personal 永远 ='admin' if ownerId===me, 否则无权)。 */
  viewerRole?: 'viewer' | 'editor' | 'admin' | null
}

/** 从 spacesStore 查 space 元数据。查不到返回 null(空间不在当前用户的可见集内)。 */
export function resolvePersonalSpace(spaceId: string | null | undefined): SpaceRef | null {
  if (!spaceId) return null
  // 一次性 pin to 局部变量 —— Pinia 自动 unwrap 在 `.find` 链式访问里不
  // 触发,显式解包最稳。
  const list = useSpacesStore().spaces.value
  const s = list.find((x) => x.id === spaceId)
  if (!s) return null
  return {
    id: s.id,
    kind: s.kind ?? 'shared',
    ownerId: s.ownerId ?? null,
    viewerRole: s.viewerRole ?? null,
  }
}

/**
 * 「在当前 space 里能创建新页面 / 子页 / 同级页」的统一 gate,合并三处
 * 老 helper(Sidebar / TopBar / HomeView)各自的 isAdmin + viewerRole 短路。
 *
 * 矩阵(P0-3 + 2026-07-29 relaxation):
 *   - personal space:owner 可以创建(包含 owner 是 admin 的情形);
 *     admin × owner ≠ me → 不能(继续走 supervisor 语义)。
 *   - shared space:global admin / 空间 editor / 空间 admin 都行;viewer 隐藏。
 *
 * 配合 `canWritePersonalSpace` 使用,语义直接对齐后端 `canEditSpace` +
 * `assertCanWriteToPersonalSpace` 的合成。
 */
export function canCreateInSpace(me: User | null, space: SpaceRef | null | undefined): boolean {
  if (!me || !space) return false
  if ((space.kind ?? 'shared') === 'personal') {
    // Owner(无论 admin 或 member)都可以在 own personal 里建页;
    // admin × owner ≠ me → 拦。其它(non-admin × non-owner)→ 拦。
    if (space.ownerId === me.id) return true
    return me.role !== 'admin'
  }
  if (me.role === 'admin') return true
  return space.viewerRole === 'editor' || space.viewerRole === 'admin'
}

/**
 * 个人空间写权限(矩阵的「写」分支)。
 * 返回 true 表示允许在前端展示写按钮 / 菜单 / 对话框;false 则不展示。
 *
 * 注意:shared space 永远返回 true —— 真正的 canEdit 判定交给调用方
 * (isAdmin / viewerRole / author)叠加。
 */
export function canWritePersonalSpace(me: User | null, space: SpaceRef | null): boolean {
  if (!space) return true
  if ((space.kind ?? 'shared') !== 'personal') return true
  if (!me) return false
  // owner(包含 admin)可以写 own personal;admin × owner ≠ me → 拦。
  if (space.ownerId === me.id) return true
  return me.role !== 'admin'
}

/**
 * PageNode → SpaceRef 查表便捷方法。给 EditView/ReadView/PageTree 的 canEdit
 * 之类的 computed 用。
 */
export function spaceRefForPage(page: PageNode | null | undefined): SpaceRef | null {
  if (!page) return null
  return resolvePersonalSpace(page.spaceId)
}