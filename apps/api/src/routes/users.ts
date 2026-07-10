/**
 * Self-service user routes — Stage P1-6 + M13.
 *
 *   GET   /api/users/me          current user
 *   PATCH /api/users/me          update current user's name / color
 *   GET   /api/users/me/watched  M13 personal watched pages list
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
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import {
  PageNodeSchema,
  PaginatedListSchema,
  UpdateUserInputSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { pages, users, userWatchedPages } from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { rowToUser } from '../lib/rowMappers'
import { rowToPageNode } from '../lib/rowToPageNode'
import { getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { selectPagesWithAuthor } from '../lib/selectPagesWithAuthor'
import { applyPagination, safeParsePagination } from '../lib/paginate'

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

// ─── GET /api/users/me/watched ────────────────────────────────────────────
// M13: 当前用户关注的页面列表 —— recipient-private,只返 me 的 watch 行。
//
// Query:
//   ?space=<id>     可选过滤,Sidebar「我的关注」section 走这个(scope 当前空间)
//                   不传 = 全部被关注的页面(/me Dashboard Watching tab 用)
//   ?limit=&offset=  1-200 标准分页;无 limit = 全量(Sidebar 用全量分支)
//
// 权限:
//   - admin:看见所有 watched 页面(跨空间)
//   - 非 admin:自动过滤到当前 canAccess 的空间集合 —— 用户事后被移出空间
//     时,DB 里 watch 行不会被清(恢复访问后能再次看到),但 list 响应里
//     不暴露 inaccessible 空间的 row,避免存在性泄漏。
//
// 按 watched_at DESC 走 user_watched_user_idx(走 correlated subquery 拼
// ORDER BY,避免 LEFT JOIN 破坏 selectPagesWithAuthor 的 GROUP BY pages.id)。
// trashed (deletedAt IS NOT NULL) 自动排除 —— soft-delete 期间对用户「隐身」,
// restore 后回来(同 page_likes list 行为)。
usersRouter.get('/me/watched', async (c) => {
  const me = c.get('user')
  const querySpace = c.req.query('space')?.trim() || null
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args

  // Step 1: 拿 me 当前所有 watched 的 page_id —— 走 user_watched_user_idx。
  // trashed 不在 step 1 过滤,而是喂给 selectPagesWithAuthor 的 page-level
  // deleted_at 守卫统一处理。Step 1 只负责「我关注了哪些 page id」。
  const watchedIds = await db
    .select({ pageId: userWatchedPages.pageId })
    .from(userWatchedPages)
    .where(eq(userWatchedPages.userId, me.id))

  if (watchedIds.length === 0) {
    return c.json(PaginatedListSchema(PageNodeSchema).parse({
      items: [],
      limit: 0,
      offset: 0,
      hasMore: false,
    }))
  }
  const ids = watchedIds.map((w) => w.pageId)

  // Step 2: 拼上 space 可见性 + ?space=<id> 过滤。
  const filters: SQL[] = [inArray(pages.id, ids), isNull(pages.deletedAt)]
  if (me.role !== 'admin') {
    const visible = await getAccessibleSpaceIds(me.id, false)
    if (visible === '*' || visible.length === 0) {
      return c.json(PaginatedListSchema(PageNodeSchema).parse({
        items: [],
        limit: 0,
        offset: 0,
        hasMore: false,
      }))
    }
    filters.push(
      querySpace
        ? and(eq(pages.spaceId, querySpace), inArray(pages.spaceId, visible))!
        : inArray(pages.spaceId, visible),
    )
  } else if (querySpace) {
    filters.push(eq(pages.spaceId, querySpace))
  }

  // Step 3: selectPagesWithAuthor 拿 LEFT JOIN 字段;按 watched_at DESC 排序。
  // watched_at 不在 PageNode 上 —— 用 correlated subquery 取排序键,避免
  // LEFT JOIN user_watched_pages 破坏 GROUP BY pages.id。
  const combined = filters.length === 1 ? filters[0] : and(...filters)!
  let q = selectPagesWithAuthor(combined, { viewerUserId: me.id }).$dynamic()
  q = q.orderBy(sql`(
    SELECT watched_at FROM user_watched_pages
    WHERE page_id = ${pages.id} AND user_id = ${me.id}
  ) DESC NULLS LAST`)
  if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
  const rows = await q
  const result = applyPagination(
    rows.map((r) => PageNodeSchema.parse(rowToPageNode(r))),
    limit,
    offset,
  )
  return c.json(PaginatedListSchema(PageNodeSchema).parse(result))
})
