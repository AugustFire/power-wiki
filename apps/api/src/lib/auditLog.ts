/**
 * 权限变更审计日志写入 helper(Phase C)。
 *
 * 设计目标:
 *   - **强制在事务内调用** —— tx rollback 时 audit 行不留(关键不变量)。
 *     通过 `AnyTx` 类型让 lint 看见「这必须接 db.transaction(...) 的 tx」。
 *   - 一行 = 一次权限变更事件;append-only,无 UPDATE / DELETE 入口。
 *   - payload 形态由业务层约束(`{ before, after }` diff),schema 不强约束。
 *   - generatePageId 复用:同 nanoid(10) 字母表。
 *
 * 调用约定(关键):
 *   ```ts
 *   await db.transaction(async (tx) => {
 *     await tx.delete(spaceRoleGrants).where(...)
 *     await tx.insert(spaceRoleGrants).values(...)
 *     await recordPermissionAudit(tx, {
 *       kind: 'space_grant_set',
 *       actorId: me.id,
 *       targetKind: 'space',
 *       targetId: spaceId,
 *       payload: { before, after },
 *     })
 *   })
 *   ```
 *   audit 行跟业务变更同一个事务 —— 业务 rollback,audit 也 rollback,不会
 *   出现「业务失败但 audit 显示成功」的污染。这是 verify_phase_c_audit.py
 *   §rollback 的关键 case。
 */
import type { NodePgTransaction } from 'drizzle-orm/node-postgres'
import type { TablesRelationalConfig } from 'drizzle-orm'
import * as schema from '../db/schema'
import { permissionAudit } from '../db/schema'
import { generatePageId } from './ids'

/**
 * AnyTx —— 接受任意 drizzle node-postgres 事务对象。
 * 严格说 db.transaction(tx => …) 给的 tx 是 `NodePgTransaction<FullSchema, Schema>`,
 * 不同 schema 形态的 tx 跟这里不严格相等(structural typing),所以用泛型把它
 * 收敛到「带 insert(permissionAudit) 方法」的结构。
 *
 * 实用上:任何 `db.transaction(tx => …)` 里那个 tx 都满足这个约束(因为
 * permissionAudit 在 schema.ts 里),所以直接传进来即可。
 */
type AnyTx = Pick<NodePgTransaction<Record<string, unknown>, TablesRelationalConfig>, 'insert'>

/** 事件类型。schema 里 CHECK 限定 11 个;新增事件同步改 CHECK + migration。
 *  8 个权限变更(grant / restriction / share)+ 3 个资源生命周期(space / group / user 删 / 匿名化)。
 *  资源生命周期事件统一归到 permission_audit,跟权限变更同张表 = 「任何会改可见性 / 访问性的事件」都在一个时间线,审计查询一次搞定。 */
export type AuditKind =
  | 'space_grant_set'
  | 'space_grant_add'
  | 'space_grant_remove'
  | 'page_restriction_set'
  | 'page_restriction_add'
  | 'page_restriction_remove'
  | 'page_share_create'
  | 'page_share_revoke'
  | 'space_deleted'
  | 'group_deleted'
  | 'user_anonymized'

/** target_kind。'user' = user_anonymized;'group' = group_deleted;其他 = space/page/page_share。 */
export type AuditTargetKind = 'space' | 'page' | 'page_share' | 'group' | 'user'

export interface AuditEntry {
  kind: AuditKind
  actorId: string
  targetKind: AuditTargetKind
  targetId: string
  /**
   * 业务 diff,JSONB 自由形态。约定 `{ before, after }`,具体结构按
   * AuditKind 分支:
   *   - *_set: {before, after} 都填完整对象
   *   - *_add: {after: 单行限制}
   *   - *_remove: {before: 单行限制}
   * null = 该事件无 diff 信息(保留列兼容,极少用)。
   */
  payload: unknown
}

/**
 * 在事务内同步 INSERT 一条 audit 行。
 * INSERT 失败会抛错 → 整个事务 rollback(连带业务变更一起回滚),关键不变量。
 *
 * 不在事务内调 recordPermissionAudit 等于「裸 INSERT,失败时业务变更已 commit」
 * —— 这是 banned 模式,应用层不会出现裸调用(每处用点都在 db.transaction 内)。
 */
export async function recordPermissionAudit(tx: AnyTx, entry: AuditEntry): Promise<void> {
  await tx.insert(permissionAudit).values({
    id: generatePageId(),
    kind: entry.kind,
    actorId: entry.actorId,
    targetKind: entry.targetKind,
    targetId: entry.targetId,
    createdAt: Date.now(),
    payload: entry.payload as Record<string, unknown> | null,
  })
}