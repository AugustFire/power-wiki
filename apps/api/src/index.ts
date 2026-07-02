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
import { pagesRouter } from './routes/pages'
import { pageVersionsRouter } from './routes/pageVersions'
import { pageLabelsRouter } from './routes/pageLabels'
import { authRouter } from './routes/auth'
import { spacesRouter } from './routes/spaces'
import { commentsRouter } from './routes/comments'
import { notificationsRouter } from './routes/notifications'
import { adminUsersRouter } from './routes/adminUsers'
import { adminGroupsRouter } from './routes/adminGroups'
import { adminSpacesRouter } from './routes/adminSpaces'
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

// Everything else requires a valid session.
app.use('/api/*', requireAuth)

app.route('/api/pages', pagesRouter)
// Stage 8 sub-routers — also mounted under /api/pages so the URLs stay
// grouped with the pages domain (versions + labels are page-scoped).
app.route('/api/pages', pageVersionsRouter)
app.route('/api/pages', pageLabelsRouter)
// /api/labels is mounted from the same router instance — Hono supports
// mounting the same router at multiple prefixes.
app.route('/api/labels', pageLabelsRouter)
app.route('/api/spaces', spacesRouter)
app.route('/api/comments', commentsRouter)
app.route('/api/notifications', notificationsRouter)
app.route('/api/admin/users', adminUsersRouter)
app.route('/api/admin/groups', adminGroupsRouter)
app.route('/api/admin/spaces', adminSpacesRouter)

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

app.onError((err, c) => {
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
