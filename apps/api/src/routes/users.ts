/**
 * Self-service user routes — Stage P1-6.
 *
 *   GET   /api/users/me          current user
 *   PATCH /api/users/me          update current user's name / color
 *
 * Auth: requireAuth (not admin-only — every authenticated user can edit
 * their own profile). Mounted at `/api/users` in apps/api/src/index.ts,
 * AFTER the global requireAuth gate, so middleware auto-applies.
 *
 * Why a separate router (not extending /api/auth or /api/admin/users)?
 *   - /api/auth/* is public auth flow (sign-in / sign-out / session /
 *     reset-password). Self-service profile read/write is NOT auth flow —
 *     it requires a session.
 *   - /api/admin/users/* is admin-only (admin middleware). Putting the
 *     self-service endpoint there would force it through requireAdmin,
 *     which is the opposite of what we want.
 *   - Mounting at /api/users keeps the URL hierarchy aligned with the
 *     resource ("users about me") rather than the action ("auth me").
 *
 * Validation: reuses `UpdateUserInputSchema` (name optional, color
 * #RGB / #RRGGBB). For non-admin users updating themselves, the role
 * field is NOT exposed — privilege escalation should go through admin.
 *
 * Per CLAUDE.md "不主动 commit / push": changes stay local; user says
 * "提交吧" before any git commit/push.
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { UpdateUserInputSchema, UserSchema } from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { users } from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { rowToUser } from '../lib/rowMappers'

export const usersRouter = new Hono<{ Variables: Variables }>()

// All /api/users/* routes require a session; the global requireAuth in
// index.ts already covers it but applying it here makes the router
// self-contained (in case it's mounted elsewhere later, e.g. tests).
usersRouter.use('*', requireAuth)

// ─── GET /api/users/me ─────────────────────────────────────────────────────
// Returns the current user's full User row. Mirrors the shape of the
// sign-in response's `user` field so the client can re-use its existing
// User types.
usersRouter.get('/me', async (c) => {
  const me = c.get('user')
  const row = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0]
  if (!row) {
    // Should not happen — c.var.user came from the same row. Defensive
    // 401 so the client can recover by re-signing-in.
    return c.json({ error: 'unauthorized' }, 401)
  }
  return c.json(UserSchema.parse(rowToUser(row)))
})

// ─── PATCH /api/users/me ───────────────────────────────────────────────────
// Self-service name / color update. Same payload schema as the admin
// PATCH /api/admin/users/:id (UpdateUserInputSchema — name/color only).
// Returns the updated user so the client can refresh its authStore in one
// round-trip.
usersRouter.patch('/me', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateUserInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const patch: { name?: string; color?: string; updatedAt: number } = {
    updatedAt: Date.now(),
  }
  if (parsed.data.name !== undefined) {
    const trimmed = parsed.data.name.trim()
    if (trimmed.length === 0) {
      return c.json({ error: 'invalid_input', message: '姓名不能为空' }, 400)
    }
    patch.name = trimmed
  }
  if (parsed.data.color !== undefined) patch.color = parsed.data.color

  await db.update(users).set(patch).where(eq(users.id, me.id))
  const updated = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0]
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json(UserSchema.parse(rowToUser(updated)))
})
