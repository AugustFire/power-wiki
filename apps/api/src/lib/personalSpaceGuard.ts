/**
 * Admin-on-personal-space guard.
 *
 *  Aligns with Confluence Cloud's default: admin is a *supervisor*, not an
 *  *editor* — but for admin's **own** personal space, we let admin through
 *  (admins are real people with personal notes too; P0-3 原本一刀切挡 admin
 *  的 own personal 会让 admin 在 dev / dogfood 时无法测个人流程,2026-07-29
 *  改成「admin × ownerId === me」放行)。Admins can still LIST/READ every
 *  personal space, can RESTORE/PURGE trashed pages across all personal
 *  spaces (recovery / compliance), but writing to **other people's** personal
 *  space stays a 403.
 *
 *  ─── 个人空间写矩阵 (P0-3 + 2026-07-29 relaxation) ─────────────
 *
 *  个人空间 (kind='personal') 的写权限授予 owner(包含 owner 是 admin 的
 *  情形)。Admin × owner ≠ me 仍然按 supervisor 拒。其他用户无权修改。
 *  这条规则覆盖以下写操作:
 *
 *    | 操作                  | Owner=me | Admin × owner≠me | Member × owner≠me |
 *    |-----------------------|:--------:|:-----------------:|:-----------------:|
 *    | 创建页面              | ✅       | ❌                | ❌                |
 *    | 编辑 / 软删页面       | ✅       | ❌                | ❌                |
 *    | 永久删除 (?purge=true)|  n/a     | ✅ (恢复 / 合规)  | n/a               |
 *    | 上传 / 删附件         | ✅       | ❌                | ❌                |
 *    | 加 / 删 label         | ✅       | ❌                | ❌                |
 *    | 发 / 改 / 删评论      | ✅       | ❌                | ❌                |
 *    | 打 snapshot / restore | ✅       | ❌                | ❌                |
 *    | Duplicate 页面       | ✅       | ❌                | ❌                |
 *    | Publish 到团队空间   | ✅       | ❌                | ❌                |
 *    | 移动到其他空间       | ✅       | ❌                | ❌                |
 *    | Markdown 导入        | ✅       | ❌                | ❌                |
 *
 *  实施细节:
 *  - `canEditSpace` / `canEditPage` 已经给 global admin 短路 true,所以
 *    本守卫**必须**在 canEditSpace/canEditPage **之后**调用 ——
 *    否则无法区分「admin on shared」(放行)与「admin on others' personal」
 *    (拦截)。
 *  - 个人空间的 ownerId === me.id 时,owner 可以写(包含 owner 是 admin
 *    的情形 —— Confluence 在这点上是「admin 也有私人笔记」语义,我们跟
 *    随)。普通用户 own 自己的 personal space 不受影响,因为 canEditSpace
 *    会通过 ensurePersonalSpace 授予的 pg-<userId> admin 角色放行。
 *  - 「non-owner non-admin on personal」会被 canEditSpace 拦(404),本
 *    守卫再调一次也无害(只起 sanity check 作用),但路径更明确。
 *
 *  历史:在引入矩阵之前,`assertAdminNotWritingPersonalSpace` 是这条规则
 *  的唯一实现,只在 admin 路径上挡(只查 kind);其他用户走 canEditSpace。
 *  新的 `assertCanWriteToPersonalSpace` 显式表达完整矩阵,作为所有写路径
 *  的单一事实来源,接收 `kind + ownerId` 直接走矩阵判断。旧的
 *  `assertAdminNotWritingPersonalSpace` 保留为兼容层(内部补查 ownerId
 *  再套矩阵),新代码优先用前者。
 */
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { db } from '../db/client'
import { spaces } from '../db/schema'
import type { AuthenticatedUser } from '../auth/session'

/**
 * Returns the spaces.kind + ownerId for a given spaceId, or null if the
 * space doesn't exist. One round-trip; we already have the space row for
 * other reasons in most callers, but keeping the guard self-contained means
 * it stays easy to add to new write paths.
 */
