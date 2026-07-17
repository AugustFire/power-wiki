/**
 * Self-service user routes — Stage P1-6 + M13 + M2.
 *
 *   GET    /api/users/me                 current user
 *   PATCH  /api/users/me                 update current user's name / color
 *   GET    /api/users/me/watched         M13 personal watched pages list
 *   GET    /api/users/me/recent          M2 server-side recent visits list
 *   PUT    /api/users/me/recent/:pageId  M2 upsert visit (called from ReadView mount)
 *   DELETE /api/users/me/recent          M2 clear all recent (optional UI)
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
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import {
  DashboardPayloadSchema,
  NotificationSchema,
  PageNodeSchema,
  PageTitleSchema,
  PaginatedListSchema,
  UpdateUserInputSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import {
  notifications,
  pages,
  spaces,
  userAvatars,
  users,
  userRecentPages,
  userWatchedPages,
} from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { rowToUser } from '../lib/rowMappers'
import { rowToNotification } from '../lib/commentRowMappers'
import { rowToPageNode } from '../lib/rowToPageNode'
import { getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { selectPagesWithAuthor } from '../lib/selectPagesWithAuthor'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { presignUpload, headObject, deleteObject } from '../lib/s3'
import { generateAttachmentId } from '../lib/ids'
import {
  AvatarUploadUrlInputSchema,
  AvatarUploadUrlResponseSchema,
  AvatarFinalizeInputSchema,
  AvatarFinalizeResponseSchema,
} from '@power-wiki/shared/schemas'
import { AVATAR_UPLOAD_MAX_BYTES, AVATAR_TARGET_DIM } from '@power-wiki/shared'

/** 90 天之前的 visited_at 视为过期,read 路径 lazy 清理掉。 */
const RECENT_TTL_MS = 90 * 24 * 60 * 60 * 1000

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
// ─── PATCH /api/users/me ───────────────────────────────────────────────────
// Self-service profile update (name + color + avatar 三态)。Avatar 子对象
// 触发 cleanup:之前 kind='custom' 的话清掉当 ref 对应 user_avatars 行 +
// best-effort deleteObject(S3 失败不报错)。
usersRouter.patch('/me', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateUserInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }

  // Pre-pull 当前 avatar state 供 cleanup 判断
  const [prev] = await db
    .select({ kind: users.avatarKind, ref: users.avatarRef })
    .from(users)
    .where(eq(users.id, me.id))
    .limit(1)

  const patch: {
    name?: string
    color?: string
    avatarKind?: 'preset' | 'custom' | null
    avatarRef?: string | null
    updatedAt: number
  } = { updatedAt: Date.now() }

  // name
  if (parsed.data.name !== undefined) {
    const trimmed = parsed.data.name.trim()
    if (trimmed.length === 0) {
      return c.json({ error: 'invalid_input', message: '姓名不能为空' }, 400)
    }
    patch.name = trimmed
  }
  // color
  if (parsed.data.color !== undefined) patch.color = parsed.data.color

  // avatar —— cleanup 旧 custom 后写新
  if (parsed.data.avatar !== undefined) {
    if (prev?.kind === 'custom' && prev.ref) {
      const [gone] = await db
        .delete(userAvatars)
        .where(
          and(eq(userAvatars.id, prev.ref), eq(userAvatars.userId, me.id)),
        )
        .returning({ bucketKey: userAvatars.bucketKey })
      if (gone?.bucketKey) {
        deleteObject(gone.bucketKey).catch(() => {/* best-effort */})
      }
    }
    if (parsed.data.avatar.kind === null) {
      patch.avatarKind = null
      patch.avatarRef = null
    } else {
      // 'preset' 的 slug 已被 zod z.enum 卡死。'custom' 的 ref 必须真属于 me
      if (parsed.data.avatar.kind === 'custom') {
        const [avatar] = await db
          .select({ userId: userAvatars.userId })
          .from(userAvatars)
          .where(eq(userAvatars.id, parsed.data.avatar.ref))
          .limit(1)
        if (!avatar || avatar.userId !== me.id) {
          return c.json(
            { error: 'invalid_input', message: '头像引用不存在或无权访问' },
            400,
          )
        }
      }
      patch.avatarKind = parsed.data.avatar.kind
      patch.avatarRef = parsed.data.avatar.ref
    }
  }

  await db.update(users).set(patch).where(eq(users.id, me.id))
  const updated = (await db
    .select()
    .from(users)
    .where(eq(users.id, me.id))
    .limit(1))[0]
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json(UserSchema.parse(rowToUser(updated)))
})

