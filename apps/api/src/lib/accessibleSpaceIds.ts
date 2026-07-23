/**
 * Phase A 兼容层 —— 旧 `getAccessibleSpaceIds` / `canAccessSpace`
 * 委托到 `lib/permissions.ts` 的新谓词。
 *
 * 历史:这文件原本是「唯一权限 SQL 来源」,Phase A 起被
 * `lib/permissions.ts` 替代,但旧调用点(主要是 pages.ts 之外
 * 的若干地方)迁移是逐步的,这里保留 wrapper,标记 @deprecated,
 * 全部迁移完(Phase B 之后)删除。
 *
 * 转换规则:
 *   getAccessibleSpaceIds(userId, isAdmin)
 *     → listReadableSpaceIds({ kind: 'user', id: userId, isAdmin })
 *
 *   canAccessSpace(userId, isAdmin, spaceId)
 *     → canReadSpace({ kind: 'user', id: userId, isAdmin }, spaceId)
 */
import {
  canReadSpace,
  listReadableSpaceIds,
  type ListReadableSpaceIdsResult,
} from './permissions'

/**
 * 旧 `getAccessibleSpaceIds` 委托。Phase B 之后所有调用点迁完就删除。
 *
 * @deprecated use `listReadableSpaceIds(principal)` from `./permissions`
 */
export async function getAccessibleSpaceIds(
  userId: string,
  isAdmin: boolean,
): Promise<'*' | string[]> {
  const result: ListReadableSpaceIdsResult = await listReadableSpaceIds({
    kind: 'user',
    id: userId,
    isAdmin,
  })
  return result
}

/**
 * 旧 `canAccessSpace` 委托。Phase B 之后所有调用点迁完就删除。
 *
 * @deprecated use `canReadSpace(principal, spaceId)` from `./permissions`
 */
export async function canAccessSpace(
  userId: string,
  isAdmin: boolean,
  spaceId: string,
): Promise<boolean> {
  return canReadSpace({ kind: 'user', id: userId, isAdmin }, spaceId)
}
