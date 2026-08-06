/**
 * Page-level edit locks (Phase 4) —— 「Alice 大改时 Bob 不要乱入」的 UI 提示。
 *
 *   GET    /api/pages/:id/lock               — 读当前锁 / 没有返 200 + null
 *   POST   /api/pages/:id/lock               — acquire:自己拿锁;若被别人
 *                                              持锁且未过期 → 409
 *   DELETE /api/pages/:id/lock               — release:holder / admin 才能
 *                                              释放;否则 403
 *   POST   /api/pages/:id/lock/takeover      — admin 强制接管;触发 Hocuspocus
 *                                              stateless 给原 holder 发
 *                                              lock_takeover + close(4410)
 *
 * 锁语义关键点(plan §B.7 落地):
 *   - **锁 ≠ 写权限闸**。canEditPage 通过的用户,无论是否持锁,Yjs CRDT 都
 *     接受其 update。本路由只服务 UI 提示 / ReadView Edit tooltip / EditView
 *     banner —— 跟 server 端的 canEditPage 检查正交。
 *   - **5 分钟自动过期**:expiresAt = acquiredAt + 5*60*1000。acquire 时
 *     SELECT 一次,如果现有锁 expiresAt < now() 则视为过期可覆盖(防止网
 *     抖期间两个 user 同时拿锁)。
 *   - **admin 强制接管**:POST /lock/takeover,要求 me.isAdmin=true。覆盖
 *     本表 user_id / acquiredAt / expiresAt = now()+5min,并通过 Hocuspocus
 *     `Document.broadcastStateless(message)` 给 page 所有 connected
 *     clients 发 { kind: 'lock_takeover', fromUserId }。原 holder 端
 *     provider.on('stateless') 接住 → uiStore.setError({ kind: 'lock_taken' })。
 *
 * 404-not-403 政策:沿用 pageRestrictions 路由的策略 —— view-restricted page
 * 一律 404(不暴露存在性),无论 acquire / release / takeover。
 *
 * No FK(项目硬约束,CLAUDE.md 第 7 条):disabled / anonymized user 的持有锁
 * 不强制清理 —— acquire 时 expiresAt 过期就自动可被覆盖,5 分钟上限
 * 自然清理。
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { pageLocks, pages } from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { canEditPage, principalFromUser, type Principal } from '../lib/permissions'
import { sendStatelessToPage } from '../collab/stateless'
import { broadcastLockChanged } from '../lib/pageLockEvents'

export const pageLocksRouter = new Hono<{ Variables: Variables }>()
pageLocksRouter.use('*', requireAuth)

const LOCK_TTL_MS = 5 * 60 * 1000

export interface PageLockDto {
  pageId: string
  userId: string
  acquiredAt: number
  expiresAt: number
}

/** 把 page_locks 行转成 DTO(bigint → number)。schema `bigint mode: 'number'` 已经
 *  在 Drizzle 层做了 bigint → number 转换,这里只兜底 driver 返回原始 bigint / string
 *  的边界。 */
function toDto(row: { pageId: string; userId: string; acquiredAt: bigint | number | string; expiresAt: bigint | number | string }): PageLockDto {
  return {
    pageId: row.pageId,
    userId: row.userId,
    acquiredAt: Number(row.acquiredAt),
    expiresAt: Number(row.expiresAt),
  }
}

/**
 * 解析 :id → page meta + canEditPage 校验。404 优先于 403(view-restricted
 * page 不暴露存在性)。
 */
async function loadPageForLock(id: string, me: Principal): Promise<
  | { ok: true; page: { id: string; spaceId: string; authorId: string } }
  | { ok: false; status: 404 | 403 }
> {
  const rows = await db
    .select({ id: pages.id, spaceId: pages.spaceId, authorId: pages.authorId, deletedAt: pages.deletedAt })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1)
  const row = rows[0]
  if (!row || row.deletedAt !== null || !row.spaceId) return { ok: false, status: 404 }
  const canEdit = await canEditPage(me, row.id, row.spaceId, row.authorId)
  if (!canEdit) return { ok: false, status: 403 }
  return { ok: true, page: { id: row.id, spaceId: row.spaceId, authorId: row.authorId } }
}

/* ─── GET /api/pages/:id/lock ───────────────────────────────────────── */

pageLocksRouter.get('/:id/lock', async (c) => {
  const me = principalFromUser(c.get('user'))
  const id = c.req.param('id')
  const loaded = await loadPageForLock(id, me)
  if (!loaded.ok) return c.json({ error: 'not_found' }, loaded.status)
  const rows = await db
    .select()
    .from(pageLocks)
    .where(eq(pageLocks.pageId, id))
    .limit(1)
  const row = rows[0]
  if (!row) return c.json({ lock: null })
  // 过期锁也当作没锁 —— 给前端 200 + null,避免读路径变成 410 Gone 之类
  const now = Date.now()
  const expiresAt = Number(row.expiresAt)
  if (expiresAt <= now) return c.json({ lock: null })
  return c.json({ lock: toDto(row) })
})