async function getSpaceKindAndOwnerId(
  spaceId: string,
): Promise<{ kind: 'personal' | 'shared'; ownerId: string | null } | null> {
  const [row] = await db
    .select({ kind: spaces.kind, ownerId: spaces.ownerId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1)
  if (!row?.kind) return null
  return { kind: row.kind, ownerId: row.ownerId ?? null }
}

/**
 * Returns the spaces.kind for a given spaceId, or null if the space doesn't
 * exist. One round-trip; we already have the space row for other reasons in
 * most callers, but keeping the guard self-contained means it stays easy to
 * add to new write paths.
 */
export async function getSpaceKind(spaceId: string): Promise<'personal' | 'shared' | null> {
  const row = await getSpaceKindAndOwnerId(spaceId)
  return row?.kind ?? null
}

/**
 * 个人空间写权限矩阵 — Owner 可写;Admin 仅在 owner == me 时可写;其他
 * 情况按矩阵拒绝。
 *
 * 直接接收 `kind + ownerId`(避免调用方再开 SELECT),新代码优先用这个。
 */
function isAllowedToWritePersonal(
  me: AuthenticatedUser,
  spaceKind: 'personal' | 'shared',
  ownerId: string | null,
): boolean {
  if (spaceKind !== 'personal') return true
  // Owner(包含 admin)可以写 own personal;其余 admin → 拒;其他 → false
  // (由调用方的 canEditSpace 兜底返 404)。
  return ownerId === me.id
}

/**
 * If the caller is admin AND the target space is `personal` AND
 * `ownerId !== me.id`, returns the 403 response body so the caller can
 * `return c.json(...)` directly. Otherwise returns null and the caller
 * proceeds.
 *
 * @deprecated Prefer `assertCanWriteToPersonalSpace` when the caller has
 * already loaded `space.kind` + `ownerId` (no extra SELECT). This helper
 * still exists for paths that only know the spaceId — it internally
 * SELECTs both kind and ownerId to apply the full matrix.
 */
export async function assertAdminNotWritingPersonalSpace(
  c: Context,
  me: AuthenticatedUser,
  targetSpaceId: string | null,
): Promise<Response | null> {
  if (me.role !== 'admin') return null
  if (!targetSpaceId) return null
  const row = await getSpaceKindAndOwnerId(targetSpaceId)
  if (!row) return null
  if (isAllowedToWritePersonal(me, row.kind, row.ownerId)) return null
  return c.json(
    {
      error: 'personal_space_readonly',
      message: '管理员不能编辑其他人的个人空间',
    },
    403,
  )
}

/**
 * 个人空间写权限矩阵(单一事实来源,见文件头矩阵)。
 *
 * 调用方应在 `canEditSpace` / `canEditPage` **之后**调用本函数 —— 那些
 * 函数已对 global admin 短路 true,所以矩阵里的「admin × others' personal」
 * 必须由本守卫独立拦截。
 *
 * @param spaceKind  目标空间的 `spaces.kind`(null 也合法,表示空间已被
 *                   删除 → 仍按 personal 处理,因为 canEditSpace 已会返 false)
 * @param ownerId    `spaces.ownerId`(null = 非个人空间,或 owner 已 anonymize)
 *
 * 返回值:
 *   - null:调用方可以继续(canEditSpace 会在后面判 404 / 200)
 *   - 403 Response:`personal_space_readonly`(matrix 里 admin × owner≠me 的拒)
 */
export async function assertCanWriteToPersonalSpace(
  c: Context,
  me: AuthenticatedUser,
  spaceKind: 'personal' | 'shared' | null,
  ownerId: string | null,
): Promise<Response | null> {
  if (spaceKind !== 'personal') return null
  // Owner(包含 admin owner) 写 own personal → 放行。
  if (ownerId === me.id) return null
  // Admin × owner ≠ me → 拒。non-admin non-owner 由 canEditSpace 兜底 404。
  if (me.role === 'admin') {
    return c.json(
      {
        error: 'personal_space_readonly',
        message: '管理员不能编辑其他人的个人空间',
      },
      403,
    )
  }
  return null
}
