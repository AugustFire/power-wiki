/**
 * Admin user routes — Stage 4b.
 *
 *   GET    /api/admin/users                    list all users
 *   POST   /api/admin/users                    create user; returns {user, initialPassword}
 *   PATCH  /api/admin/users/:id                update name/color
 *   POST   /api/admin/users/:id/disable        set status='disabled'
 *   POST   /api/admin/users/:id/enable         set status='active' (only from 'disabled';
 *                                              anonymized returns 409 invalid_state —
 *                                              M16;identity was scrubbed, no recovery)
 *   POST   /api/admin/users/:id/reset-password generate new initial password + flip to
 *                                              status='must_reset_password'; returns it ONCE
 *   POST   /api/admin/users/:id/anonymize      irreversible "soft delete": clears name /
 *                                              email / password / avatar, sets status to
 *                                              'anonymized' (M16 4th state, no longer
 *                                              'disabled'), kills sessions, sweeps all
 *                                              membership tables, audit row written.
 *                                              pages / comments / versions / attachments
 *                                              / audit rows PRESERVED for attribution
 *                                              (LEFT JOIN shows anonymized display name).
 *
 * All routes require admin role (requireAdmin middleware).
 *
 * Error model:
 *   400 invalid_input     zod validation failed / target is self / target is last admin
 *   403 forbidden         non-admin (handled by middleware)
 *   404 not_found         target user doesn't exist
 *   409 conflict          email taken (create) / last admin (disable / anonymize) /
 *                         already in target state / anonymized is terminal
 *                         (enable on anonymized → invalid_state)
 *
 * Security note: initial passwords are returned in the response body. The caller
 * (manager UI) is expected to display them ONCE and never store them. There is
 * NO endpoint to "look up" a user's current password — we only ever return the
 * plain-text value at creation/reset time.
 */
import { Hono } from 'hono'
import { and, asc, count, desc, eq, ilike, ne, or, sql } from 'drizzle-orm'
import {
  AdminUsersListQuerySchema,
  AdminUsersListResponseSchema,
  CreateUserInputSchema,
  UpdateUserInputSchema,
  UserSchema,
  UserSummarySchema,
} from '@power-wiki/shared/schemas'
import type { UserSummary, UserSystemStats } from '@power-wiki/shared'
import { db } from '../db/client'
import {
  notifications,
  pageLikes,
  pageRestrictions,
  sessions,
  spaceRoleGrants,
  spaces,
  userGroupMembers,
  userGroups,
  userRecentPages,
  userWatchedPages,
  users,
} from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { generateInitialPassword, hashPassword } from '../auth/password'
import { rowToUser } from '../lib/rowMappers'
import { generatePageId } from '../lib/ids'
import { ensurePersonalSpace, personalGroupId } from '../lib/ensurePersonalSpace'
import { recordPermissionAudit } from '../lib/auditLog'

/** Anonymized display name — shown in JOIN fallbacks everywhere authorship
 *  displays. Keep stable: UI strings / snapshots / tests reference this. */
const ANONYMIZED_NAME = '已注销用户'
/** Sentinel email value. Schema requires NOT NULL UNIQUE — we use the user's
 *  own id in the local part so two anonymized users never collide. The TLD
 *  is `.invalid` per RFC 2606 to mark it as a non-deliverable address. */
const anonymizedEmail = (userId: string): string => `${userId}@anonymized.invalid`
/** Gray placeholder color (Atlassian N500-ish) — anonymous users lose all
 *  identity cues, so avatar color should be neutral. */
const ANONYMIZED_COLOR = '#7A869A'

export const adminUsersRouter = new Hono<{ Variables: Variables }>()

// All admin user routes require the admin role. The middleware is applied
// here (router-local) rather than at the app level so /api/pages etc. don't
// inherit it accidentally.
adminUsersRouter.use('*', requireAdmin)

// ─── GET /api/admin/users ───────────────────────────────────────────────────
/**
 * M17: server-side filter — `q` (name/email ILIKE substring), `status` /
 * `role` (enum 精确)。响应包含 `total`(匹配 filter 的总行数,用于 sub-text
 * 「显示 N / 共 M」)+ `systemStats`(system-wide,不受 filter 影响,给右栏
 * 概览用 — filter 不应污染 system dashboard)。
 *
 * 四个并发查询(Promise.all):
 *   1) paginated filtered items(用 LIMIT N+1 技巧拿 hasMore)
 *   2) filtered total count(单条 COUNT)
 *   3) system-wide 统计(单条 COUNT(*) FILTER (WHERE …))
 *   4) top 5 最近登录(单条 ORDER BY DESC LIMIT 5,只返渲染所需字段)
 *
 * 没有「全部加载完才能搜索」的客户端 200 行瓶颈 —— q 命中后第 137 行的
 * 用户也能搜出来。
 */
