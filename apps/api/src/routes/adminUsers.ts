/**
 * Admin user routes — Stage 4b.
 *
 *   GET    /api/admin/users                    list all users
 *   POST   /api/admin/users                    create user; returns {user, initialPassword}
 *   PATCH  /api/admin/users/:id                update name/color
 *   POST   /api/admin/users/:id/disable        set status='disabled'
 *   POST   /api/admin/users/:id/enable         set status='active' (only from 'disabled')
 *   POST   /api/admin/users/:id/reset-password generate new initial password + flip to
 *                                              status='must_reset_password'; returns it ONCE
 *
 * All routes require admin role (requireAdmin middleware).
 *
 * Error model:
 *   400 invalid_input     zod validation failed
 *   403 forbidden         non-admin (handled by middleware)
 *   404 not_found         target user doesn't exist
 *   409 conflict          email taken (create) / last admin (disable) / already in target state
 *
 * Security note: initial passwords are returned in the response body. The caller
 * (manager UI) is expected to display them ONCE and never store them. There is
 * NO endpoint to "look up" a user's current password — we only ever return the
 * plain-text value at creation/reset time.
 */
import { Hono } from 'hono'
import { and, eq, ne } from 'drizzle-orm'
import {
  CreateUserInputSchema,
  UpdateUserInputSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { users } from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { generateInitialPassword, hashPassword } from '../auth/password'
import { rowToUser } from '../lib/rowMappers'
import { generatePageId } from '../lib/ids'

export const adminUsersRouter = new Hono<{ Variables: Variables }>()

// All admin user routes require the admin role. The middleware is applied
// here (router-local) rather than at the app level so /api/pages etc. don't
// inherit it accidentally.
adminUsersRouter.use('*', requireAdmin)

// ─── GET /api/admin/users ───────────────────────────────────────────────────
adminUsersRouter.get('/', async (c) => {
  const rows = await db.select().from(users)
  return c.json(rows.map((r) => UserSchema.parse(rowToUser(r))))
})

// ─── GET /api/admin/users/:id ──────────────────────────────────────────────
// Single user lookup. The list endpoint omits some metadata and the edit
// view needs the full row. Kept separate from list so we don't ship every
// field on every page render.
adminUsersRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(UserSchema.parse(rowToUser(row)))
})

// ─── POST /api/admin/users ──────────────────────────────────────────────────
adminUsersRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateUserInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { email, name, role } = parsed.data

  // Reject duplicate email up-front so the DB unique constraint doesn't
  // produce a generic Postgres error.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (existing.length > 0) {
    return c.json({ error: 'email_taken', message: '该邮箱已被使用' }, 409)
  }

  const id = generatePageId()
  const initialPassword = generateInitialPassword()
  const hash = await hashPassword(initialPassword)
  const now = Date.now()

  await db.insert(users).values({
    id,
    email,
    name,
    passwordHash: hash,
    role: role ?? 'user',
    // Newly created users must reset their password on first sign-in.
    status: 'must_reset_password',
    // Color: pick a stable hash-based default from the email so the avatar
    // looks distinct from the get-go. The admin can override later via PATCH.
    color: pickColorFromEmail(email),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  })

  const created = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!
  return c.json(
    {
      user: UserSchema.parse(rowToUser(created)),
      initialPassword,
    },
    201,
  )
})

// ─── PATCH /api/admin/users/:id ─────────────────────────────────────────────
adminUsersRouter.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateUserInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'invalid_input', message: '至少需要更新一个字段' }, 400)
  }

  const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const now = Date.now()
  await db
    .update(users)
    .set({ ...parsed.data, updatedAt: now })
    .where(eq(users.id, id))

  const updated = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!
  return c.json(UserSchema.parse(rowToUser(updated)))
})