// ─── POST /api/users/me/avatar/upload-url ────────────────────────────────
// 申请 presigned PUT URL。不写 DB,只返 S3 key + 签名 URL。
usersRouter.post('/me/avatar/upload-url', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = AvatarUploadUrlInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { mime, sizeBytes } = parsed.data
  if (sizeBytes > AVATAR_UPLOAD_MAX_BYTES) {
    return c.json({ error: 'too_large' }, 400)
  }
  const avatarId = generateAttachmentId()
  // mime → ext 映射(子集,跟 ALLOWED_MIME_TYPES 等价)
  const ext =
    mime === 'image/jpeg' ? '.jpg'
      : mime === 'image/png' ? '.png'
      : mime === 'image/webp' ? '.webp'
      : mime === 'image/gif' ? '.gif'
      : '.bin'
  const bucketKey = `users/${me.id}/${avatarId}${ext}`
  const { url, expiresAt } = await presignUpload(bucketKey, mime)
  return c.json(
    AvatarUploadUrlResponseSchema.parse({
      uploadUrl: url,
      bucketKey,
      avatarId,
      expiresAt,
    }),
    200,
  )
})

// ─── POST /api/users/me/avatar/finalize ──────────────────────────────────
// HeadObject 校验 S3 真实 size + mime 后 INSERT user_avatars 行。
// 然后 cleanup 该用户所有非新 ref 的 stale row + best-effort deleteObject
// (write-time lazy),长期收敛到每用户 ≤ 1 active row。
usersRouter.post('/me/avatar/finalize', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = AvatarFinalizeInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { avatarId, bucketKey, mime, sizeBytes, width, height } = parsed.data

  // 安全:必须以 users/{me.id}/ 开头,防 a 用户写 b 用户名下对象
  if (!bucketKey.startsWith(`users/${me.id}/`)) {
    return c.json({ error: 'forbidden' }, 403)
  }
  if (
    sizeBytes > AVATAR_UPLOAD_MAX_BYTES ||
    width > AVATAR_TARGET_DIM ||
    height > AVATAR_TARGET_DIM
  ) {
    return c.json({ error: 'too_large' }, 400)
  }

  let head: { size: number; contentType?: string }
  try {
    head = await headObject(bucketKey)
  } catch (err) {
    console.warn('[avatar finalize] headObject failed', bucketKey, err)
    return c.json({ error: 'upload_not_found' }, 409)
  }
  if (head.size !== sizeBytes) {
    return c.json(
      { error: 'size_mismatch', expected: sizeBytes, actual: head.size },
      409,
    )
  }
  if (head.contentType && head.contentType !== mime) {
    return c.json(
      { error: 'mime_mismatch', expected: mime, actual: head.contentType },
      409,
    )
  }

  const now = Date.now()
  await db.insert(userAvatars).values({
    id: avatarId,
    userId: me.id,
    bucketKey,
    mime,
    sizeBytes: head.size,
    width,
    height,
    createdAt: now,
  })

  // Cleanup 该用户所有非新 ref 的 stale row + best-effort deleteObject
  const stale = await db
    .delete(userAvatars)
    .where(and(eq(userAvatars.userId, me.id), ne(userAvatars.id, avatarId)))
    .returning({ bucketKey: userAvatars.bucketKey })
  for (const row of stale) {
    deleteObject(row.bucketKey).catch(() => {/* best-effort */})
  }

  return c.json(
    AvatarFinalizeResponseSchema.parse({
      avatarId,
      bucketKey,
      createdAt: now,
    }),
    201,
  )
})

