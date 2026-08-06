/**
 * pageLockEvents —— page_locks 状态变更 → Hocuspocus stateless 广播。
 *
 * 为什么需要(page_locks 是 server 端唯一真值,但 client 想知道变化):
 *   client 端 usePageLock 以前靠 1s 一次的 REST poll 跟 server 真值对齐,
 *   每次 GET /api/pages/:id/lock 不管有没有变化都打 server。换成 WS push
 *   后,server 在 lock 变更(acquire / release / takeover / TTL sweep)时
 *   推 stateless,client 端 handleStateless 直接更新 lock ref,poll 降到
 *   5s 兜底频率(WS 断时回到 1s)。
 *
 * payload schema(对应 usePageLock.ts:144-143 StatelessPayload union):
 *   - { kind: 'lock_changed', lock: PageLock | null }
 *     acquire / takeover / release 后:推给 page 所有连着的 client,
 *     client 端直接 lock.value = payload.lock。
 *   - { kind: 'lock_cleared', pageId, at: now }
 *     TTL sweep 检测到过期锁:推一个轻量通知(避免每次 sweep 把整张
 *     pageLock DTO 都广播出去 —— 锁空了就是空,不需要 lock=null 字段)。
 *
 * 容错:跟 sendStatelessToPage 一致 —— 没人接收就 silent no-op。
 *
 * 不广播给 caller 自己:本路由已经在 HTTP 响应里返了最新 lock,client
 * 端不需要再通过 stateless 听一遍(避免 echo)。
 */
import { sendStatelessToPage } from '../collab/stateless'
import type { PageLockDto } from '../routes/pageLocks'

interface LockChangedMessage {
  kind: 'lock_changed'
  pageId: string
  lock: PageLockDto | null
}

interface LockClearedMessage {
  kind: 'lock_cleared'
  pageId: string
  at: number
}

/**
 * 推送 lock_changed —— lock DTO 跟 HTTP 响应的 lock 字段同 schema。
 * 路由 commit 后调一次即可,不需要事务包(sweep 单独走 lock_cleared)。
 */
export async function broadcastLockChanged(
  pageId: string,
  lock: PageLockDto | null,
): Promise<void> {
  const msg: LockChangedMessage = { kind: 'lock_changed', pageId, lock }
  await sendStatelessToPage(pageId, msg)
}

/**
 * 推送 lock_cleared —— 轻量版,不带 lock DTO(锁已经过期了,null 也不需要发)。
 * 30s 一次的 sweep 用这个减少 payload 大小。
 */
export async function broadcastLockCleared(pageId: string): Promise<void> {
  const msg: LockClearedMessage = {
    kind: 'lock_cleared',
    pageId,
    at: Date.now(),
  }
  await sendStatelessToPage(pageId, msg)
}