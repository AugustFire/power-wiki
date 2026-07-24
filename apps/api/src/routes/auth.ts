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
 *   403 account_disabled      user.status === 'disabled' | 'anonymized' (admin-disabled / anonymized)
 *   200 OK on success
 *   204 No Content on sign-out
 *
 * Sign-in deliberately does NOT distinguish "user not found" from "wrong password"
 * — both return the same 401 with the same message. This prevents account
 * enumeration. The error message stays generic ("邮箱或密码错误").
 */
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { and, eq, ne } from 'drizzle-orm'
import {
  ResetPasswordInputSchema,
  ResetPasswordResponseSchema,
  SignInInputSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { sessions, spaces, users } from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { hashPassword, verifyPassword } from '../auth/password'
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  getSessionUser,
} from '../auth/session'
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

  if (row.status === 'disabled' || row.status === 'anonymized') {
    // 403 message is intentionally generic — we don't leak whether the
    // account was disabled vs anonymized. Anonymized rows have their
    // passwordHash randomized + email=@.invalid, so this is defense-in-
    // depth: even if some other path produced a non-null row here, we
    // still refuse sign-in.
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
  const personalSpaceId = await findPersonalSpaceId(row.id)
  return c.json({
    user: UserSchema.parse(user),
    mustResetPassword: user.status === 'must_reset_password',
    personalSpaceId,
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
  const personalSpaceId = await findPersonalSpaceId(row.id)
  return c.json({
    user: UserSchema.parse(full),
    mustResetPassword: full.status === 'must_reset_password',
    personalSpaceId,
  })
})

// ─── POST /api/auth/reset-password ──────────────────────────────────────────
// Requires an active session — used both for first-login forced reset AND for
// the user's own voluntary password change.
//
// Side effect: after the password actually changes, delete every other session
// row for this user. This is the "I think my account was compromised" path —
// if someone has the old password on another device, that device's session row
// is dropped on the next request and they're bounced back to sign-in. We keep
// the row that made *this* request (the user who just changed the password is
// presumably not the attacker).
//
// Failure mode: if the DELETE fails after the password UPDATE succeeded, the
// password is still changed (defense in depth — sessions are DB-backed and
// do NOT re-check password on every request, so a stuck row would still grant
// access until its 30d TTL). We don't wrap in a transaction because the
// existing session-lifecycle pattern (see auth/session.ts) is also single-
// statement; the password change is the load-bearing defense, the session
// purge is the UX bonus.
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

  // 拿当前 sessionId(改密的是谁,留谁的 session)。
  // SESSION_COOKIE 不存在 = 当前请求不带 session,但 requireAuth 已经拦了,
  // 所以一定有值 —— 拿不到的话 fallback 到「不留」,等于踢掉自己 = 下次访问
  // 重新登录,也是合理行为(异常路径,不该发生)。
  const currentSessionId = getCookie(c, SESSION_COOKIE)
  const kicked = await db
    .delete(sessions)
    .where(
      currentSessionId
        ? and(eq(sessions.userId, me.id), ne(sessions.id, currentSessionId))
        : eq(sessions.userId, me.id),
    )
    .returning({ id: sessions.id })
  const kickedSessions = kicked.length

  const updated = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0]!
  const personalSpaceId = await findPersonalSpaceId(me.id)
  return c.json(
    ResetPasswordResponseSchema.parse({
      user: rowToUser(updated),
      personalSpaceId,
      kickedSessions,
    }),
  )
})

/**
 * Look up the user's personal space id (kind='personal' with ownerId=userId).
 * Returns null if the user doesn't have one (shouldn't happen post-bootstrap,
 * but be defensive). One SELECT, no transaction needed.
 */
async function findPersonalSpaceId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerId, userId), eq(spaces.kind, 'personal')))
    .limit(1)
  return row?.id ?? null
}