// ─── DELETE /api/users/me/avatar/custom ──────────────────────────────────
// 用户主动清掉当前 custom avatar(头像立刻回退 initials+color 或 preset)。
// 当前 ref 已 NULL 时 200 no-op。
usersRouter.delete('/me/avatar/custom', async (c) => {
  const me = c.get('user')
  const [u] = await db
    .select({ kind: users.avatarKind, ref: users.avatarRef })
    .from(users)
    .where(eq(users.id, me.id))
    .limit(1)
  if (u?.kind === 'custom' && u.ref) {
    const [gone] = await db
      .delete(userAvatars)
      .where(
        and(eq(userAvatars.id, u.ref), eq(userAvatars.userId, me.id)),
      )
      .returning({ bucketKey: userAvatars.bucketKey })
    if (gone?.bucketKey) {
      deleteObject(gone.bucketKey).catch(() => {/* best-effort */})
    }
    await db
      .update(users)
      .set({ avatarKind: null, avatarRef: null, updatedAt: Date.now() })
      .where(eq(users.id, me.id))
  }
  return c.body(null, 204)
})

// 注意:GET /api/user-avatars/:userId/raw(raw 端点,公开)不在本 router。
// 挂在独立的 publicAvatarsRouter 前缀 /api/user-avatars,在 index.ts
// requireAuth gate 之前 mount。理由:头像跟 username 一样对外公开,
// 不应该走 requireAuth 中间件;挂在 /api/users/* 又会被全局 gate 兜走。

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

// ─── GET /api/users/me/recent ─────────────────────────────────────────────
// M2: 服务端「最近浏览」列表 —— 替代 v0 的 localStorage 方案,跨设备同步。
//
// Query:
//   ?limit=&offset=  1-200 标准分页;无 limit = 走"全量"分支(单用户
//                   recent 不可能无限大,默认 cap 50 行硬限)
//
// 权限与可见性:
//   - admin: 看见自己访问过的所有 recent(全空间)
//   - 非 admin: 自动过滤到当前 canAccess 的空间集合 —— 跟 /me/watched
//     同构,用户事后被移出空间时 recent 行不被清(list 响应里不暴露
//     inaccessible 空间的 row)
//
// TTL 清理:90 天前的 visited_at 视为过期,read 路径 lazy DELETE。
// 无 cron —— 跟 page_events 不一样,recent 不需要永久保留。
//
// 数据形状:返回 PageNode 列表(LEFT JOIN users + spaces 拿 author 名字
// / 空间元数据),而不是裸 recent 行。Dashboard 「最近浏览」section 直接
// 复用 PageNode 渲染,无需另写一个 row 类型。
usersRouter.get('/me/recent', async (c) => {
  const me = c.get('user')
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args
  // 无 limit → cap 50,避免「全量」分支偶然拉出几万行历史
  const effectiveLimit = limit ?? 50

  // Lazy TTL cleanup:每次进来顺手清 90 天前的行。极轻(单 user),
  // 不需要 cron —— 跟 user_watched_pages / page_events 不一样,recent
  // 是「近期」概念,陈旧数据无业务价值。
  await db
    .delete(userRecentPages)
    .where(
      and(
        eq(userRecentPages.userId, me.id),
        sql`${userRecentPages.visitedAt} < ${Date.now() - RECENT_TTL_MS}`,
      ),
    )

  // Step 1: 全量拉 me 的 recent(visited_at DESC)。单用户 recent 上限
  // 由 TTL=90d + 每页最多 1 行天然收敛,几百行封顶,全量 fetch 安全。
  // 这里不预先 limit —— visibility 过滤后会丢行,预 limit 会导致
  // "用户其实有 N 个可见 recent 但只看到 K 个" 的 hasMore 误报。
  const recentRows = await db
    .select({
      pageId: userRecentPages.pageId,
      visitedAt: userRecentPages.visitedAt,
    })
    .from(userRecentPages)
    .where(eq(userRecentPages.userId, me.id))
    .orderBy(sql`${userRecentPages.visitedAt} DESC`)

  if (recentRows.length === 0) {
    return c.json(
      PaginatedListSchema(PageNodeSchema).parse({
        items: [],
        limit: effectiveLimit,
        offset,
        hasMore: false,
      }),
    )
  }
  // 保留原始 visited_at 顺序,后面 JS reorder 用
  const orderedIds = recentRows.map((r) => r.pageId)

  // Step 2: visibility + deletedAt 过滤(同 /me/watched)。
  // selectPagesWithAuthor 拿 LEFT JOIN 字段;不在 SELECT 里 ORDER BY —
  // 我们用 order map 在 JS 端按 visited_at 顺序排,避开 raw SQL 拼接
  // (array_position + 手写 escape 的注入风险)。
  const filters: SQL[] = [inArray(pages.id, orderedIds), isNull(pages.deletedAt)]
  if (me.role !== 'admin') {
    const visible = await getAccessibleSpaceIds(me.id, false)
    if (visible === '*' || visible.length === 0) {
      return c.json(
        PaginatedListSchema(PageNodeSchema).parse({
          items: [],
          limit: effectiveLimit,
          offset,
          hasMore: false,
        }),
      )
    }
    filters.push(inArray(pages.spaceId, visible))
  }

  const combined = filters.length === 1 ? filters[0] : and(...filters)!
  const rows = await selectPagesWithAuthor(combined, { viewerUserId: me.id })

  // Step 3: 按 visited_at DESC 重排,visibility 过滤后的 id 顺序保留
  // 原 visited_at 优先级。这是 JS 端 map lookup,O(N) 无 DB roundtrip。
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const visibleInOrder = orderedIds.filter((id) => rowById.has(id))

  // 在已 filter 的序列上做分页,limit+1 探测 hasMore。
  const pageSlice = visibleInOrder.slice(offset, offset + effectiveLimit + 1)
  const hasMore = pageSlice.length > effectiveLimit
  const items = pageSlice.slice(0, effectiveLimit).map((id) =>
    PageNodeSchema.parse(rowToPageNode(rowById.get(id)!)),
  )
  return c.json(
    PaginatedListSchema(PageNodeSchema).parse({
      items,
      limit: effectiveLimit,
      offset,
      hasMore,
    }),
  )
})

