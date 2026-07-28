/**
 * Admin-on-personal-space guard.
 *
 *  Aligns with Confluence Cloud's default: admin is a *supervisor*, not an
 *  *editor*. Admins can LIST/READ personal spaces (existing role bypass in
 *  `accessibleSpaceIds.ts`), and can RESTORE/PURGE trashed pages inside them
 *  (recovery / compliance), but every other write op returns 403.
 *
 *  ─── 个人空间写矩阵 (P0-3) ─────────────────────────────────────────
 *
 *  个人空间 (kind='personal') 的写权限只授予 owner,其他所有人(包含
 *  全局管理员)都无权修改内容。这条规则覆盖以下写操作:
 *
 *    | 操作                  | Owner | 全局 Admin | 其他用户 |
 *    |-----------------------|:-----:|:----------:|:--------:|
 *    | 创建页面              | ✅    | ❌         | ❌       |
 *    | 编辑 / 软删页面       | ✅    | ❌         | ❌       |
 *    | 永久删除 (?purge=true)|  n/a  | ✅ (恢复 / 合规) | n/a |
 *    | 上传 / 删附件         | ✅    | ❌         | ❌       |
 *    | 加 / 删 label         | ✅    | ❌         | ❌       |
 *    | 发 / 改 / 删评论      | ✅    | ❌         | ❌       |
 *    | 打 snapshot / restore | ✅    | ❌         | ❌       |
 *    | Duplicate 页面       | ✅    | ❌         | ❌       |
 *    | Publish 到团队空间   | ✅    | ❌         | ❌       |
 *    | 移动到其他空间       | ✅    | ❌         | ❌       |
 *    | Markdown 导入        | ✅    | ❌         | ❌       |
 *
 *  实施细节:
 *  - `canEditSpace` / `canEditPage` 已经给 global admin 短路 true,所以
 *    本守卫**必须**在 canEditSpace/canEditPage **之后**调用 ——
 *    否则无法区分「admin on shared」(放行)与「admin on personal」(拦截)。
 *  - 个人空间的 ownerId === me.id 时,owner 仍然受 admin 角色拦截
 *    (Confluence 风格:admin 即使是自己的内容也是 supervisor,而非编辑者)。
 *    普通用户 own 自己的 personal space 不受影响,因为 canEditSpace 会
 *    通过 ensurePersonalSpace 授予的 pg-<userId> admin 角色放行。
 *  - 「non-owner non-admin on personal」会被 canEditSpace 拦(404),本
 *    守卫再调一次也无害(只起 sanity check 作用),但路径更明确。
 *
 *  历史:在引入矩阵之前,`assertAdminNotWritingPersonalSpace` 是这条规则
 *  的唯一实现,只在 admin 路径上挡;其他用户走 canEditSpace。新的
 *  `assertCanWriteToPersonalSpace` 显式表达完整矩阵,作为所有写路径
 *  的单一事实来源。旧的 `assertAdminNotWritingPersonalSpace` 保留为
 *  fallback(自己查 kind),新代码优先用前者。
 */
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { db } from '../db/client'
import { spaces } from '../db/schema'
import type { AuthenticatedUser } from '../auth/session'

/**
 * Returns the spaces.kind for a given spaceId, or null if the space doesn't
 * exist. One round-trip; we already have the space row for other reasons in
 * most callers, but keeping the guard self-contained means it stays easy to
 * add to new write paths.
 */
export async function getSpaceKind(spaceId: string): Promise<'personal' | 'shared' | null> {
  const [row] = await db
    .select({ kind: spaces.kind })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1)
  return row?.kind ?? null
}

/**
 * If the caller is admin AND the target space is `personal`, returns the 403
 * response body so the caller can `return c.json(...)` directly. Otherwise
 * returns null and the caller proceeds.
 *
 * The 403 code is `personal_space_readonly` to make the UX hint precise —
 * the frontend can branch on it if it wants a more specific banner than the
 * generic 403.
 *
 * @deprecated Prefer `assertCanWriteToPersonalSpace` when the caller has
 * already loaded `space.kind` + `ownerId` (no extra SELECT). This helper
 * exists for paths that only know the spaceId and would otherwise need a
 * separate SELECT to switch to the new helper.
 */
export async function assertAdminNotWritingPersonalSpace(
  c: Context,
  me: AuthenticatedUser,
  targetSpaceId: string | null,
): Promise<Response | null> {
  if (me.role !== 'admin') return null
  if (!targetSpaceId) return null
  const kind = await getSpaceKind(targetSpaceId)
  if (kind === 'personal') {
    return c.json(
      {
        error: 'personal_space_readonly',
        message: '管理员不能直接编辑个人空间的内容',
      },
      403,
    )
  }
  return null
}

/**
 * 个人空间写权限矩阵(单一事实来源,见文件头矩阵)。
 *
 * 调用方应在 `canEditSpace` / `canEditPage` **之后**调用本函数 —— 那些
 * 函数已对 global admin 短路 true,所以矩阵里的「admin 不能写 personal」
 * 必须由本守卫独立拦截。
 *
 * @param spaceKind  目标空间的 `spaces.kind`(null 也合法,表示空间已被
 *                   删除 → 仍按 personal 处理,因为 canEditSpace 已会返 false)
 * @param ownerId    `spaces.ownerId`(null = 非个人空间,或 owner 已 anonymize)
 *
 * 返回值:
 *   - null:调用方可以继续(canEditSpace 会在后面判 404 / 200)
 *   - 403 Response:`personal_space_readonly`(matrix 里 admin × personal 的拒)
 */
export async function assertCanWriteToPersonalSpace(
  c: Context,
  me: AuthenticatedUser,
  spaceKind: 'personal' | 'shared' | null,
  ownerId: string | null,
): Promise<Response | null> {
  if (spaceKind !== 'personal') return null
  // 矩阵:owner 唯一能写。但 admin 身份优先于 owner(Confluence 风格:
  // admin 即使是自己的 personal space 也是 supervisor,不是 editor)。
  if (ownerId === me.id && me.role !== 'admin') return null
  // 其他写到 personal 的场景:admin (即使 own) → 拒;非 admin 非 owner
  // → 由调用方 canEditSpace 兜底返 404。
  if (me.role === 'admin') {
    return c.json(
      {
        error: 'personal_space_readonly',
        message: '管理员不能直接编辑个人空间的内容',
      },
      403,
    )
  }
  return null
}