/* ─── POST /api/pages/:id/lock (acquire) ───────────────────────────── */

pageLocksRouter.post('/:id/lock', async (c) => {
  const me = principalFromUser(c.get('user'))
  const id = c.req.param('id')
  const loaded = await loadPageForLock(id, me)
  if (!loaded.ok) return c.json({ error: 'not_found' }, loaded.status)

  const now = Date.now()
  // upsert:如果同 user 已经在持锁就续期;被别人持锁且 expiresAt > now() → 409
  const rows = await db
    .select()
    .from(pageLocks)
    .where(eq(pageLocks.pageId, id))
    .limit(1)
  const existing = rows[0]
  if (existing && existing.userId !== me.id) {
    const expiresAt = Number(existing.expiresAt)
    if (expiresAt > now) {
      return c.json(
        {
          error: 'page_locked',
          holder: existing.userId,
          expiresAt,
        },
        409,
      )
    }
    // 过期锁 → 视为无人持锁,走 UPSERT 覆盖
  }
  const expiresAt = now + LOCK_TTL_MS
  await db
    .insert(pageLocks)
    .values({ pageId: id, userId: me.id, acquiredAt: now, expiresAt })
    .onConflictDoUpdate({
      target: pageLocks.pageId,
      set: { userId: me.id, acquiredAt: now, expiresAt },
    })
  const lock: PageLockDto = { pageId: id, userId: me.id, acquiredAt: now, expiresAt }
  // 推 lock_changed 给 page 所有连着的 client —— 替代它们 1s 一次的
  // REST poll。失败 silent(没人接收就 no-op,client 下次 poll 兜底)。
  await broadcastLockChanged(id, lock)
  return c.json({ lock })
})

/* ─── DELETE /api/pages/:id/lock (release) ────────────────────────── */

pageLocksRouter.delete('/:id/lock', async (c) => {
  const me = principalFromUser(c.get('user'))
  const id = c.req.param('id')
  const loaded = await loadPageForLock(id, me)
  if (!loaded.ok) return c.json({ error: 'not_found' }, loaded.status)

  const rows = await db
    .select()
    .from(pageLocks)
    .where(eq(pageLocks.pageId, id))
    .limit(1)
  const existing = rows[0]
  if (!existing) return c.json({ released: true, wasHeld: false })
  const isHolder = existing.userId === me.id
  const isAdmin = me.isAdmin
  if (!isHolder && !isAdmin) {
    return c.json(
      {
        error: 'not_holder',
        holder: existing.userId,
      },
      403,
    )
  }
  await db.delete(pageLocks).where(eq(pageLocks.pageId, id))
  // 推 lock_changed(null) —— 其他连着的 client 立即看到锁空了。
  await broadcastLockChanged(id, null)
  return c.json({ released: true, wasHeld: true })
})

/* ─── POST /api/pages/:id/lock/takeover (admin) ────────────────────── */

pageLocksRouter.post('/:id/lock/takeover', async (c) => {
  const me = principalFromUser(c.get('user'))
  const id = c.req.param('id')
  if (!me.isAdmin) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const loaded = await loadPageForLock(id, me)
  if (!loaded.ok) return c.json({ error: 'not_found' }, loaded.status)

  const rows = await db
    .select()
    .from(pageLocks)
    .where(eq(pageLocks.pageId, id))
    .limit(1)
  const existing = rows[0]
  const previousHolder = existing?.userId ?? null

  const now = Date.now()
  const expiresAt = now + LOCK_TTL_MS
  await db
    .insert(pageLocks)
    .values({ pageId: id, userId: me.id, acquiredAt: now, expiresAt })
    .onConflictDoUpdate({
      target: pageLocks.pageId,
      set: { userId: me.id, acquiredAt: now, expiresAt },
    })

  // 通知所有 connected clients(主要是原 holder):stateless 消息
  // { kind: 'lock_takeover', fromUserId, pageId }。客户端 provider.on('stateless')
  // 接住 → 弹 lock_taken toast。
  await sendStatelessToPage(id, {
    kind: 'lock_takeover',
    fromUserId: previousHolder,
    toUserId: me.id,
    pageId: id,
    expiresAt,
  })
  // 推 lock_changed(新 holder 是 admin 自己)—— 其他连着的 client
  // 立即看到锁换了 holder,不必等 1s 后的 poll。
  await broadcastLockChanged(id, {
    pageId: id,
    userId: me.id,
    acquiredAt: now,
    expiresAt,
  })

  return c.json({
    lock: { pageId: id, userId: me.id, acquiredAt: now, expiresAt },
    previousHolder,
  })
})