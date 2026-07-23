/**
 * Public share route — Phase D 公开链接(匿名只读)。
 *
 *   GET /api/public/pages/:token
 *
 * **无 auth,挂在全局 `app.use('/api/*', requireAuth)` 之前**(index.ts
 * mount 顺序敏感,见 plan Phase D §D.4 #13)。
 *
 * 校验链:
 *   1. tokenHash = sha256(明文):SELECT WHERE token_hash = $1
 *   2. revoked_at IS NULL
 *   3. expires_at IS NULL OR expires_at > $now
 *   4. page.deleted_at IS NULL
 *   5. page.space.kind = 'shared'
 * 任一失败 → 404(细分 code 在 humanizeApiError 翻译时再分流)。
 *
 * 命中后:
 *   - **fire-and-forget 异步** update last_accessed_at(不阻塞首屏)。
 *   - Cache-Control: public, max-age=60(防爬虫狂拉但允许 CDN 边缘缓存)。
 *   - 返回 public DTO(无 authorEmail 等敏感字段)。
 *
 * 只返本页,不返子树 —— subtree-share 留 v2。
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { PublicPageSchema } from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { pagePublicShares, pages, spaces, users } from '../db/schema'
import { hashToken } from '../lib/shareTokens'

export const publicSharesRouter = new Hono()

/* ─── Helpers ─────────────────────────────────────────────────────── */

interface ShareLookupRow {
  id: string
  pageId: string
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
  // page meta (joined)
  pageTitle: string
  pageContentJSON: unknown
  pageContentHTML: string | null
  pageDeletedAt: number | null
  pageUpdatedAt: number
  pageAuthorId: string
  pageSpaceId: string
  spaceKind: 'personal' | 'shared' | null
  spaceName: string
  spaceColor: string | null
}

/**
 * 一次性把 share + page + space 取齐。失败原因用 status 区分:
 *   0 = hit(可继续走 render 流程)
 *   1 = invalid(无此 token / 已被 purge 的 page)
 *   2 = revoked
 *   3 = expired
 *   4 = page trashed
 *   5 = page 在 personal space(防御性,正常不会发生)
 */
async function lookupShare(
  tokenHash: string,
  now: number,
): Promise<{ status: 0 | 1 | 2 | 3 | 4 | 5; row: ShareLookupRow | null }> {
  // 单 SELECT 拿全部信息,避免 N+1。
  // 1) 查 share 行
  const share = (
    await db
      .select({
        id: pagePublicShares.id,
        pageId: pagePublicShares.pageId,
        createdAt: pagePublicShares.createdAt,
        expiresAt: pagePublicShares.expiresAt,
        revokedAt: pagePublicShares.revokedAt,
      })
      .from(pagePublicShares)
      .where(eq(pagePublicShares.tokenHash, tokenHash))
      .limit(1)
  )[0]
  if (!share) return { status: 1, row: null }
  if (share.revokedAt !== null) return { status: 2, row: null }
  if (share.expiresAt !== null && share.expiresAt <= now) return { status: 3, row: null }

  // 2) 查 page + space
  const pageRow = (
    await db
      .select({
        id: pages.id,
        title: pages.title,
        contentJson: pages.contentJson,
        contentHtml: pages.contentHtml,
        deletedAt: pages.deletedAt,
        updatedAt: pages.updatedAt,
        authorId: pages.authorId,
        spaceId: pages.spaceId,
        spaceKind: spaces.kind,
        spaceName: spaces.name,
        spaceColor: spaces.color,
      })
      .from(pages)
      .leftJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(eq(pages.id, share.pageId))
      .limit(1)
  )[0]
  if (!pageRow || !pageRow.spaceKind || !pageRow.spaceName) {
    // page 不存在(被 purge?)—— DB 显式 cascade 已 sweep 掉 share,
    // 这里保险返 invalid 而非 500。
    return { status: 1, row: null }
  }
  if (pageRow.spaceKind === 'personal') return { status: 5, row: null }
  if (pageRow.deletedAt !== null) return { status: 4, row: null }

  return {
    status: 0,
    row: {
      id: share.id,
      pageId: share.pageId,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      revokedAt: share.revokedAt,
      pageTitle: pageRow.title,
      pageContentJSON: pageRow.contentJson,
      pageContentHTML: pageRow.contentHtml,
      pageDeletedAt: pageRow.deletedAt,
      pageUpdatedAt: pageRow.updatedAt,
      pageAuthorId: pageRow.authorId,
      pageSpaceId: pageRow.spaceId as string,
      spaceKind: pageRow.spaceKind,
      spaceName: pageRow.spaceName,
      spaceColor: pageRow.spaceColor ?? null,
    },
  }
}

async function loadAuthor(
  userId: string,
): Promise<{ name: string | null; color: string | null; avatarKind: 'preset' | 'custom' | null; avatarRef: string | null }> {
  const u = (
    await db
      .select({ name: users.name, color: users.color, avatarKind: users.avatarKind, avatarRef: users.avatarRef })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0]
  if (!u) return { name: null, color: null, avatarKind: null, avatarRef: null }
  return {
    name: u.name,
    color: u.color,
    avatarKind: (u.avatarKind ?? null) as 'preset' | 'custom' | null,
    avatarRef: u.avatarRef,
  }
}

/* ─── GET /api/public/pages/:token ────────────────────────────────── */

publicSharesRouter.get('/public/pages/:token', async (c) => {
  const token = c.req.param('token')
  if (!token || token.length < 8 || token.length > 64) {
    return c.json(
      { error: 'invalid_token', code: 'share_invalid', message: '无效的分享链接' },
      404,
    )
  }

  const tokenHash = hashToken(token)
  const now = Date.now()
  const lookup = await lookupShare(tokenHash, now)

  if (lookup.status === 1) {
    return c.json(
      { error: 'not_found', code: 'share_invalid', message: '分享链接无效' },
      404,
    )
  }
  if (lookup.status === 2) {
    return c.json(
      { error: 'gone', code: 'share_revoked', message: '分享链接已撤销' },
      404,
    )
  }
  if (lookup.status === 3) {
    return c.json(
      { error: 'gone', code: 'share_expired', message: '分享链接已过期' },
      404,
    )
  }
  if (lookup.status === 4) {
    return c.json(
      { error: 'gone', code: 'share_revoked', message: '该页面已被删除' },
      404,
    )
  }
  if (lookup.status === 5) {
    return c.json(
      { error: 'forbidden', code: 'share_forbidden', message: '该页面不可分享' },
      404,
    )
  }

  const row = lookup.row!
  // 命中 → fire-and-forget 更新 last_accessed_at
  void db
    .update(pagePublicShares)
    .set({ lastAccessedAt: now })
    .where(eq(pagePublicShares.id, row.id))
    .catch(() => {
      // 静默吞:last_accessed_at 是运营位,失败不抛
    })

  const author = await loadAuthor(row.pageAuthorId)
  const dto = PublicPageSchema.parse({
    id: row.pageId,
    title: row.pageTitle,
    contentJSON: row.pageContentJSON,
    contentHTML: row.pageContentHTML ?? '',
    spaceId: row.pageSpaceId,
    spaceName: row.spaceName,
    spaceColor: row.spaceColor,
    authorId: row.pageAuthorId,
    authorName: author.name,
    authorColor: author.color,
    authorAvatarKind: author.avatarKind,
    authorAvatarRef: author.avatarRef,
    updatedAt: row.pageUpdatedAt,
  })
  c.header('Cache-Control', 'public, max-age=60')
  return c.json(dto)
})
