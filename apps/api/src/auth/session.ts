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
  /** M11 用户头像(2026-08-05 Phase A 协同 Phase 1 落地加):原本
   *  AuthenticatedUser 只够 requireAuth 用,新加 awareness 上下文要把
   *  avatar 字段也带过去,否则 server 端 user shape 跟前端 User 不一致。
   *  avatar_kind CHECK 限定 'preset' | 'custom' | NULL,沿用 User avatarKind
   *  literal 联合。 */
  avatarKind: 'preset' | 'custom' | null
  avatarRef: string | null
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
  const user = await resolveSessionToken(token)
  if (!user) clearSessionCookie(c)
  return user
}

/**
 * Cookie-string 形态的 session lookup —— 给 Hocuspocus WebSocket upgrade 路径用。
 *
 * Hocuspocus 的 onAuthenticate 拿到的是 Node IncomingMessage,不是 Hono
 * Context;没法直接复用 getSessionUser(getCookie(c, ...))。这条路径解析
 * `payload.request.headers.cookie`,剥出 pw_session,委托给 resolveSessionToken
 * —— 跟 HTTP 路径同款 SELECT,确保 disabled/anonymized 一律拒。
 *
 * 不在这里清 cookie(HTTP-only 标志 WS upgrade 没法 Set-Cookie),所以
 * 401 之后 cookie 留到下一次 HTTP 请求才被 middleware 清。开销可忽略。
 */
export async function resolveSessionFromCookieHeader(
  cookieHeader: string | null | undefined,
): Promise<AuthenticatedUser | null> {
  if (!cookieHeader) return null
  // 简单 cookie 解析:不依赖 cookie 库,只读 pw_session 的 value。
  const match = /(?:^|;\s*)pw_session=([^;]+)/.exec(cookieHeader)
  if (!match) return null
  const token = decodeURIComponent(match[1]!)
  if (!token) return null
  return resolveSessionToken(token)
}

/**
 * 共享的 SELECT + 过期/状态校验。HTTP / WS 两条入口都走这里。
 * 不调 clearSessionCookie —— 那需要 Hono Context;HTTP 入口(getSessionUser)
 * 自己负责清。
 */
async function resolveSessionToken(token: string): Promise<AuthenticatedUser | null> {
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
      avatarKind: users.avatarKind,
      avatarRef: users.avatarRef,
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
    return null
  }
  if (row.status === 'disabled' || row.status === 'anonymized') {
    // Anonymized users have their passwordHash randomized + email set to
    // a .invalid sentinel, but we still reject the session here for
    // defense-in-depth so a leftover cookie can't reactivate a row.
    return null
  }
  return {
    id: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    color: row.color,
    // users.avatar_kind 列 CHECK 限定 'preset' | 'custom' | NULL,但
    // Drizzle text() 不推 literal 联合 —— 显式 narrow。
    avatarKind: (row.avatarKind ?? null) as AuthenticatedUser['avatarKind'],
    avatarRef: row.avatarRef ?? null,
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
