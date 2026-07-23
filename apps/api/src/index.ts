/**
 * Hono entry point.
 *
 * Listens on PORT (default 8787), exposes /api/* under apps/api/src/routes/.
 * In dev (`NODE_ENV !== 'production'`) auto-runs Drizzle migrations on startup
 * so the dev loop is `docker compose up -d && pnpm -F api dev` and nothing else.
 * Production migrations must be applied separately (CI / release script).
 *
 * Middleware order (matters!):
 *   1. CORS — applies to everything
 *   2. /health — public
 *   3. /api/auth/* — public (sign-in, sign-out, session, reset-password itself
 *      requires a session, but the route is mounted here so the URL path
 *      isn't blocked by requireAuth)
 *   4. requireAuth — applies to ALL remaining /api/* (pages, admin, spaces)
 *   5. routers for the gated routes
 *
 * Stage 4a only mounts authRouter + pagesRouter. Admin + spaces routers are
 * added in 4b / 4c.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from './db/client'
import { mapPgError } from './lib/dbErrors'
import { pagesRouter } from './routes/pages'
import { pageVersionsRouter } from './routes/pageVersions'
import { pageLabelsRouter } from './routes/pageLabels'
import { attachmentsRouter } from './routes/attachments'
import { searchRouter } from './routes/search'
import { authRouter } from './routes/auth'
import { spacesRouter } from './routes/spaces'
import { spacePermissionsRouter } from './routes/spacePermissions'
import { pageRestrictionsRouter } from './routes/pageRestrictions'
import { pageSharesRouter } from './routes/pageShares'
import { publicSharesRouter } from './routes/publicShares'
import { commentsRouter } from './routes/comments'
import { notificationsRouter } from './routes/notifications'
import { adminUsersRouter } from './routes/adminUsers'
import { adminGroupsRouter } from './routes/adminGroups'
import { adminSpacesRouter } from './routes/adminSpaces'
import { adminSettingsRouter } from './routes/adminSettings'
import { adminAuditRouter } from './routes/adminAudit'
import { usersRouter } from './routes/users'
import { avatarRawRouter } from './routes/avatarRaw'
import { avatarPresetsRouter } from './routes/avatarPresets'
import { requireAuth, type Variables } from './auth/middleware'
import { runBootstrap } from './auth/bootstrap'

const PORT = Number(process.env.PORT ?? 8787)
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5173'
const NODE_ENV = process.env.NODE_ENV ?? 'development'

const app = new Hono<{ Variables: Variables }>()

app.use(
  '*',
  cors({
    origin: CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  }),
)

app.get('/health', (c) => c.json({ ok: true, env: NODE_ENV }))

// Public — auth flow itself must not require an existing session.
app.route('/api/auth', authRouter)

// M11: 公开头像 raw proxy(同 username 一样对外公开,不在 requireAuth 之后)。
// 必须放在 app.use('/api/*', requireAuth) 之前 —— 任何 /api/* 路径
// 都会被全局 gate 兜走。用独立前缀 /api/user-avatars 也避免跟
// usersRouter(自己 use('*', requireAuth)) 路径冲突
app.route('/api/user-avatars', avatarRawRouter)

// M11 v2: 公开预设清单(apps/web/public/avatars/ 扫盘结果)。
// 同 avatarRaw 一样,头像元数据对外公开,放在 requireAuth 之前。
app.route('/api', avatarPresetsRouter)

// Phase D: 公开分享 GET —— 匿名访问。必须放在 requireAuth 之前,
// 否则被全局 gate 兜走变 401。mount 顺序敏感,见 plan §D.4 #13。
app.route('/api', publicSharesRouter)

// Everything else requires a valid session.
app.use('/api/*', requireAuth)

app.route('/api/pages', pagesRouter)
// Stage 8 sub-routers — also mounted under /api/pages so the URLs stay
// grouped with the pages domain (versions + labels are page-scoped).
app.route('/api/pages', pageVersionsRouter)
app.route('/api/pages', pageLabelsRouter)
// Phase B: 页面级 view/edit 限制(挂在 /api/pages 同前缀,跟 pagesRouter
// 共享 /api/pages/:id/restrictions 这类路径)。router 内部 requireAuth +
// canManageRestrictions(作者 / space-admin / global admin 三选一)细判,
// 跟 pagesRouter 职责分开。
app.route('/api/pages', pageRestrictionsRouter)
// Phase D: 公开链接管理(POST/GET/DELETE /api/pages/:id/share[/...]).
// 挂在 /api/pages 同前缀,跟 pageRestrictions 对称;需 auth + edit-access。
app.route('/api/pages', pageSharesRouter)
// /api/labels is mounted from the same router instance — Hono supports
// mounting the same router at multiple prefixes.
app.route('/api/labels', pageLabelsRouter)
app.route('/api/attachments', attachmentsRouter)
app.route('/api/spaces', spacesRouter)
// Phase A:空间角色管理(挂在 /api/spaces 同前缀,跟 spacesRouter 共用
// /api/spaces/:id/permissions 这类路径)。router 内部用 requireAuth
// + canAdminSpace 二级判定,跟 spacesRouter(读 visibility 用)职责分开。
app.route('/api/spaces', spacePermissionsRouter)
app.route('/api/comments', commentsRouter)
app.route('/api/notifications', notificationsRouter)
app.route('/api/admin/users', adminUsersRouter)
app.route('/api/admin/groups', adminGroupsRouter)
app.route('/api/admin/spaces', adminSpacesRouter)
// P1-8: admin-only settings (trash retention, etc).
app.route('/api/admin/settings', adminSettingsRouter)
// Phase C: admin-only 权限变更审计日志。
app.route('/api/admin', adminAuditRouter)
// P1-6: self-service user routes (current user profile read/write).
// Mounted at /api/users, AFTER the global requireAuth gate.
app.route('/api/users', usersRouter)
app.route('/api/search', searchRouter)

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

app.onError((err, c) => {
  const mapped = mapPgError(err)
  if (mapped) return c.json(mapped.body, mapped.status)
  console.error('[api] unhandled', err)
  return c.json({ error: 'internal', message: err.message }, 500)
})

async function main() {
  if (NODE_ENV !== 'production') {
    console.log('[api] running migrations (dev mode)…')
    await migrate(db, { migrationsFolder: './src/db/migrations' })
    console.log('[api] migrations ok')
  }

  // Bootstrap admin (if users empty) + purge expired sessions.
  // Runs AFTER migrations so new tables are present.
  await runBootstrap()

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[api] listening on http://127.0.0.1:${info.port}`)
  })
}

main().catch((err) => {
  console.error('[api] fatal', err)
  pool.end()
  process.exit(1)
})
