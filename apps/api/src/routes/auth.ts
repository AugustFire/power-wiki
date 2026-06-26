/**
 * Auth routes — mounted at /api/auth (BEFORE requireAuth in apps/api/src/index.ts).
 *
 *   POST   /api/auth/sign-in              body {email, password}
 *   POST   /api/auth/sign-out             (cookie required, kills session)
 *   GET    /api/auth/session              (returns current user or 401)
 *   POST   /api/auth/reset-password       body {currentPassword, newPassword}
 *
 * Error model:
 *   400 invalid_input         zod validation failed
 *   401 unauthorized          bad credentials / no session / expired
 *   403 account_disabled      user.status === 'disabled' (admin-disabled)
 *   200 OK on success
 *   204 No Content on sign-out
 *
 * Sign-in deliberately does NOT distinguish "user not found" from "wrong password"
 * — both return the same 401 with the same message. This prevents account
 * enumeration. The error message stays generic ("邮箱或密码错误").
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  ResetPasswordInputSchema,
  SignInInputSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { users } from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { hashPassword, verifyPassword } from '../auth/password'
import { createSession, deleteSession, getSessionUser } from '../auth/session'
import { rowToUser } from '../lib/rowMappers'

export const authRouter = new Hono<{ Variables: Variables }>()

// ─── POST /api/auth/sign-in ──────────────────────────────────────────────────
authRouter.post('/sign-in', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = SignInInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { email, password } = parsed.data

  const row = (
    await db.select().from(users).where(eq(users.email, email)).limit(1)
  )[0]

  // Generic 401 for both "no such user" and "wrong password" — prevents enumeration.
  if (!row || !(await verifyPassword(password, row.passwordHash))) {
    return c.json({ error: 'unauthorized', message: '邮箱或密码错误' }, 401)
  }

  if (row.status === 'disabled') {
    return c.json(
      { error: 'account_disabled', message: '账号已被禁用,请联系管理员' },
      403,
    )
  }

  await createSession(c, row.id)
  // Update lastLoginAt (fire-and-forget; if it fails we don't want to block sign-in).
  db.update(users)
    .set({ lastLoginAt: Date.now(), updatedAt: Date.now() })
    .where(eq(users.id, row.id))
    .catch(() => {})

  const user = rowToUser(row)
  return c.json({
    user: UserSchema.parse(user),
    mustResetPassword: user.status === 'must_reset_password',
  })
})

// ─── POST /api/auth/sign-out ────────────────────────────────────────────────
authRouter.post('/sign-out', async (c) => {
  await deleteSession(c)
  return c.body(null, 204)
})

// ─── GET /api/auth/session ──────────────────────────────────────────────────
authRouter.get('/session', async (c) => {
  const user = await getSessionUser(c)
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  // We don't have createdAt/updatedAt/lastLoginAt on the lightweight AuthenticatedUser,
  // so re-fetch from DB. Cheap; cached by Postgres for the rest of the request.
  const row = (
    await db.select().from(users).where(eq(users.id, user.id)).limit(1)
  )[0]
  if (!row) return c.json({ error: 'unauthorized' }, 401)
  const full = rowToUser(row)
  return c.json({
    user: UserSchema.parse(full),
    mustResetPassword: full.status === 'must_reset_password',
  })
})

// ─── POST /api/auth/reset-password ──────────────────────────────────────────
// Requires an active session — used both for first-login forced reset AND for
// the user's own voluntary password change.
authRouter.post('/reset-password', requireAuth, async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = ResetPasswordInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { currentPassword, newPassword } = parsed.data

  const row = (
    await db.select().from(users).where(eq(users.id, me.id)).limit(1)
  )[0]
  if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
    return c.json({ error: 'unauthorized', message: '当前密码不正确' }, 401)
  }

  const newHash = await hashPassword(newPassword)
  const now = Date.now()
  await db
    .update(users)
    .set({ passwordHash: newHash, status: 'active', updatedAt: now })
    .where(eq(users.id, me.id))

  const updated = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0]!
  return c.json({ user: UserSchema.parse(rowToUser(updated)) })
})
