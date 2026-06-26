/**
 * Auth middleware for Hono.
 *
 * - `requireAuth`: looks up the session from the cookie, attaches the user
 *   to `c.var.user`. Returns 401 if missing/invalid/expired/disabled.
 * - `requireAdmin`: extends requireAuth — additionally 403s non-admins.
 *
 * These middlewares do NOT cover the `/api/auth/*` routes themselves —
 * `apps/api/src/index.ts` mounts those BEFORE `app.use('/api/*', requireAuth)`,
 * so they don't go through this gate. Same for `/api/health`.
 *
 * The `user` field on context is typed via `HonoContextVariables` so route
 * handlers can `import type { AppContext } from '...'` and use `c.var.user`
 * without a cast.
 */
import { createMiddleware } from 'hono/factory'
import type { AuthenticatedUser } from './session'
import { getSessionUser } from './session'

export type Variables = {
  user: AuthenticatedUser
}

export const requireAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const user = await getSessionUser(c)
  if (!user) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  c.set('user', user)
  await next()
})

export const requireAdmin = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const user = await getSessionUser(c)
  if (!user) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (user.role !== 'admin') {
    return c.json({ error: 'forbidden', message: '需要管理员权限' }, 403)
  }
  c.set('user', user)
  await next()
})