// ─── PUT /api/users/me/recent/:pageId ─────────────────────────────────────
// M2: 上报一次访问(ReadView mount 时调)。
//
// 幂等 UPSERT(PK 复合 page_id + user_id),visited_at = now,title 冗余。
// page 不存在 / 已软删 → 404,不写 recent(避免孤儿 page_id)。可访问性
// 检查同 PATCH /:id(personal-space 闸门 admin 也走标准流程)。
//
// 失败容忍:ReadView 的 mount 流程 fire-and-forget,前端不阻塞等响应;
// server 端这里仍 throw 500 让 frontend toast,前端可以选择 retry。
usersRouter.put('/me/recent/:pageId', async (c) => {
  const me = c.get('user')
  const pageId = c.req.param('pageId')
  const body = await c.req.json().catch(() => ({}))
  // title 是可选 —— 客户端传 title 时 server 冗余存,客户端不传就拿当前
  // page.title(避免 fallback 时还得发两次请求)
  const rawTitle =
    typeof (body as { title?: unknown }).title === 'string'
      ? ((body as { title: string }).title).trim()
      : ''
  const now = Date.now()

  // 拿 page 元数据(校验存在 + 拿 title 兜底)
  const [page] = await db
    .select({ spaceId: pages.spaceId, deletedAt: pages.deletedAt, title: pages.title })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!page || page.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (page.deletedAt !== null) {
    return c.json({ error: 'not_found' }, 404)
  }

  const title = rawTitle || page.title || ''
  // 截断 title 到 PageTitleSchema 长度,避免超长输入污染 recent 表
  const safeTitle = PageTitleSchema.safeParse(title).success
    ? title
    : title.slice(0, 200)

  await db
    .insert(userRecentPages)
    .values({
      pageId,
      userId: me.id,
      visitedAt: now,
      title: safeTitle,
    })
    .onConflictDoUpdate({
      target: [userRecentPages.pageId, userRecentPages.userId],
      set: {
        visitedAt: now,
        title: safeTitle,
      },
    })

  return c.body(null, 204)
})

// ─── DELETE /api/users/me/recent ──────────────────────────────────────────
// M2: 清空当前用户的全部 recent history。UI 不暴露入口,留给未来「清空
// 浏览历史」按钮;目前前端不调,保留端点完整性。
usersRouter.delete('/me/recent', async (c) => {
  const me = c.get('user')
  await db.delete(userRecentPages).where(eq(userRecentPages.userId, me.id))
  return c.body(null, 204)
})

