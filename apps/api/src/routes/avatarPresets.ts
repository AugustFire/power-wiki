/**
 * Public avatar presets — GET /api/avatars/presets
 *
 *   公开访问(无 requireAuth):跟 GET /api/user-avatars/:userId/raw 同档,
 *   头像相关元数据对外公开(便于未登录页或登录前预览)。
 *
 *   M11 v2:不再写死 AVATAR_PRESETS enum。运行时扫 apps/web/public/avatars/
 *   目录,过滤白名单 mime,返 `[{slug, file, mime}]` 给前端 SettingsDrawer
 *   grid + UserAvatar lookup。放新 PNG 进 public/avatars/ → 等 60s
 *   缓存过期或重启 api → 立刻出现在 grid;零代码改动。
 *
 *   必须挂在独立 router,在 `app.use('/api/*', requireAuth)` 之前 mount
 *   (见 apps/api/src/index.ts)。理由同 avatarRawRouter。
 */
import { Hono } from 'hono'
import { listPresetAvatars } from '../lib/presetAvatars'
import type { Variables } from '../auth/middleware'

export const avatarPresetsRouter = new Hono<{ Variables: Variables }>()

avatarPresetsRouter.get('/avatars/presets', (c) => {
  return c.json({ presets: listPresetAvatars() })
})
