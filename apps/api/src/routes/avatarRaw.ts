/**
 * Public avatar raw stream — GET /api/user-avatars/:userId/raw
 *
 *   公开访问(无 requireAuth):头像跟 username 一样对外公开,没有空间
 *   可见性闸门。未登录或被移出空间的访问者都能看到头像(Confluence /
 *   Notion / 飞书 同构语义 —— 头像不是 page-level 权限意义上的资源)。
 *
 *   必须挂在独立的 router,在 `app.use('/api/*', requireAuth)` 之前
 *   mount(见 apps/api/src/index.ts)。不允许并入 usersRouter,因为:
 *     - usersRouter 自身 use('*', requireAuth)
 *     - 即使去掉 router 自身 gate,app 级别的 /api/* gate 也会兜走
 *     - 公开 → 必须独立前缀 `/api/user-avatars/*`,且先 mount
 *
 *   用户表存在但 avatar_kind != 'custom' → 404 no_custom_avatar,
 *   让前端 <img @error> 兜底到 initials 渲染(见 UserAvatar.vue)。
 *   userAvatars 行不在 / user 不存在 → 同样 404。
 *
 *   S3 拉对象失败(streamDownload 抛 / 返 null) → 502 storage_unavailable,
 *   前端 <img @error> 兜底,不泄漏错误细节。
 */
import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { userAvatars, users } from '../db/schema'
import { streamDownload } from '../lib/s3'
import type { Variables } from '../auth/middleware'

export const avatarRawRouter = new Hono<{ Variables: Variables }>()

/* ─── GET /api/user-avatars/:userId/raw ──────────────────────────────
 *  公开头像 proxy。user 表查 kind/ref → user_avatars 拿 bucketKey →
 *  streamDownload(S3) → 200 image/{mime} body。
 */
avatarRawRouter.get('/:userId/raw', async (c) => {
  const userId = c.req.param('userId')

  // Step 1: 查 user 当前 avatar state
  const [u] = await db
    .select({ kind: users.avatarKind, ref: users.avatarRef })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!u || u.kind !== 'custom' || !u.ref) {
    // 用户不存在 / 当前不是 custom 头像(可能是 preset / init) →
    // 返 404,前端 img @error 兜底。区分 'no_user' / 'not_custom' 没意义,
    // 都走同一兜底路径
    return c.json({ error: 'not_found' }, 404)
  }

  // Step 2: 拿 user_avatars 行(mime / sizeBytes 也存了,优先用 DB 字段)
  const [avatar] = await db
    .select()
    .from(userAvatars)
    .where(and(eq(userAvatars.id, u.ref), eq(userAvatars.userId, userId)))
    .limit(1)
  if (!avatar) {
    // kind='custom' 但 user_avatars 行被清了(race / 后台清理) → 同样的兜底
    return c.json({ error: 'not_found' }, 404)
  }

  // Step 3: 从 MinIO/S3 流式拉对象
  let download: Awaited<ReturnType<typeof streamDownload>>
  try {
    download = await streamDownload(avatar.bucketKey)
  } catch (err) {
    console.warn('[avatar raw] streamDownload failed', avatar.bucketKey, err)
    return c.json({ error: 'storage_unavailable' }, 502)
  }

  c.header('Content-Type', avatar.mime)
  if (typeof avatar.sizeBytes === 'number') {
    c.header('Content-Length', String(avatar.sizeBytes))
  }
  // 头像变化频率不高,但 user_id 段可能切回同一 ref —— 5min 缓存;
  // 同 attachments raw 行为保持一致
  c.header('Cache-Control', 'private, max-age=300')
  return c.body(Readable.toWeb(download.body) as ReadableStream)
})