/* ─────────────────────────────────────────────────────────────────
 *  GET /api/users/me/dashboard — M2「Your Work」综合端点。
 *
 *  4 个 section 并行查询,一次 RTT 喂给前端 Dashboard:
 *    1. mentions:未读 @ 提我通知(kind=mention, isRead=false, top N)
 *    2. personalSpace:我的个人空间最近编辑(pages WHERE author=me
 *       AND space.kind='personal', top N) —— 个人空间作「私人记事本 /
 *       草稿本」使用,跨空间移页前在这里起草
 *    3. created:我创建的页面(pages WHERE author_id=me, top N)
 *    4. watched:我关注的页面(user_watched_pages JOIN pages, top N)
 *    5. recent:最近浏览(user_recent_pages JOIN pages, top N)
 *
 *  权限 / 可见性:
 *    - admin:看全部
 *    - 非 admin:personalSpace / created / watched / recent 四个 section
 *      都要附加 spaceId ∈ accessibleSpaceIds 过滤(防泄漏);mentions
 *      是通知中心,无 space 维度,直接给。
 *
 *  ?limit:每 section 上限,默认 5,范围 1-20。前端 5 默认,「查看全部」链
 *  接走完整分页路径,不调这个端点。
 *
 *  trashed pages:在 selectPagesWithAuthor 默认 isNull(deleted_at),除了
 *  mentions(通知本身是历史快照,page 可能后来被 trash —— LEFT JOIN users
 *  + 标题兜底「已删除页面」,跟 ActivityEvent 同构)。
 *
 *  并行执行:5 个 Promise.all 一次跑完 —— Postgres 连接池允许的并发
 *  完全够用,典型 latency ~30-50ms(比 5 个串行 ~150ms 快 3-4 倍)。
 * ───────────────────────────────────────────────────────────────── */
