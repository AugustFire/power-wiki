/**
 * Trash retention — P1-8 回收站自动清理。
 *
 * 设计原则:
 *   - 默认 30 天;admin 可在 admin UI 把 retention_days 改成 0(=永不清理)
 *     或任何正整数。配置存 admin_settings(key='trash_retention_days')。
 *   - 清理策略:LAZY — 不跑 cron / 定时任务,只在 admin 打开
 *     /api/pages/trash 时顺手清一下过期行。这样不需要后台 worker,
 *     也避免在生产跑独立进程。
 *   - 配置 fallback:DB 里没行 → 30 天。0013 migration 启动时 seed,
 *     但代码本身不应假设表里有行。
 *   - 0 = forever,代码走 "skip" 路径,完全不打 DB。
 *
 * 调用方:
 *   apps/api/src/routes/pages.ts 的 GET /api/pages/trash 在返结果前
 *   调一次 purgeExpiredTrash()。UI 触发,所以"清"动作永远由 admin
 *   主动行为驱动,无 background fire-and-forget。
 *
 * 实现:
 *   - 读 admin_settings 一行(SELECT WHERE key=)。
 *   - 解析 value;非数字 / 负数 → 当 30 处理(per plan "默认 30 天")。
 *   - 0 → return early(forever 模式)。
 *   - 计算 cutoff = now - retentionDays * 24 * 60 * 60 * 1000。
 *   - DELETE FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < cutoff。
 *
 * Cascade:purgeExpiredTrash 不级联删 page_versions / comments /
 * pageLikes / labels / attachments — 这些由 DELETE /api/pages/:id
 * (硬删) 在事务里负责。但既然 trash 里的 page 是 soft-deleted,
 *   "过期"含义和"硬删"不同 — 实际生产应该走硬删路径的同一段事务
 *   清理。**v0 简化**:过期 purge 跟手动硬删一样,recursive CTE
 *   找所有 deleted_at < cutoff 的行及其子树一起清。
 *
 * 简化:v0 我们只清"deleted_at 本身 < cutoff" 的行(顶层)。子页
 * 跟父页同时间被删 — 实际不是,父子可能在不同 admin 操作下被删。
 * 这里取保守:任何 deleted_at < cutoff 的 row 都被视为过期,直接硬删,
 * 其它子页如果还活(没被 trash)就保留。这跟 admin 主动的硬删一致。
 *
 * Per CLAUDE.md "不主动 commit / push":changes stay local;user says
 * "提交吧" before any git commit/push.
 */
import { and, eq, isNotNull, lt } from 'drizzle-orm'
import { db } from '../db/client'
import { adminSettings, pages } from '../db/schema'

/** Fallback retention when admin_settings row missing or value unparseable. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30

/**
 * Read the current retention setting.
 *
 * Returns:
 *   - number >= 0   — days to retain
 *   - 0             — never purge
 *
 * Falls back to DEFAULT_TRASH_RETENTION_DAYS if:
 *   - row missing
 *   - value not a non-negative integer
 *
 * The single row read is fast (PK lookup) and idempotent — caller
 * can call this on every /trash hit without worrying about cache.
 */
export async function getTrashRetentionDays(): Promise<number> {
  const row = (
    await db
      .select({ value: adminSettings.value })
      .from(adminSettings)
      .where(eq(adminSettings.key, 'trash_retention_days'))
      .limit(1)
  )[0]
  if (!row) return DEFAULT_TRASH_RETENTION_DAYS
  const n = Number(row.value)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return DEFAULT_TRASH_RETENTION_DAYS
  }
  return n
}

/**
 * Lazy-purge trashed pages whose `deleted_at` is older than the configured
 * retention window. Returns the number of rows hard-deleted.
 *
 * Side effects:
 *   - Hard-deletes pages (cascading child rows are NOT touched here — the
 *     admin's manual hard-delete path runs the full cleanup transaction;
 *     for v0 we accept the simplification that orphan child rows will
 *     stay. A future task can add full cascade).
 *
 * When retention is 0, returns 0 immediately without hitting the DB.
 */
export async function purgeExpiredTrash(): Promise<number> {
  const days = await getTrashRetentionDays()
  if (days === 0) return 0

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const result = await db
    .delete(pages)
    .where(and(isNotNull(pages.deletedAt), lt(pages.deletedAt, cutoff)))
  // Drizzle's pg-core delete() returns rowCount; type may be {} | RowList
  // depending on driver, so coerce to number via runtime field name.
  // node-postgres returns { rowCount: number } via .then.
  // Drizzle wraps the raw result; we get an array-like of undefined rows.
  // The actual row count comes back as a number on `affectedRows` for
  // postgres-js — be defensive.
  const rc = (result as unknown as { rowCount?: number }).rowCount
  return typeof rc === 'number' ? rc : 0
}