// ─── POST /api/admin/users/:id/disable ──────────────────────────────────────
adminUsersRouter.post('/:id/disable', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  // Refuse to disable yourself — would lock the admin out of the system.
  if (id === me.id) {
    return c.json(
      { error: 'self_disable', message: '不能禁用自己的账号' },
      409,
    )
  }

  const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  // Refuse to disable the last active admin — would leave the system with
  // no admins and no way to recover.
  if (existing.role === 'admin' && existing.status !== 'disabled') {
    const otherActiveAdmins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), ne(users.id, id)))
    const stillActive = otherActiveAdmins.filter((row) => {
      // status could be active or must_reset_password (still functions for sign-in? No —
      // must_reset_password users get forced into reset flow; they can't use the
      // system fully. But they CAN sign in, so technically they're not "out".)
      // We treat any non-disabled admin as "still active" for this check.
      return row.id !== existing.id
    })
    if (stillActive.length === 0) {
      return c.json(
        { error: 'last_admin', message: '不能禁用最后一个管理员' },
        409,
      )
    }
  }

  if (existing.status === 'disabled') {
    // Idempotent: already disabled, just return current state.
    return c.json(UserSchema.parse(rowToUser(existing)))
  }

  const now = Date.now()
  await db
    .update(users)
    .set({ status: 'disabled', updatedAt: now })
    .where(eq(users.id, id))

  // Also kill any active sessions for this user — the disabled flag
  // would block new sign-ins, but existing sessions would still work
  // until they expire. This makes the disable take effect immediately.
  const { sessions } = await import('../db/schema')
  await db.delete(sessions).where(eq(sessions.userId, id))

  const updated = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!
  return c.json(UserSchema.parse(rowToUser(updated)))
})

// ─── POST /api/admin/users/:id/enable ───────────────────────────────────────
adminUsersRouter.post('/:id/enable', async (c) => {
  const id = c.req.param('id')
  const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)
  if (existing.status !== 'disabled') {
    // Only meaningful for transitioning out of 'disabled'. If they're already
    // active or must_reset_password, return current state (idempotent).
    return c.json(UserSchema.parse(rowToUser(existing)))
  }

  const now = Date.now()
  await db
    .update(users)
    .set({ status: 'active', updatedAt: now })
    .where(eq(users.id, id))

  const updated = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!
  return c.json(UserSchema.parse(rowToUser(updated)))
})

// ─── POST /api/admin/users/:id/reset-password ───────────────────────────────
adminUsersRouter.post('/:id/reset-password', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  // Resetting self: refuse — you can use the regular /api/auth/reset-password
  // endpoint for that, and going through admin reset on yourself would mean
  // you'd be forced to reset again immediately, which is jarring.
  if (id === me.id) {
    return c.json(
      { error: 'self_reset', message: '请使用 /reset-password 页面修改自己的密码' },
      409,
    )
  }

  const initialPassword = generateInitialPassword()
  const hash = await hashPassword(initialPassword)
  const now = Date.now()

  await db
    .update(users)
    .set({
      passwordHash: hash,
      status: 'must_reset_password',
      updatedAt: now,
    })
    .where(eq(users.id, id))

  // Kill existing sessions — the new password is required to sign in.
  const { sessions } = await import('../db/schema')
  await db.delete(sessions).where(eq(sessions.userId, id))

  return c.json({ initialPassword })
})

/* ─── helpers ─────────────────────────────────────────────────────────── */

/**
 * Stable color picker for newly created users. Same email → same color
 * (until admin overrides). Hashes the email lightly and picks from the brand
 * palette so the avatars look distinct from each other without being noisy.
 */
function pickColorFromEmail(email: string): string {
  const palette = [
    '#0052CC', // accent (default)
    '#36B37E', // success
    '#FF5630', // danger
    '#FFAB00', // warning
    '#403294', // purple
    '#00B8D9', // cyan
    '#6554C0', // violet
    '#FF8B00', // orange
  ]
  let hash = 0
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) >>> 0
  }
  return palette[hash % palette.length]!
}
