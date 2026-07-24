/**
 * Session management — DB-backed opaque tokens stored in HTTP-only cookies.
 *
 * Why DB-backed instead of JWT: revocation is trivial (delete the row).
 * A JWT scheme would require either short TTLs + a refresh dance or a
 * server-side blocklist — both more moving parts than just `DELETE FROM sessions`.
 *
 * Cookie shape:
 *   name:  `pw_session`
 *   value: the session id (also the `sessions.id` PK)
 *   flags: HttpOnly, SameSite=Lax, Path=/, Max-Age=30d
 *           Secure is only set when the request is HTTPS — so local dev over
 *           http://127.0.0.1:5173 still works.
 *
 * Token rotation: we don't rotate on every request (would invalidate parallel
 * tabs). Sessions live 30 days from creation; they're deleted on sign-out.
 * Expired rows are cleaned up lazily by `purgeExpiredSessions()` (called from
 * bootstrap on boot — cheap enough for an internal wiki).
 */
import { eq, lt } from 'drizzle-orm'
import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { db } from '../db/client'
import { sessions, users } from '../db/schema'
import { generateSessionId } from '../lib/ids'

export const SESSION_COOKIE = 'pw_session'
const SESSION_DAYS = 30
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000

export interface AuthenticatedUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled' | 'must_reset_password' | 'anonymized'
  color: string
  createdAt: number
  updatedAt: number
  lastLoginAt: number | null
}

/** Creates a session row and writes the cookie on the response. */
export async function createSession(c: Context, userId: string): Promise<{ id: string; expiresAt: number }> {
  const id = generateSessionId()
  const now = Date.now()
  const expiresAt = now + SESSION_MS
  await db.insert(sessions).values({ id, userId, expiresAt, createdAt: now })
  setSessionCookie(c, id, expiresAt)
  return { id, expiresAt }
}

/**
 * Looks up the session from the cookie, joins the user, returns the user if
 * the session is valid AND the user is not disabled. Returns null otherwise.
 *
 * The `disabled` check is intentional: a disabled user with a valid session
 * should be locked out immediately without waiting for the cookie to expire.
 */
export async function getSessionUser(c: Context): Promise<AuthenticatedUser | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      color: users.color,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, token))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  if (row.expiresAt < Date.now()) {
    // Lazy cleanup — delete the expired row so it doesn't accumulate.
    await db.delete(sessions).where(eq(sessions.id, token))
    clearSessionCookie(c)
    return null
  }
  if (row.status === 'disabled' || row.status === 'anonymized') {
    // Anonymized users have their passwordHash randomized + email set to
    // a .invalid sentinel, but we still reject the session here for
    // defense-in-depth so a leftover cookie can't reactivate a row.
    clearSessionCookie(c)
    return null
  }
  return {
    id: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
  }
}

export async function deleteSession(c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await db.delete(sessions).where(eq(sessions.id, token))
  }
  clearSessionCookie(c)
}

function setSessionCookie(c: Context, token: string, expiresAt: number) {
  const isHttps = c.req.url.startsWith('https://')
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps,
    path: '/',
    expires: new Date(expiresAt),
  })
}

function clearSessionCookie(c: Context) {
  setCookie(c, SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  })
}

/**
 * Best-effort cleanup; called from bootstrap. Safe to run repeatedly.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, Date.now()))
    .returning({ id: sessions.id })
  return result.length
}