usersRouter.get('/me/dashboard', async (c) => {
  const me = c.get('user')
  const rawLimit = Number(c.req.query('limit') ?? '5')
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(20, Math.floor(rawLimit)))
    : 5

  // 1) 非 admin 拿可见空间集合(短路 admin,免去 SQL)
  let visibleSpaceIds: string[] | '*'
  if (me.role === 'admin') {
    visibleSpaceIds = '*'
  } else {
    const ids = await getAccessibleSpaceIds(me.id, false)
    visibleSpaceIds = ids === '*' ? [] : ids
  }

  // ─── 子查询 1:未读 @ 提我通知 ────────────────────────────────────
  // SELECT notifications + LEFT JOIN users 拿 actor 头像字段
  const mentionsPromise = (async () => {
    const rows = await db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        actorId: notifications.actorId,
        kind: notifications.kind,
        pageId: notifications.pageId,
        pageTitle: notifications.pageTitle,
        commentId: notifications.commentId,
        mentionUserId: notifications.mentionUserId,
        isRead: notifications.isRead,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        actorName: users.name,
        actorColor: users.color,
        actorAvatarKind: users.avatarKind,
        actorAvatarRef: users.avatarRef,
      })
      .from(notifications)
      .leftJoin(users, eq(notifications.actorId, users.id))
      .where(
        and(
          eq(notifications.userId, me.id),
          eq(notifications.kind, 'mention'),
          eq(notifications.isRead, false),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
    return rows.map((r) =>
      NotificationSchema.parse(
        rowToNotification(r, {
          actorName: r.actorName,
          actorColor: r.actorColor,
          actorAvatarKind: r.actorAvatarKind,
          actorAvatarRef: r.actorAvatarRef,
        }),
      ),
    )
  })()

  // ─── 子查询 2:我的个人空间最近编辑 ────────────────────────────
  // Confluence model:个人空间 = 「私人记事本 / 草稿本」。这个 section 展示
  // 当前用户在所有个人空间里的页面(updated_at DESC, top N)—— 跨空间移页
  // 前在这里起草。多用户共享 personal 空间不存在(只能 owner 自己访问 +
  // admin 监督,见 docs/data-model.md §个人空间),所以这里 author=me
  // 隐含 owner=me。
  //
  // Step 1: 拿个人空间 ids。
  // Step 2: pages WHERE author=me AND spaceId IN (...) 取 top N page ids。
  // Step 3: selectPagesWithAuthor 拿完整 page 元数据。
  const personalSpacePromise = (async () => {
    const personalSpaceRows = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerId, me.id)))
    const personalIds = personalSpaceRows.map((r) => r.id)
    if (personalIds.length === 0) return []

    const idRows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(
          eq(pages.authorId, me.id),
          isNull(pages.deletedAt),
          inArray(pages.spaceId, personalIds),
        ),
      )
      .orderBy(desc(pages.updatedAt))
      .limit(limit)
    return pagesByIdsOrdered(idRows.map((r) => r.id), limit)
  })()

  // ─── 通用子查询 helper:按 ids 拉 page 列表(配合可见性过滤) ──────
  // watched / recent 都先拿 ids 子集,再走 selectPagesWithAuthor。
  // watched 跟 recent 需要重排(JOIN 不保证原顺序)。
  async function pagesByIdsOrdered(
    idsInOrder: string[],
    fallbackLimit: number,
  ): Promise<ReturnType<typeof rowToPageNode>[]> {
    if (idsInOrder.length === 0) return []
    const filters: SQL[] = [inArray(pages.id, idsInOrder), isNull(pages.deletedAt)]
    if (visibleSpaceIds !== '*') {
      if (visibleSpaceIds.length === 0) return []
      filters.push(inArray(pages.spaceId, visibleSpaceIds))
    }
    const where = filters.length === 1 ? filters[0] : and(...filters)!
    const rows = await selectPagesWithAuthor(where, { viewerUserId: me.id })
    const byId = new Map(rows.map((r) => [r.id, r]))
    return idsInOrder.flatMap((id) => {
      const row = byId.get(id)
      return row ? [rowToPageNode(row)] : []
    }).slice(0, fallbackLimit)
  }

  // ─── 子查询 3:我创建的页面 ──────────────────────────────────────
  // SELECT pages WHERE author_id = me, ORDER BY updated_at DESC, LIMIT N
  // 不走 selectPagesWithAuthor —— 这一节直接拿 ids,再走 pagesByIdsOrdered
  // 拼接 page 实体(LEFT JOIN users / labels / likes 全在 selectPagesWithAuthor 里)
  const createdPromise = (async () => {
    const idRows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.authorId, me.id), isNull(pages.deletedAt)))
      .orderBy(desc(pages.updatedAt))
      .limit(limit)
    return pagesByIdsOrdered(idRows.map((r) => r.id), limit)
  })()

  // ─── 子查询 4:我关注的页面 ──────────────────────────────────────
  // SELECT user_watched_pages JOIN pages 拿 (id, watched_at) DESC top N
  const watchedPromise = (async () => {
    const idRows = await db
      .select({ pageId: userWatchedPages.pageId })
      .from(userWatchedPages)
      .where(eq(userWatchedPages.userId, me.id))
      .orderBy(desc(userWatchedPages.watchedAt))
      .limit(limit)
    return pagesByIdsOrdered(idRows.map((r) => r.pageId), limit)
  })()

  // ─── 子查询 5:最近浏览 ──────────────────────────────────────────
  const recentPromise = (async () => {
    const idRows = await db
      .select({ pageId: userRecentPages.pageId })
      .from(userRecentPages)
      .where(eq(userRecentPages.userId, me.id))
      .orderBy(desc(userRecentPages.visitedAt))
      .limit(limit)
    return pagesByIdsOrdered(idRows.map((r) => r.pageId), limit)
  })()

  const [mentions, personalSpace, created, watched, recent] = await Promise.all([
    mentionsPromise,
    personalSpacePromise,
    createdPromise,
    watchedPromise,
    recentPromise,
  ])

  // zod parse at the boundary —— 同时把 PageNode(interface,labels?:string[])
  // 收成 PageNodeSchema 派生类型(labels:string[],default []),跟 schemas 的
  // 类型对齐。`created` 等字段是 `rowToPageNode(...)` 直接构造的 PageNode,
  // runtime 已有 default [],但 TS 类型上 labels 是 optional —— 走 parse
  // 一次拿严格类型,避免下游 z.array(PageNodeSchema) 抱怨。
  return c.json(
    DashboardPayloadSchema.parse({
      mentions,
      personalSpace,
      created,
      watched,
      recent,
    }),
  )
})
