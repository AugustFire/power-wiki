/**
 * lockSweeper —— 每 30s 扫一次 page_locks 表,删除 expires_at < now 的行,
 * 并给每页连着的 client 推 lock_cleared stateless。
 *
 * 为什么需要:
 *   page_locks 的 5min TTL 兜底逻辑(详见 pageLocks.ts LOCK_TTL_MS)依赖
 *   server 在 acquire 时检查 expires_at > now 来允许覆盖,**主动清理过期行**
 *   不是 acquire 流程必做的(它们已经能被覆盖)。但 client 端要感知锁过期,
 *   旧路径靠 1s REST poll 把 lock 拉到 null。换 WS push 后,server 主动推
 *   lock_cleared 让 client 端 0 延迟感知,polling 频率可以降到 5s。
 *
 * 实现要点:
 *   - 30s 周期 = 跟 Phase 4 锁 TTL(5min)对齐,最多延迟 30s 才感知过期。
 *     client 端兜底是 5s polling,实际延迟 = min(30s, 5s) = 5s。
 *   - 同一个 page 多 client 时,sweep 推一次即可(sendStatelessToPage 是
 *     page 级 broadcast,不是 per-client)。
 *   - 单例 startLockSweeper / stopLockSweeper —— 跟 collab server
 *     启停同步,index.ts main() 启动时调一次。
 *   - sweep 失败 silent —— 下次 30s 再来,client 5s 兜底 poll 仍能感知。
 *
 * 不在此处理:
 *   - release-by-disconnect:目前 onDisconnect 是 no-op(锁由 TTL 自然过期
 *     清理),本 sweeper 已经覆盖。如果将来要「最后一个 client 断开立刻清
 *     锁」再加 onDisconnect 路径。
 *   - admin takeover / 主动 release:路由层已经直接 fire broadcastLockChanged,
 *     不依赖 sweep。
 */
import { lt } from 'drizzle-orm'
import { db } from '../db/client'
import { pageLocks } from '../db/schema'
import { broadcastLockCleared } from './pageLockEvents'

const SWEEP_INTERVAL_MS = 30_000

let sweepHandle: ReturnType<typeof setInterval> | null = null

/**
 * 单次 sweep:删过期行 + 给每页推 lock_cleared。失败不抛(sweep 是 advisory,
 * 下次周期再来)。
 */
async function sweepOnce(): Promise<void> {
  const now = Date.now()
  try {
    const expired = await db
      .select({ pageId: pageLocks.pageId })
      .from(pageLocks)
      .where(lt(pageLocks.expiresAt, now))
    if (expired.length === 0) return
    await db.delete(pageLocks).where(lt(pageLocks.expiresAt, now))
    for (const { pageId } of expired) {
      await broadcastLockCleared(pageId)
    }
  } catch (err) {
    console.warn('[lockSweeper] sweep failed', err)
  }
}

/**
 * 启动 sweep timer。多次调用幂等 —— 已经在跑就 no-op。
 * index.ts main() 启动时调一次。
 */
export function startLockSweeper(): void {
  if (sweepHandle) return
  sweepHandle = setInterval(() => {
    void sweepOnce()
  }, SWEEP_INTERVAL_MS)
  if (sweepHandle.unref) sweepHandle.unref()
}

/**
 * 停止 sweep timer(测试 / hot reload 用)。生产 server 通常不需要调,
 * 进程退出由 OS 清理。
 */
export function stopLockSweeper(): void {
  if (!sweepHandle) return
  clearInterval(sweepHandle)
  sweepHandle = null
}