adminUsersRouter.get('/', async (c) => {
  const parsed = AdminUsersListQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.issues },
      400,
    )
  }
  const { q, status, role, limit, offset = 0 } = parsed.data

  // Build the WHERE clause for items + total (filtered).
  // q → ILIKE on name OR email (case-insensitive substring).
  // status / role → exact enum match. All optional; undefined → no filter.
  const conds = []
  if (q) {
    const pattern = `%${q}%`
    conds.push(or(ilike(users.name, pattern), ilike(users.email, pattern))!)
  }
  if (status) conds.push(eq(users.status, status))
  if (role) conds.push(eq(users.role, role))
  const filterWhere = conds.length > 0 ? and(...conds) : undefined

  // Three concurrent queries — filter-aware items + filtered total + system
  // stats (independent of filter). They're cheap (each touches `users`
  // once; system stats uses a single FILTER aggregation) so no transaction.
  const itemsPromise = (() => {
    let q = db.select().from(users).$dynamic()
    if (filterWhere) q = q.where(filterWhere)
    // Stable order — same reasoning as adminSpaces: nanoid primary keys
    // have no implicit order. createdAt ASC is the LEAST surprising
    // (oldest users first; matches a typical "I want to find the user I
    // added in 2024" mental model).
    q = q.orderBy(asc(users.createdAt))
    if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
    return q
  })()

  const totalPromise = (() => {
    let q = db.select({ n: count() }).from(users).$dynamic()
    if (filterWhere) q = q.where(filterWhere)
    return q
  })()

  // System stats — single aggregate with FILTER (WHERE …) clauses. No
  // FILTER on never_logged_in since IS NULL isn't a boolean expression;
  // use a separate aggregate instead.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const cutoff = sql`${sql.raw(String(Date.now() - SEVEN_DAYS_MS))}`
  const statsPromise = db
    .select({
      totalCount: count(),
      adminCount: sql<number>`COUNT(*) FILTER (WHERE ${users.role} = 'admin')::int`,
      activeCount: sql<number>`COUNT(*) FILTER (WHERE ${users.status} = 'active')::int`,
      mustResetCount: sql<number>`COUNT(*) FILTER (WHERE ${users.status} = 'must_reset_password')::int`,
      disabledCount: sql<number>`COUNT(*) FILTER (WHERE ${users.status} = 'disabled')::int`,
      anonymizedCount: sql<number>`COUNT(*) FILTER (WHERE ${users.status} = 'anonymized')::int`,
      recentlyActiveCount: sql<number>`COUNT(*) FILTER (WHERE ${users.lastLoginAt} IS NOT NULL AND ${users.lastLoginAt} >= ${cutoff})::int`,
      neverLoggedInCount: sql<number>`COUNT(*) FILTER (WHERE ${users.lastLoginAt} IS NULL)::int`,
    })
    .from(users)

  // top 5 最近登录 —— 单条 ORDER BY ... DESC LIMIT 5,只返渲染所需字段。
  // 把 avatar / color 一并 denormalize,前端 UserAvatar 直接吃,不需二次拉。
  const topLoggedInPromise = db
    .select({
      id: users.id,
      name: users.name,
      color: users.color,
      avatarKind: users.avatarKind,
      avatarRef: users.avatarRef,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(sql`${users.lastLoginAt} IS NOT NULL`)
    .orderBy(desc(users.lastLoginAt))
    .limit(5)

  const [rows, totalRow, statsRow, topRows] = await Promise.all([
    itemsPromise,
    totalPromise,
    statsPromise,
    topLoggedInPromise,
  ])

  const total = totalRow[0]?.n ?? 0
  // hasMore = "filtered total > (offset + items.length)"
  const itemsLen = limit !== undefined ? Math.min(rows.length, limit) : rows.length
  const hasMore = limit !== undefined ? rows.length > limit : false
  const items = rows
    .slice(0, itemsLen)
    .map((r) => UserSchema.parse(rowToUser(r)))

  const systemStats: UserSystemStats = {
    totalCount: statsRow[0]?.totalCount ?? 0,
    adminCount: statsRow[0]?.adminCount ?? 0,
    activeCount: statsRow[0]?.activeCount ?? 0,
    mustResetCount: statsRow[0]?.mustResetCount ?? 0,
    disabledCount: statsRow[0]?.disabledCount ?? 0,
    anonymizedCount: statsRow[0]?.anonymizedCount ?? 0,
    recentlyActiveCount: statsRow[0]?.recentlyActiveCount ?? 0,
    neverLoggedInCount: statsRow[0]?.neverLoggedInCount ?? 0,
    topLoggedIn: topRows.map(
      (r): UserSummary =>
        UserSummarySchema.parse({
          id: r.id,
          name: r.name,
          color: r.color,
          avatarKind: r.avatarKind,
          avatarRef: r.avatarRef,
          lastLoginAt: r.lastLoginAt,
        }),
    ),
  }

  const response = AdminUsersListResponseSchema.parse({
    items,
    limit: limit ?? items.length,
    offset,
    hasMore,
    total,
    systemStats,
  })
  return c.json(response)
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
  const color = pickColorFromEmail(email)

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
    color,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  })

  // Provision the user's personal space (1-person group + space + welcome
  // page). Done after the user insert — if it fails, the user still exists
  // and the next bootstrap run will fill in their personal space. We log
  // loudly so the operator notices.
  let personalSpaceId: string | null = null
  try {
    const r = await ensurePersonalSpace({ id, name, color })
    personalSpaceId = r.spaceId
  } catch (err) {
    console.error(`[adminUsers] failed to provision personal space for ${email}:`, err)
  }

  const created = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!
  return c.json(
    {
      user: UserSchema.parse(rowToUser(created)),
      initialPassword,
      personalSpaceId,
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
  const newName = parsed.data.name
  await db
    .update(users)
    .set({ ...parsed.data, updatedAt: now })
    .where(eq(users.id, id))

  // If the user's name changed, sync the personal space + group names so they
  // stay consistent ("<name> 的空间"). Best-effort — log on failure but don't
  // fail the user update (the space will rename next time the user re-saves
  // it manually, or on the next bootstrap pass).
  if (newName && newName !== existing.name) {
    try {
      const [personalSpace] = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.ownerId, id), eq(spaces.kind, 'personal')))
        .limit(1)
      if (personalSpace) {
        await db
          .update(spaces)
          .set({ name: `${newName} 的空间`, updatedAt: now })
          .where(eq(spaces.id, personalSpace.id))
      }
      const groupId = personalGroupId(id)
      await db
        .update(userGroups)
        .set({ name: `${newName} 的个人组` })
        .where(eq(userGroups.id, groupId))
    } catch (err) {
      console.error(`[adminUsers] failed to sync personal space name for ${id}:`, err)
    }
  }

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
  // no admins and no way to recover. 'disabled' / 'anonymized' 都不算
  // 在任,所以这两种状态都跳过 last-admin 检查(M16)。
  if (
    existing.role === 'admin' &&
    existing.status !== 'disabled' &&
    existing.status !== 'anonymized'
  ) {
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

  // Idempotent: already 'disabled' OR 'anonymized' 都是终态-ish,
  // disable 操作无意义,直接回当前状态(M16 起 anonymized 也视为「已禁用」)。
  if (existing.status === 'disabled' || existing.status === 'anonymized') {
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
  if (existing.status === 'anonymized') {
    // Anonymized rows are terminal — identity fields (name / email / password
    // / avatar) are gone, only the row id is preserved for attribution joins.
    // Even if some future code path flips the status, refuse to re-enable.
    return c.json(
      { error: 'invalid_state', message: '已注销的用户不可恢复' },
      409,
    )
  }
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

/* ─── POST /api/admin/users/:id/anonymize ──────────────────────────────────
 *
 * "Soft delete" the user: cover the row's identity (name/email/password/avatar)
 * to ANONYMIZED_* sentinels and sweep all membership / interaction tables in
 * one transaction. Sessions are killed so any active login is terminated.
 *
 * What gets CLEARED on the user row:
 *   - name      → ANONYMIZED_NAME
 *   - email     → <id>@anonymized.invalid (UNIQUE-safe + RFC 2606 .invalid)
 *   - password  → rewritten to a fresh random hash (cannot sign in even if
 *                 status is later flipped to active by mistake)
 *   - avatar    → avatarKind=null, avatarRef=null (UserAvatar falls back to
 *                 initials+color placeholder)
 *   - color     → ANONYMIZED_COLOR gray
 *   - status    → 'anonymized' (M16:独立 4 态;以前写 'disabled' 跟 admin
 *                            禁用撞名,enable 端点曾能误把 anonymized
 *                            行翻成 active,造成 zombie 用户 —— 见
 *                            M16 plan;enable handler 已加 anonymized
 *                            守卫)
 *
 * What gets SWEPT (per-user references that lose meaning without the user):
 *   - sessions                       active sign-ins killed
 *   - user_group_members             drop membership in every group
 *   - user_recent_pages              drop "我最近浏览" history
 *   - user_watched_pages             drop all 👁 watches
 *   - page_likes                     drop all 👍 likes (other users' like
 *                                    counts on those pages decrement by 1
 *                                    via the same DELETE)
 *   - notifications WHERE recipient  drop pending @mentions / activity
 *                                    notifications for this user
 *   - space_role_grants WHERE kind='user' AND id=?
 *                                    drop direct user grants
 *   - page_restrictions WHERE kind='user' AND id=?
 *                                    drop direct user restrictions on pages
 *                                    (pages with view/edit restrictions are
 *                                    thus relaxed for this principal only)
 *
 * What is INTENTIONALLY PRESERVED (for attribution / audit):
 *   - pages.author_id / updated_by / deleted_by — page history stays intact;
 *     the anonymized display name renders via LEFT JOIN fallback
 *   - comments.author_id              — comment authorship stable
 *   - page_versions.created_by        — version history stable
 *   - attachments.uploaded_by         — attachment uploader stable
 *   - activity_events / page_events.actor_id
 *   - permission_audit.actor_id / granted_by
 *   - notifications.actor_id (the sender side; only recipient is swept)
 *   - The user row itself (so all the above FK-less references keep working)
 *
 * Self / last-admin guards mirror the disable handler so admins can't lock
 * themselves out. Anonymize is irreversible — no /enable equivalent exists
 * (the password hash is gone, email is a `.invalid` domain). The audit row
 * records the before/after name+email for compliance.
 */
adminUsersRouter.post('/:id/anonymize', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  // Refuse to anonymize yourself — irreversible + would lock you out.
  if (id === me.id) {
    return c.json(
      { error: 'self_anonymize', message: '不能注销自己的账号' },
      409,
    )
  }

  const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  // Refuse to anonymize the last active admin — same invariant as disable:
  // we always need a way in. (M16 起 anonymize 写 status='anonymized'
  // 而不是 'disabled',但语义不变 —— 这里只要求「还有别的 admin」,
  // 不区分其它 admin 的 status。)
  if (existing.role === 'admin') {
    const otherActiveAdmins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), ne(users.id, id)))
    if (otherActiveAdmins.length === 0) {
      return c.json(
        { error: 'last_admin', message: '不能注销最后一个管理员' },
        409,
      )
    }
  }

  // Idempotent: if already anonymized (name === ANONYMIZED_NAME), return
  // current state without rewriting. Lets UI retry safely.
  if (existing.name === ANONYMIZED_NAME) {
    return c.json(UserSchema.parse(rowToUser(existing)))
  }

  const now = Date.now()
  // Fresh password hash so even if status were flipped later the original
  // password wouldn't work. generateInitialPassword is also fine — we just
  // need *some* hash that won't match what was there.
  const newHash = await hashPassword(generateInitialPassword())
  const before = { name: existing.name, email: existing.email }

  await db.transaction(async (tx) => {
    // 1) Cover the user row. Updated_at is bumped so list ordering / cache
    //    invalidation pick up the change.
    await tx
      .update(users)
      .set({
        name: ANONYMIZED_NAME,
        email: anonymizedEmail(id),
        passwordHash: newHash,
        avatarKind: null,
        avatarRef: null,
        color: ANONYMIZED_COLOR,
        status: 'anonymized',
        updatedAt: now,
      })
      .where(eq(users.id, id))

    // 2) Kill sessions — existing tokens for this user must stop working.
    await tx.delete(sessions).where(eq(sessions.userId, id))

    // 3) Sweep per-user interaction / membership tables.
    await tx.delete(userGroupMembers).where(eq(userGroupMembers.userId, id))
    await tx.delete(userRecentPages).where(eq(userRecentPages.userId, id))
    await tx.delete(userWatchedPages).where(eq(userWatchedPages.userId, id))
    await tx.delete(pageLikes).where(eq(pageLikes.userId, id))
    // notifications.userId is the *recipient* (private inbox). Sweep so
    // the anonymized user has no pending @mentions / watch activity;
    // notifications.actorId (sender side) is preserved for attribution.
    await tx.delete(notifications).where(eq(notifications.userId, id))

    // 4) Sweep user-as-principal entries in the permissions model.
    //    Pages / comments / versions / audit / attachments keep the user
    //    id as a text reference but no longer grant any access.
    await tx
      .delete(spaceRoleGrants)
      .where(
        and(eq(spaceRoleGrants.principalKind, 'user'), eq(spaceRoleGrants.principalId, id)),
      )
    await tx
      .delete(pageRestrictions)
      .where(
        and(eq(pageRestrictions.principalKind, 'user'), eq(pageRestrictions.principalId, id)),
      )

    // 5) Audit row — irreversible event, before/after both useful for
    //    compliance. In same tx so business rollback ⇒ audit rollback.
    await recordPermissionAudit(tx, {
      kind: 'user_anonymized',
      actorId: me.id,
      targetKind: 'user',
      targetId: id,
      payload: {
        before,
        after: { name: ANONYMIZED_NAME, email: anonymizedEmail(id), status: 'anonymized' },
      },
    })
  })

  const updated = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!
  return c.json(UserSchema.parse(rowToUser(updated)))
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
