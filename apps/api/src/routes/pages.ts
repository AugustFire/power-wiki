/**
 * Pages API — 12 routes (Stage 5 — soft-delete / trash / restore; Stage 8 —
 * history / labels / duplicate; v2 — auto-save 静默 / snapshot 边界触发):
 *
 *   GET    /api/pages                  → PageNode[] (filtered by visible spaces, excludes trashed)
 *   GET    /api/pages/trash?space=     → PageNode[] (admin only, trashed pages in space)
 *   GET    /api/pages/:id              → PageNode (404 if not in visible space, excludes trashed)
 *   POST   /api/pages                  → 201 + PageNode (spaceId required + access check)
 *   PATCH  /api/pages/:id              → PageNode (404 if not in visible space, excludes trashed)
 *                                         内容更新 — **不**写 page_versions(version 由
 *                                         前端在 idle boundary / route leave 时主动打
 *                                         POST /:id/snapshots 触发)
 *   POST   /api/pages/:id/snapshots    → 201 + PageVersion (边界 / idle checkpoint,manual)
 *   POST   /api/pages/:id/like         → 200 + { liked, likesCount } (toggle 单端点)
 *   PATCH  /api/pages/:id/move         → PageNode (404 if not in visible space, excludes trashed)
 *   POST   /api/pages/:id/publish      → 201 + PageNode (personal → team space copy)
 *   POST   /api/pages/:id/duplicate    → 201 + PageNode (in-place sibling copy, title "复制自+原标题")
 *   POST   /api/pages/:id/restore      → 204 (admin only, 409 parent_trashed / not_trashed)
 *   DELETE /api/pages/:id              → 204 soft-delete (409 has_children, 404 not accessible)
 *   DELETE /api/pages/:id?purge=true   → 204 hard-delete (admin only, must already be trashed)
 *
 * Space scoping (Stage 4c):
 *   - Admin sees all spaces and all pages.
 *   - Regular user sees pages in spaces they have access to (via group
 *     membership × space_group_access).
 *   - All single-page operations (GET /:id, PATCH, MOVE, DELETE) return 404
 *     for pages in inaccessible spaces — NOT 403. This prevents the API
 *     from leaking which page IDs exist in which spaces.
 *
 * Soft-delete semantics (Stage 5):
 *   - All read paths go through `selectPagesWithAuthor(...)` which adds
 *     `isNull(deletedAt)` by default. Only `/api/pages/trash` opts in via
 *     `includeDeleted: true`.
 *   - `DELETE /:id` flips `deleted_at` on the row itself (no recursion — the
 *     router refuses with 409 `has_children` if non-trashed children exist).
 *   - `POST /:id/restore` clears `deleted_at` on one row; refuses 409 if the
 *     row's `parent_id` points at a still-trashed page (parent must be
 *     restored first).
 *   - `DELETE /:id?purge=true` runs the original recursive hard-delete CTE
 *     for admin cleanup of the trash.
 *
 * Validation: hand-rolled zod safeParse per handler. Hono's zValidator would
 * save boilerplate but adds a dep for ~3 lines saved per route.
 *
 * Errors: 400 zod, 403 admin-only, 404 not found / not accessible, 409
 *         has_children / parent_trashed / not_trashed, 500 internal.
 */

import { Hono } from 'hono'
import { and, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm'
import {
  ActivityEventSchema,
  CreatePageInputSchema,
  DuplicatePageInputSchema,
  PageNodeSchema,
  PageVersionSchema,
  PaginatedListSchema,
  SnapPageInputSchema,
  ToggleLikeResponseSchema,
  UpdatePageInputSchema,
  MovePageInputSchema,
  PublishPageInputSchema,
} from '@power-wiki/shared/schemas'
import { DEFAULT_TITLE } from '@power-wiki/shared'
import type { PageVersion } from '@power-wiki/shared'
import { RETENTION } from './pageVersions'
import { db } from '../db/client'
import {
  pages,
  spaces,
  users,
  comments as commentsTable,
  notifications as notificationsTable,
  pageVersions,
  pageLabels,
  attachments,
  pageLikes,
  pageEvents,
} from '../db/schema'
import { rowToPageNode } from '../lib/rowToPageNode'
import { generatePageId, getPageSubtree, isDescendantOrSelf } from '../lib/ids'
import { canAccessSpace, getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { assertAdminNotWritingPersonalSpace } from '../lib/personalSpaceGuard'
import { deleteObject } from '../lib/s3'
import { enqueueNotifications } from '../lib/notify'
import { recordPageEvent, SUPPORTED_KINDS, type PageEventKind } from '../lib/pageEvents'
import { purgeExpiredTrash } from '../lib/retention'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { type Variables } from '../auth/middleware'

const PAGE_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // matches apps/web/src/lib/id.ts (10 chars)

export const pagesRouter = new Hono<{ Variables: Variables }>()

/**
 * `pages` + LEFT JOIN `users` for the author's name/color + LEFT JOIN
 * `page_labels` aggregated to a distinct label array. Used by every handler
 * that returns a page to the client so ReadView can render the creator
 * without a separate user lookup and the label pills without a second fetch.
 *
 * By default this ALSO filters out trashed rows (`deleted_at IS NULL`) so
 * every existing read path is automatically safe. Pass `includeDeleted: true`
 * to opt out — only the trash listing does this.
 *
 * Pass an optional WHERE clause; undefined = no extra filter beyond the
 * default deletedAt guard.
 *
 * The `labels` aggregation: COALESCE(json_agg(DISTINCT label) FILTER (...))
 * returns '[]' when the page has no labels, otherwise the distinct label
 * strings. The FILTER clause is needed because LEFT JOIN produces NULLs in
 * the join column for rows with no labels — those would otherwise land in
 * the agg as a NULL element. Drizzle's `.mapWith(...)` keeps the result
 * typed as `string[]` (parse the JSON if non-null, [] otherwise).
 *
 * 点赞:`likesCount` 是 COUNT(*) 走 page_likes 主键 (page_id, user_id),
 * `likedByMe` 是 EXISTS 配合 viewerUserId 算的布尔。Pass null when the
 * call site has no user context (none today — even GET /:id has `me`).
 */
function selectPagesWithAuthor(
  where?: SQL,
  opts: { includeDeleted?: boolean; viewerUserId?: string | null } = {},
) {
  const labelsAgg = sql<string[]>`
    COALESCE(
      json_agg(DISTINCT ${pageLabels.label})
        FILTER (WHERE ${pageLabels.label} IS NOT NULL),
      '[]'::json
    )
  `.as('labels')
  // EXISTS 子查询:对每行计算"是否有未删除的子页面"。Sidebar 用它判断 caret
  // 显示 —— 懒加载模式下 children 数组在用户展开前为空,不能拿那个判断 leaf。
  // 走 `pages_parent_idx`,百页级 sub-ms 成本。带 deleted_at IS NULL 过滤避免
  // 回收站里的子页面误把父节点标记为 hasChildren。
  const hasChildrenExpr = sql<boolean>`
    EXISTS (
      SELECT 1 FROM pages c
      WHERE c.parent_id = ${pages.id}
        AND c.deleted_at IS NULL
    )
  `.as('has_children')
  // 点赞总数 — 走 page_likes 主键前缀,COUNT(*) GROUP BY page_id。
  // 用 correlated subquery 而不是 LEFT JOIN + COUNT 避免破坏现有的
  // GROUP BY(pages.id, users.name, users.color):多 LEFT JOIN 会让行数
  // 翻倍,得再 DISTINCT,不如直接 correl。
  const likesCountExpr = sql<number>`
    (SELECT COUNT(*)::int
     FROM page_likes pl
     WHERE pl.page_id = ${pages.id})
  `.as('likes_count')
  // 当前用户是否已赞 — 取 viewerUserId,无用户(匿名 / 内部调用)时给 false。
  // 用 COALESCE 包一层:viewerUserId 为 null 时 EXISTS(... AND user_id = NULL)
  // 永远 false,EXISTS 直接返 false,COALESCE(false) 还是 false。
  const likedByMeExpr = opts.viewerUserId != null
    ? sql<boolean>`
        COALESCE(
          EXISTS (
            SELECT 1 FROM page_likes plm
            WHERE plm.page_id = ${pages.id}
              AND plm.user_id = ${opts.viewerUserId}
          ),
          false
        )
      `.as('liked_by_me')
    : sql<boolean>`false`.as('liked_by_me')
  // 点赞者 sample(前 5 人,按 created_at 升序)—— 给 byline 行头像组用。
  // Subquery + LIMIT 是 PostgreSQL 在 json_agg 里取前 N 的标准做法(LIMIT
  // 不能直接放 json_agg 内层,但子查询包一层即可)。`likedBySample` 比
  // `likesCount` 多取一份 JOIN,只有 COUNT > 0 才值得渲染头像组;
  // 前端 v-if 会用 likesCount 守门,这里无脑算即可(N 表,N+1 一致)。
  // JSON shape: [{ id, name, color }, ...],name/color 在 user 已 disabled
  // 或从未建档(authorId='me' 那种 page 不是 liked)时为 null — LEFT JOIN 保留。
  const likedBySampleExpr = sql<Array<{ id: string; name: string | null; color: string | null }>>`
    COALESCE(
      (
        SELECT json_agg(
          json_build_object('id', u.id, 'name', u.name, 'color', u.color)
        )
        FROM (
          SELECT pl.user_id
          FROM page_likes pl
          WHERE pl.page_id = ${pages.id}
          ORDER BY pl.created_at ASC
          LIMIT 5
        ) sub
        LEFT JOIN users u ON u.id = sub.user_id
      ),
      '[]'::json
    )
  `.as('liked_by_sample')
  const q = db
    .select({
      ...getTableColumns(pages),
      authorName: users.name,
      authorColor: users.color,
      labels: labelsAgg,
      hasChildren: hasChildrenExpr,
      likesCount: likesCountExpr,
      likedByMe: likedByMeExpr,
      likedBySample: likedBySampleExpr,
    })
    .from(pages)
    .leftJoin(users, eq(pages.authorId, users.id))
    .leftJoin(pageLabels, eq(pageLabels.pageId, pages.id))
    .groupBy(pages.id, users.name, users.color)
  const filters: SQL[] = []
  if (!opts.includeDeleted) filters.push(isNull(pages.deletedAt))
  if (where) filters.push(where)
  return filters.length ? q.where(and(...filters)) : q
}

/* ─── GET /api/pages ─────────────────────────────────────────────────────
 *  Optional ?space=<id> scopes the list to a single space. The space must be
 *  visible to the current user, otherwise we 404 (not 403) to avoid leaking
 *  the existence of spaces the user shouldn't see.
 *
 *  Optional ?parentId=<id|null> filters by parent. Three states:
 *    - absent / empty       → no parent filter (back-compat for existing callers)
 *    - "null" (literal)     → only roots (parent_id IS NULL). Sidebar uses this
 *                            on first load to fetch every root of the active space.
 *    - "<id>"               → only direct children of that page. PageTree uses
 *                            this on caret expand to lazy-load a parent's kids.
 *
 *  Pagination: `?limit=` (1-200) + `?offset=`. 不传 limit = 全量(保持
 *  stores/Sidebar 的向后兼容 — page 树需要看到所有页才能渲染)。
 */
pagesRouter.get('/', async (c) => {
  const me = c.get('user')
  const querySpace = c.req.query('space')
  const parentRaw = c.req.query('parentId')
  // undefined = no filter, null literal = roots only, otherwise eq by id.
  const parentFilter: SQL | undefined =
    parentRaw === undefined || parentRaw === ''
      ? undefined
      : parentRaw === 'null'
        ? isNull(pages.parentId)
        : eq(pages.parentId, parentRaw)
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args

  // Compose the WHERE: parent filter + space/access filter. We always pass a
  // single combined `where` SQL to selectPagesWithAuthor so admin vs non-admin
  // share the same parentId semantics (parent filter doesn't care about role).
  function buildSpaceFilter(space: SQL | undefined): SQL | undefined {
    return parentFilter && space
      ? and(parentFilter, space)
      : (parentFilter ?? space)
  }

  // Build the WHERE clause. For admin, skip the filter entirely.
  if (me.role !== 'admin') {
    const visible = await getAccessibleSpaceIds(me.id, false)
    if (visible === '*' || visible.length === 0) {
      // Shouldn't happen for non-admin, but be defensive.
      return c.json({ items: [], limit: 0, offset: 0, hasMore: false })
    }

    if (querySpace) {
      // Single-space query — must be in the visible set.
      if (!visible.includes(querySpace)) {
        return c.json({ error: 'not_found' }, 404)
      }
      const where = buildSpaceFilter(eq(pages.spaceId, querySpace))
      let q = selectPagesWithAuthor(where, { viewerUserId: me.id }).$dynamic()
      if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
      const rows = await q
      const result = applyPagination(rows.map(rowToPageNode), limit, offset)
      return c.json(PaginatedListSchema(PageNodeSchema).parse(result))
    }

    const where = buildSpaceFilter(inArray(pages.spaceId, visible))
    let q = selectPagesWithAuthor(where, { viewerUserId: me.id }).$dynamic()
    if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
    const rows = await q
    const result = applyPagination(rows.map(rowToPageNode), limit, offset)
    return c.json(PaginatedListSchema(PageNodeSchema).parse(result))
  }

  // Admin path.
  const where = buildSpaceFilter(querySpace ? eq(pages.spaceId, querySpace) : undefined)
  let q = selectPagesWithAuthor(where, { viewerUserId: me.id }).$dynamic()
  if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
  const rows = await q
  const result = applyPagination(rows.map(rowToPageNode), limit, offset)
  return c.json(PaginatedListSchema(PageNodeSchema).parse(result))
})

/* ─── GET /api/pages/activity ───────────────────────────────────────────
 *  P1-3 v2 workspace-wide 活动流。`?space=<id>` 可选过滤;不传 = 当前用户
 *  可见的所有空间(admin 看全部,普通用户走 canAccessSpace)。按 created_at DESC
 *  返回最多 50 行 ActivityEvent,每行带 `kind`(created/edited/moved/restored/
 *  duplicated/published)+ actor + page + space 信息。
 *
 *  数据来源是 `page_events` 表 —— 写路径(POST /pages, PATCH, /move,
 *  /restore, /duplicate, /publish)显式插行,UI 按 kind 渲染不同动词。v1
 *  时代用 `pages.updated_at` 派生,语义错位,已废弃。
 *
 *  事件行无 FK(actor/page 删后保留作审计);我们 LEFT JOIN pages 拿最新标题
 *  (如果 page 已硬删,title fallback '已删除页面'),LEFT JOIN users 拿 actor
 *  显示字段,LEFT JOIN spaces 拿 chip。
 *
 *  Registered BEFORE GET /:id 同 trash 路由的 dispatch 考虑。
 */
pagesRouter.get('/activity', async (c) => {
  const me = c.get('user')
  const spaceId = c.req.query('space')?.trim() || null

  // 分页 — 默认 20 条/页,上限 50(同 search.ts 的硬上限)。`?offset=N`
  // 翻页时用;空 offset/limit 用 schema default。
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  let { limit, offset } = parsed.args
  if (limit === undefined) limit = 20
  if (limit > 50) limit = 50

  // Accessibility scope。admin 短路 TRUE,普通用户拿 visibleSpaceIds。
  // Empty visible set 直接返空 —— 与 search.ts 一致的 fail-closed 行为。
  let accessibleScope: SQL
  if (me.role === 'admin') {
    accessibleScope = sql`TRUE`
  } else {
    const ids = await getAccessibleSpaceIds(me.id, false)
    if (ids === '*' || ids.length === 0) {
      return c.json({ items: [], hasMore: false })
    }
    accessibleScope = inArray(pageEvents.spaceId, ids)
  }
  const spaceFilter: SQL = spaceId ? eq(pageEvents.spaceId, spaceId) : sql`TRUE`

  // page_events → pages (拿最新 title) → users (actor name/color) → spaces (chip)
  // created_at DESC。LIMIT limit+1 → applyPagination 算 hasMore。
  // `?space=<id>` 走 page_events_space_created_idx 复合索引;无 space 过滤
  // 走 page_events_created_idx。
  const rows = await db
    .select({
      pageId: pageEvents.pageId,
      pageTitle: pages.title,
      kind: pageEvents.kind,
      actorId: pageEvents.actorId,
      actorName: users.name,
      actorColor: users.color,
      createdAt: pageEvents.createdAt,
      spaceId: pageEvents.spaceId,
      spaceName: spaces.name,
      spaceColor: spaces.color,
      spaceKind: spaces.kind,
    })
    .from(pageEvents)
    .leftJoin(pages, eq(pages.id, pageEvents.pageId))
    .leftJoin(users, eq(users.id, pageEvents.actorId))
    .leftJoin(spaces, eq(spaces.id, pageEvents.spaceId))
    .where(and(spaceFilter, accessibleScope))
    .orderBy(sql`${pageEvents.createdAt} DESC`)
    .limit(limit + 1)
    .offset(offset)

  // 分页收缩(limit+1 → hasMore)。先算 hasMore 再映射 kind/zod,避免
  // 对会被 drop 掉的那 1 行做无用映射。
  const page = applyPagination(rows, limit, offset)

  // kind 是应用层 enum (text 列),zod 验证。空 / 未知 kind 兜底 'edited' —
  // v0 数据全是受控写路径,defensive only。集合从 pageEvents.ts 来,避免
  // 新加 kind 时漏改这里 — 上一次坑:加 trashed/purged 没改这行,feed
  // 静默把它们打成 edited。
  const items = page.items
    .filter((r) => r.spaceId !== null)
    .map((r) => {
      const kindRaw = String(r.kind ?? '')
      const kind: PageEventKind =
        SUPPORTED_KINDS.has(kindRaw as PageEventKind)
          ? (kindRaw as PageEventKind)
          : 'edited'
      return ActivityEventSchema.parse({
        pageId: r.pageId,
        pageTitle: r.pageTitle ?? '(已删除页面)',
        kind,
        actorId: r.actorId ?? 'me',
        actorName: r.actorName,
        actorColor: r.actorColor,
        updatedAt: r.createdAt,
        spaceId: r.spaceId!,
        spaceName: r.spaceName ?? '(已删除空间)',
        spaceColor: r.spaceColor ?? '#888888',
        spaceKind: r.spaceKind ?? 'shared',
      })
    })

  return c.json({ items, hasMore: page.hasMore })
})

/* ─── (v1 activity 旧实现保留参考) ─────────────────────────────────────
 *  v1 走 pages.updated_at 派生,只能报「这页最近被改」,无法区分
 *  create / edit / move / restore / duplicate / publish。已废弃;改成读
 *  page_events(见上方 P1-3 v2)。
 *
 *  旧 sql 块保留作为「为什么不能用 pages.updated_at」的脚注(避免后人
 *  重新发明同一个轮子):
 *
 *    db.select({ pageId, updatedAt, actorId: pages.updatedBy, ... })
 *      .from(pages).leftJoin(users, ...).leftJoin(spaces, ...)
 *      .where(and(isNull(pages.deletedAt), spaceFilter, accessibleScope))
 *      .orderBy(sql`${pages.updatedAt} DESC`).limit(50)
 * ───────────────────────────────────────────────────────────────────── */

/* ─── GET /api/pages/trash ─────────────────────────────────────────────
 *  Admin-only. `?space=<id>` is REQUIRED — admins pick a space to inspect.
 *  Returns the trashed pages in that space (deleted_at IS NOT NULL),
 *  ordered by deletion time DESC so the most recent deletion sits on top.
 *
 *  P1-8:每次进来都先 lazy 跑一次 purgeExpiredTrash() — 读 admin 配置
 *  (trash_retention_days),hard-delete 掉 deleted_at < cutoff 的行,
 *  再返剩余 trash。retention=0 时跳过(DB no-op)。
 *
 *  Registered BEFORE GET /:id so Hono's first-match dispatch doesn't route
 *  "/trash" to the dynamic param handler.
 */
pagesRouter.get('/trash', async (c) => {
  const me = c.get('user')
  if (me.role !== 'admin') {
    return c.json({ error: 'forbidden', message: '需要管理员权限' }, 403)
  }
  const querySpace = c.req.query('space')
  if (!querySpace) {
    return c.json({ error: 'space_required' }, 400)
  }
  // P1-8: lazy purge — admin 打开 trash 顺手清。30s+ 的不活跃 purge
  // 计划进 v2(cron / 启动时跑)。lazy 是 v0 简化。
  await purgeExpiredTrash()
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args
  let q = selectPagesWithAuthor(
    and(eq(pages.spaceId, querySpace), isNotNull(pages.deletedAt)),
    { includeDeleted: true, viewerUserId: me.id },
  ).orderBy(sql`${pages.deletedAt} DESC`).$dynamic()
  if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
  const rows = await q
  const result = applyPagination(rows.map(rowToPageNode), limit, offset)
  return c.json(PaginatedListSchema(PageNodeSchema).parse(result))
})

/* ─── GET /api/pages/:id ──────────────────────────────────────────────
 *  Returns 404 if the page is in a space the current user can't access.
 *  Existence in inaccessible spaces is intentionally indistinguishable from
 *  "page doesn't exist".
 */
pagesRouter.get('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const [row] = await selectPagesWithAuthor(eq(pages.id, id), { viewerUserId: me.id })
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.spaceId === null) return c.json({ error: 'not_found' }, 404)
  if (!(await canAccessSpace(me.id, me.role === 'admin', row.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  return c.json(rowToPageNode(row))
})

/* ─── POST /api/pages ─────────────────────────────────────────────────
 *  spaceId is required by the schema. We additionally verify the user has
 *  access to the target space — for non-admin users this means the page
 *  will actually be visible to them after creation. (Same check is used
 *  for read and write in 4c; finer-grained perms come later if needed.)
 */
pagesRouter.post('/', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreatePageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  if (!(await canAccessSpace(me.id, me.role === 'admin', input.spaceId))) {
    // Hide whether the space exists at all.
    return c.json({ error: 'not_found' }, 404)
  }

  // Admin can't write into a personal space (even their own isn't an exception
  // — Confluence-style: admin supervises, doesn't edit).
  const blocked = await assertAdminNotWritingPersonalSpace(c, me, input.spaceId)
  if (blocked) return blocked

  // sortOrder: 显式传入则用,否则追加到末尾。
  let sortOrder = input.order
  if (sortOrder === undefined) {
    const nextOrderResult = await db.execute<{ nextOrder: number }>(sql`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS "nextOrder"
      FROM pages
      WHERE space_id = ${input.spaceId}
        AND ${input.parentId == null ? sql`parent_id IS NULL` : sql`parent_id = ${input.parentId}`}
    `)
    sortOrder = nextOrderResult.rows[0]?.nextOrder ?? 0
  }

  const now = Date.now()
  // Prefer client-supplied id (so optimistic inserts don't need a swap on response).
  const id = input.id ?? generatePageId()
  await db
    .insert(pages)
    .values({
      id,
      parentId: input.parentId ?? null,
      spaceId: input.spaceId,
      title: input.title ?? DEFAULT_TITLE, // '' would violate PageTitleSchema.min(1)
      icon: input.icon ?? null,
      contentJson: input.contentJSON ?? {},
      contentHtml: input.contentHTML ?? '',
      sortOrder,
      createdAt: now,
      updatedAt: now,
      updatedBy: me.id,
      authorId: me.id,
    })

  // P1-3 v2: emit a 'created' event for the activity feed.
  await recordPageEvent({
    pageId: id,
    spaceId: input.spaceId,
    kind: 'created',
    actor: me,
  })

  // Re-fetch via the LEFT JOIN helper so authorName / authorColor are populated.
  const [row] = await selectPagesWithAuthor(eq(pages.id, id), { viewerUserId: me.id })
  if (!row) return c.json({ error: 'not_found' }, 404)
  const node = rowToPageNode(row)
  // Validate the response shape with the same schema the frontend will use —
  // surfaces drift between Drizzle and PageNode at the boundary, not at runtime.
  return c.json(PageNodeSchema.parse(node), 201)
})

/* ─── PATCH /api/pages/:id ──────────────────────────────────────────── */
pagesRouter.patch('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdatePageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  // Pre-check: page must exist AND be in an accessible space AND not be trashed.
  const existing = (await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Admin can't edit a page that lives in a personal space. (The page's
  // existing space is the target — moving it would be a separate endpoint.)
  const blocked = await assertAdminNotWritingPersonalSpace(c, me, existing.spaceId)
  if (blocked) return blocked

  const patch: Partial<typeof pages.$inferInsert> = {
    updatedAt: Date.now(),
    updatedBy: me.id,
  }
  if (input.title !== undefined) patch.title = input.title
  if (input.contentJSON !== undefined) patch.contentJson = input.contentJSON
  if (input.contentHTML !== undefined) patch.contentHtml = input.contentHTML
  if (input.icon !== undefined) patch.icon = input.icon
  if (input.starred !== undefined) patch.starred = input.starred

  // PATCH 只更新 pages 行,**不再写 page_versions**。版本(checkpoint)由
  // 前端在 idle boundary / route leave 时主动打 POST /:id/snapshots 触发。
  //
  // 但保留 `isContentChange` 闸门避免空 UPDATE:ReadView 重复点同一 task
  // checkbox / Tiptap re-serialize 后端没法判 trivial diff,会让 hot row
  // 产生 no-op UPDATE 噪声。
  const effTitle = input.title ?? existing.title
  const effHtml = input.contentHTML ?? existing.contentHtml
  const effIcon = input.icon !== undefined ? input.icon : existing.icon
  const effJson = input.contentJSON ?? existing.contentJson
  const stableJson = (j: unknown) => JSON.stringify(j ?? {})
  const isContentChange =
    (input.title !== undefined && effTitle !== existing.title) ||
    (input.contentHTML !== undefined && effHtml !== existing.contentHtml) ||
    (input.icon !== undefined && effIcon !== existing.icon) ||
    (input.contentJSON !== undefined && stableJson(effJson) !== stableJson(existing.contentJson))

  if (isContentChange) {
    await db.update(pages).set(patch).where(eq(pages.id, id))
    // No 'edited' event here — auto-save (every 500ms while typing) would
    // spam the activity feed. The 'edited' event is fired instead by
    // POST /pages/:id/snapshots (idle 30s / route-leave boundary).
  }

  const [row] = await selectPagesWithAuthor(eq(pages.id, id), { viewerUserId: me.id })
  if (!row) return c.json({ error: 'not_found' }, 404)

  return c.json(PageNodeSchema.parse(rowToPageNode(row)))
})

/* ─── POST /api/pages/:id/snapshots ──────────────────────────────────
 *  打一个 boundary / idle checkpoint —— 镜像 pageVersions.ts restore
 *  handler 的 version-insert 写法(行 158-198),但**不恢复 page 行**,只
 *  往 page_versions 插一行。version create 时机由前端控制:
 *    - EditView idle 30s 自动触发(boundary)
 *    - EditView route leave 时 flush 触发
 *  PATCH 永远不自动打 snapshot —— 防止 auto-save 噪声灌满 history。
 *
 *  返回 201 + PageVersion DTO。同样的访问检查链(canAccessSpace +
 *  assertAdminNotWritingPersonalSpace)与 PATCH 一致;trashed page → 404。
 *  Retention 30 行复用 pageVersions.ts 的 RETENTION 常量(同 tx 裁剪)。
 */
pagesRouter.post('/:id/snapshots', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = SnapPageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }

  // 源页检查(同 PATCH / publish / duplicate)
  const [page] = await db.select().from(pages).where(eq(pages.id, id)).limit(1)
  if (!page || page.spaceId === null || page.deletedAt !== null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', page.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  const blocked = await assertAdminNotWritingPersonalSpace(c, me, page.spaceId)
  if (blocked) return blocked

  // 写 version + 裁剪 retention
  const now = Date.now()
  const versionId = generatePageId()
  let versionNumber = 1
  await db.transaction(async (tx) => {
    const versionResult = await tx.execute<{ nextVersion: number }>(sql`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion"
      FROM page_versions WHERE page_id = ${id}
    `)
    versionNumber = Number(versionResult.rows[0]?.nextVersion ?? 1)
    await tx.insert(pageVersions).values({
      id: versionId,
      pageId: id,
      versionNumber,
      title: page.title,
      contentJson: page.contentJson,
      contentHtml: page.contentHtml,
      icon: page.icon,
      editedBy: me.id,
      editedAt: now,
      changeNote: parsed.data?.changeNote ?? null,
    })
    await tx.execute(sql`
      DELETE FROM page_versions
      WHERE page_id = ${id}
        AND version_number <= (
          SELECT MAX(version_number) FROM page_versions WHERE page_id = ${id}
        ) - ${RETENTION}
    `)
  })

  // P1-3 v4: snapshot 边界 = 编辑边界。auto-save PATCH 不再单独打
  // 'edited' event(idle 30s / route-leave 会触发这个 snapshot,正好覆盖)。
  // 同样的活动语义,但事件密度跟 version history 对齐,feed 不被淹没。
  await recordPageEvent({
    pageId: id,
    spaceId: page.spaceId,
    kind: 'edited',
    actor: me,
  })

  // refetch + 渲染 DTO(LEFT JOIN users 拿编辑者姓名/颜色)
  const rows = await db
    .select({
      ...getTableColumns(pageVersions),
      editedByName: users.name,
      editedByColor: users.color,
    })
    .from(pageVersions)
    .leftJoin(users, eq(users.id, pageVersions.editedBy))
    .where(eq(pageVersions.id, versionId))
    .limit(1)
  const row = rows[0]
  if (!row) return c.json({ error: 'not_found' }, 404)

  // 组装 PageVersion DTO —— mirror pageVersions.ts:55-70 的 rowToPageVersion
  const v: PageVersion = {
    id: row.id,
    pageId: row.pageId,
    versionNumber: row.versionNumber,
    title: row.title,
    contentJSON: row.contentJson,
    contentHTML: row.contentHtml,
    editedBy: row.editedBy,
    editedByName: row.editedByName,
    editedByColor: row.editedByColor,
    editedAt: row.editedAt,
    changeNote: row.changeNote,
  }
  if (row.icon !== null) v.icon = row.icon
  return c.json(PageVersionSchema.parse(v), 201)
})

/* ─── POST /api/pages/:id/like ───────────────────────────────────────
 *  Toggle 端点 — 不接受 body,服务端 SELECT-then-INSERT/DELETE。
 *  响应只返最小回执 { liked, likesCount },前端 store 已在缓存里有
 *  PageNode,只需要合并这两个字段。返回 PageNode 整页是无谓开销
 *  (Tiptap contentJSON 经常 50KB+,移动端解析慢)。
 *
 *  并发安全:
 *    - 同一用户连点两次 → 第一次 INSERT,第二次 SELECT-then-DELETE,
 *      后到的请求总是查到正确状态。复合主键 (page_id, user_id) 保证幂等。
 *    - 不同用户并发 → SELECT-then-INSERT/DELETE 不是原子的,但 likesCount
 *      是 toggle 完后再 COUNT(*) 一次,反映最新;不会出现「我刚 like 但
 *      计数没变」的 stale read。前端用返回值覆盖本地计数即可,不要再乐观推算。
 *    - like INSERT + notification INSERT 在同一事务里 —— 避免「赞了但作者
 *      没收到通知」(掉了一边) 或「没赞但收到通知」(极端竞态)。
 *
 *  权限:能 canAccessSpace(page.spaceId) 的人才能 like —— 私域成员互赞
 *  是正常的,匿名公开不算(暂未支持)。trashed page 直接 404。
 *
 *  Admin 写 personal space 的反向保护:assertAdminNotWritingPersonalSpace
 *  不应用在这里 —— like 是**读语义**,不修改 page 行,不污染作者。
 *  只挡 admin 通过写路径 PATCH/publish/duplicate。这条保留 admin 也能
 *  赞别人 personal draft 的语义(虽然罕见)。
 *
 *  通知:like → 给页面作者发一条 page_like;unlike → 静默(不补发通知,
 *  也不发"取消赞"通知,Notion / Confluence 都这么做)。自己赞自己的页
 *  不通知(actor === recipient 时 enqueueNotifications 直接过滤)。
 */
pagesRouter.post('/:id/like', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  // Access check + page existence check (also need authorId + title for notification).
  const [page] = await db
    .select({
      spaceId: pages.spaceId,
      deletedAt: pages.deletedAt,
      authorId: pages.authorId,
      title: pages.title,
    })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1)
  if (!page || page.spaceId === null || page.deletedAt !== null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', page.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Toggle + (optional) notification in one tx so we don't split-brain like vs notify.
  let liked = false
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: pageLikes.userId })
      .from(pageLikes)
      .where(and(eq(pageLikes.pageId, id), eq(pageLikes.userId, me.id)))
      .limit(1)
    if (existing.length > 0) {
      await tx
        .delete(pageLikes)
        .where(and(eq(pageLikes.pageId, id), eq(pageLikes.userId, me.id)))
      liked = false
    } else {
      await tx.insert(pageLikes).values({
        pageId: id,
        userId: me.id,
        createdAt: Date.now(),
      })
      liked = true
      // page_like 通知 —— enqueueNotifications 内部已经过滤 actor === recipient,
      // 所以 page.authorId === me.id 的自赞不会发通知。
      await enqueueNotifications(tx, {
        kind: 'page_like',
        actor: me,
        pageId: id,
        pageTitle: page.title,
        commentId: null,
        pageAuthorId: page.authorId,
      })
    }
  })

  // 实时 COUNT(*) 一下,不用前端 optimistic 推算
  const countResult = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM page_likes WHERE page_id = ${id}
  `)
  const likesCount = Number(countResult.rows[0]?.count ?? 0)

  return c.json(ToggleLikeResponseSchema.parse({ liked, likesCount }))
})

/* ─── PATCH /api/pages/:id/move ────────────────────────────────────── */
pagesRouter.patch('/:id/move', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = MovePageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  // Pre-check: target page must be in an accessible space AND not be trashed.
  const existing = (await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Cross-space move: newSpaceId optional. When present, the page is moved
  // to that space's root (newParentId MUST be null in that case — we don't
  // support re-parenting across a space boundary because target sub-pages
  // would create confusing cross-space parent chains in the UI).
  let targetSpaceId = existing.spaceId
  let targetParentId = input.newParentId
  if (input.newSpaceId !== undefined) {
    if (input.newParentId !== null) {
      return c.json(
        { error: 'cross_space_no_parent', message: '跨空间移动时 newParentId 必须为 null' },
        400,
      )
    }
    // Source-side guard: cross-space moves are only allowed from a personal
    // space (草稿→发布). Team-to-team moves are not part of the personal-space
    // design — a user wanting to share a page should be in their personal
    // space first (drag from personal to a team space), not moving between
    // shared spaces. This keeps the "personal = draft, shared = publish"
    // mental model intact at the API boundary; the frontend gates the same
    // condition via `hasMoveTargets` for UX, but the API enforces it.
    const [sourceSpace] = await db
      .select({ kind: spaces.kind })
      .from(spaces)
      .where(eq(spaces.id, existing.spaceId))
      .limit(1)
    if (!sourceSpace || sourceSpace.kind !== 'personal') {
      return c.json(
        {
          error: 'personal_move_only',
          message: '只有个人空间的页面可以跨空间移动(发布到团队空间)',
        },
        403,
      )
    }
    if (input.newSpaceId === existing.spaceId) {
      // Same-space move via cross-space endpoint — treat as a plain root move.
      // Skipping newSpaceId in the request is the cleanest way to express
      // "re-parent to root in same space", but accepting the alias is more
      // forgiving for the frontend.
      targetSpaceId = existing.spaceId
    } else {
      if (!(await canAccessSpace(me.id, me.role === 'admin', input.newSpaceId))) {
        return c.json({ error: 'not_found' }, 404)
      }
      // Admin can't write into a personal space (admin would be moving INTO it).
      const blocked = await assertAdminNotWritingPersonalSpace(c, me, input.newSpaceId)
      if (blocked) return blocked
      targetSpaceId = input.newSpaceId
      targetParentId = null
    }
  }

  // Same-space: if the new parent is set, it must be in the same space as
  // the page being moved (cross-space parents would not make sense).
  if (targetSpaceId === existing.spaceId && targetParentId !== null) {
    const [parent] = await db
      .select({ spaceId: pages.spaceId })
      .from(pages)
      .where(eq(pages.id, targetParentId))
      .limit(1)
    if (!parent || parent.spaceId !== existing.spaceId) {
      return c.json({ error: 'not_found' }, 404)
    }
  }

  // Cycle protection: can't move into self or a descendant of self. Only
  // applies to same-space re-parenting (cross-space move lands at root).
  if (
    targetSpaceId === existing.spaceId &&
    targetParentId !== null &&
    (await isDescendantOrSelf(targetParentId, id))
  ) {
    return c.json({ error: 'cycle' }, 409)
  }

  // Admin edit-blocker for same-space re-parenting of a personal-space page:
  // the page already lives in a personal space, so the move is a write to it.
  if (targetSpaceId === existing.spaceId) {
    const blocked = await assertAdminNotWritingPersonalSpace(c, me, existing.spaceId)
    if (blocked) return blocked
  }

  const insertAt = input.newOrder ?? Number.MAX_SAFE_INTEGER // sentinel: "append"

  // Collect the target parent's current LIVE children (excluding self),
  // ordered. This becomes the basis for the new sortOrder sequence after
  // the move.
  //
  // MUST filter `deletedAt IS NULL`: trashed rows keep their old sortOrder
  // forever, so including them makes the renumber loop interleave renumbered
  // live rows with stale trashed values — moved page lands at a "gap" index
  // relative to its live siblings (frontend `pages.value` is also live-only,
  // so the client's `newOrder` clamp was always one less than the server's).
  const targetSiblings = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, targetSpaceId),
        targetParentId === null
          ? isNull(pages.parentId)
          : eq(pages.parentId, targetParentId),
        ne(pages.id, id),
        isNull(pages.deletedAt),
      ),
    )
    .orderBy(pages.sortOrder)

  const others = targetSiblings.map((s) => s.id)
  const clamped = Math.max(0, Math.min(insertAt, others.length))
  const orderedIds = [...others.slice(0, clamped), id, ...others.slice(clamped)]

  // One transaction: bump self to a temporary sortOrder (so the loop below
  // doesn't fight itself when reparenting within the same parent), then
  // rewrite every sibling in the target list to its new 0-based order.
  // For cross-space moves we also flip spaceId + parentId in the same
  // transaction so a partial failure doesn't leave the page half-moved.
  await db.transaction(async (tx) => {
    await tx
      .update(pages)
      .set({
        spaceId: targetSpaceId,
      parentId: targetParentId,
      sortOrder: -1,
      updatedAt: Date.now(),
      updatedBy: me.id,
    })
      .where(eq(pages.id, id))
    // Sequentially rewrite sibling order — the `await` ensures every UPDATE
    // commits before the transaction's COMMIT (Drizzle queues tx.update()
    // calls and awaits them in order). Without `await`, `void tx.update()`
    // would fire-and-forget, and the post-transaction SELECT below could
    // observe a row with sortOrder=-1 — which fails the PageNode schema's
    // `nonnegative` check at the response boundary.
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(pages)
        .set({ sortOrder: i })
        .where(eq(pages.id, orderedIds[i]!))
    }
  })

  // P1-3 v2: emit 'moved' event AFTER the tx commits (targetSpaceId is
  // already in effect on the page row, so we record under the new space).
  // For cross-space moves, payload carries the source space so the UI
  // could later show "moved from {srcSpace} → {dstSpace}".
  await recordPageEvent({
    pageId: id,
    spaceId: targetSpaceId,
    kind: 'moved',
    actor: me,
    payload: {
      fromSpaceId: existing.spaceId,
      toSpaceId: targetSpaceId,
      fromParentId: existing.parentId,
      toParentId: targetParentId,
    },
  })

  const [row] = await selectPagesWithAuthor(eq(pages.id, id), { viewerUserId: me.id }).limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageNodeSchema.parse(rowToPageNode(row)))
})

/* ─── POST /api/pages/:id/publish ─────────────────────────────────────
 *  "发布到" — 草稿→团队空间的复制语义,跟 PATCH /:id/move 走的是不同
 *  路径:move 是把页面本身搬家,publish 是在目标空间**另起一个**新页,
 *  原页保留在 personal space 不动。
 *
 *  适用场景:用户在个人空间起草一份文档,写完后想分享到团队空间。
 *  复制而不是移动的好处 ——
 *    - 个人草稿是作者的「想法/未完成工作」,不应该被发布行为破坏。
 *    - 发布后还能继续在 personal space 迭代,二次发布会再生成一份。
 *  限制:
 *    - 源 page 必须是当前用户**自己** personal space 的页(非自己 personal
 *      不允许,防 admin 越权 / 偷发别人草稿)。
 *    - 目标空间必须对当前用户 canAccess(普通规则)。
 *    - admin 发布 personal-space 页面:admin 不是任何 personal space 的
 *      owner,所以这条天然挡掉,不需要 personalSpaceGuard。
 *  标题后缀:`(来自 {userName} 的个人分享)`。userName 取自 users 表的
 *  name 字段(失败 fallback 为「我」,绝不抛错)。
 *  子页面:**不**递归复制 — 单页发布,作者可以选择是否要继续逐个发布子页。
 */
pagesRouter.post('/:id/publish', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = PublishPageInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { targetSpaceId } = parsed.data

  // 源页必须存在、未删除
  const [source] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1)
  if (!source || source.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  // 必须可访问(读得到,才能复制)
  if (!(await canAccessSpace(me.id, me.role === 'admin', source.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // 源必须是 current user's personal space
  const [sourceSpace] = await db
    .select({ kind: spaces.kind, ownerId: spaces.ownerId })
    .from(spaces)
    .where(eq(spaces.id, source.spaceId))
    .limit(1)
  if (!sourceSpace || sourceSpace.kind !== 'personal') {
    return c.json(
      {
        error: 'publish_source_must_be_personal',
        message: '只有个人空间的页面可以发布到团队空间',
      },
      403,
    )
  }
  // admin 跳过 owner 校验(见 personalSpaceGuard.ts 反向保护 admin 写 personal 的逻辑),
  // 但 admin 不是任何 personal space 的 owner,所以这条 path 走不到 ——
  // 个人空间的 ownerId === me.id 限制天然挡住 admin 偷发别人草稿。
  if (sourceSpace.ownerId !== me.id) {
    return c.json(
      { error: 'publish_not_owner', message: '只能发布自己个人空间的页面' },
      403,
    )
  }

  // 目标空间必须存在且可写
  if (!(await canAccessSpace(me.id, me.role === 'admin', targetSpaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  const [targetSpace] = await db
    .select({ kind: spaces.kind })
    .from(spaces)
    .where(eq(spaces.id, targetSpaceId))
    .limit(1)
  if (!targetSpace) return c.json({ error: 'not_found' }, 404)
  // 不允许发回 personal space(防个人空间污染)
  if (targetSpace.kind === 'personal') {
    return c.json(
      { error: 'publish_target_not_personal', message: '不能发布到个人空间' },
      400,
    )
  }
  // 不能发到原 space
  if (targetSpaceId === source.spaceId) {
    return c.json(
      { error: 'publish_same_space', message: '发布目标不能是同一个空间' },
      400,
    )
  }

  // 作者名 — 用于标题后缀。查不到 / 名字为空时回退到「我」
  const [author] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, me.id))
    .limit(1)
  const sharerName = author?.name?.trim() || '我'

  const now = Date.now()
  const newId = generatePageId()
  // sortOrder: 追加到目标空间根列表末尾
  const nextOrderResult = await db.execute<{ nextOrder: number }>(sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS "nextOrder"
    FROM pages
    WHERE space_id = ${targetSpaceId}
      AND parent_id IS NULL
  `)
  const sortOrder = nextOrderResult.rows[0]?.nextOrder ?? 0

  // 标题拼接 — 如果原标题已含同样的后缀就不再重复,避免"原标题(来自 X 的个人分享)(来自 X 的个人分享)"。
  const suffix = `（来自 ${sharerName} 的个人分享）`
  const baseTitle = (source.title || '').trim() || '未命名'
  const newTitle = baseTitle.includes(suffix) ? baseTitle : `${baseTitle}${suffix}`

  await db.insert(pages).values({
    id: newId,
    parentId: null,
    spaceId: targetSpaceId,
    title: newTitle,
    icon: source.icon ?? null,
    contentJson: source.contentJson,
    contentHtml: source.contentHtml,
    sortOrder,
    createdAt: now,
    updatedAt: now,
    updatedBy: me.id,
    authorId: me.id,
  })

  // P1-3 v2: emit 'published' event on the NEW page. Source stays in the
  // personal space and is NOT re-stamped — the act of publishing is a new
  // page event, not an edit on the source.
  await recordPageEvent({
    pageId: newId,
    spaceId: targetSpaceId,
    kind: 'published',
    actor: me,
    payload: { sourcePageId: source.id },
  })

  const [row] = await selectPagesWithAuthor(eq(pages.id, newId), { viewerUserId: me.id }).limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageNodeSchema.parse(rowToPageNode(row)), 201)
})

/* ─── POST /api/pages/:id/duplicate ───────────────────────────────────
 *  In-place sibling copy: creates a fresh page in the SAME space and SAME
 *  parent as the source, immediately AFTER the source in sibling order.
 *  Title is prefixed with `复制自` (per spec). Content (Tiptap JSON + HTML
 *  + icon) is copied verbatim; starred / labels are intentionally NOT
 *  inherited — they're user-level opinions that don't follow a copy.
 *
 *  Mirrors `/publish` for read+copy+refetch and `/move` for the sibling
 *  renumber transaction (`sortOrder: -1` sentinel dodges the unique-index
 *  conflict window when we rewrite every sibling in the source's group).
 *
 *  Personal-space guard (assertAdminNotWritingPersonalSpace) applies the
 *  same way as PATCH/DELETE — an admin duplicating someone else's personal
 *  draft gets 403 `personal_space_readonly` instead of leaking content.
 */
pagesRouter.post('/:id/duplicate', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  // Empty body is fine — schema is z.object({}).optional().
  await c.req.json().catch(() => ({}))
  const parsed = DuplicatePageInputSchema.safeParse({})
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }

  // Source must exist and be a live (non-trashed) page.
  const [source] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1)
  if (!source || source.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Must be able to read the source — pre-flight for the visible-space set.
  if (!(await canAccessSpace(me.id, me.role === 'admin', source.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Personal-space reverse-guard: same rule as PATCH / DELETE / move for
  // non-owner admins. The new page lives in the source's space, so an admin
  // duplicating someone else's personal-space draft is rejected here.
  const blocked = await assertAdminNotWritingPersonalSpace(c, me, source.spaceId)
  if (blocked) return blocked

  // Title — spec is literally `复制自{原标题}`. Trim to satisfy PageTitleSchema's
  // min(1) on the off-chance the source title is empty/whitespace.
  const baseTitle = (source.title ?? '').trim() || '未命名'
  const newTitle = `复制自${baseTitle}`
  // No idempotency loop on `复制自`-prefix: continuous duplication yields
  // "复制自复制自X" chains, matching Confluence's behavior and keeping the
  // semantics simple.

  // Position — sibling list ordered by sortOrder. We want the new page to
  // land at source.index+1. Since this page doesn't exist yet, we don't need
  // to bump a row to sortOrder=-1 first — the sentinel is only needed when
  // rewriting an existing row's group. The INSERT with sortOrder=-1 + the
  // sibling rename below together produce the same observable end state.
  const siblings = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, source.spaceId),
        source.parentId === null
          ? isNull(pages.parentId)
          : eq(pages.parentId, source.parentId),
      ),
    )
    .orderBy(pages.sortOrder)

  const orderedSiblingIds = siblings.map((s) => s.id)
  const sourceIdx = orderedSiblingIds.indexOf(id)
  // sourceIdx is guaranteed ≥ 0 (source is in the list) since we queried
  // the same (spaceId, parentId) bucket. Fall back to append-only if a
  // concurrent race somehow removes the source row between SELECTs.
  const insertAt = sourceIdx < 0 ? orderedSiblingIds.length : sourceIdx + 1
  const newId = generatePageId()
  const now = Date.now()

  await db.transaction(async (tx) => {
    await tx.insert(pages).values({
      id: newId,
      parentId: source.parentId,
      spaceId: source.spaceId,
      title: newTitle,
      icon: source.icon ?? null,
      contentJson: source.contentJson,
      contentHtml: source.contentHtml,
      sortOrder: -1, // sentinel — rewritten below; avoids unique-index conflict
      createdAt: now,
      updatedAt: now,
      updatedBy: me.id,
      authorId: me.id, // the duplicator becomes the new page's author
      // starred / labels / deleted_* intentionally NOT copied — fresh page.
    })
    // Sequentially rewrite sortOrder 0..N with newId at position insertAt.
    // Await every update (don't fire-and-forget) so the post-tx SELECT
    // observes the final state — mirrors the comment in /move.
    for (let i = 0; i < orderedSiblingIds.length + 1; i++) {
      const targetId =
        i < insertAt
          ? orderedSiblingIds[i]!
          : i === insertAt
            ? newId
            : orderedSiblingIds[i - 1]!
      await tx
        .update(pages)
        .set({ sortOrder: i, updatedAt: now })
        .where(eq(pages.id, targetId))
    }
  })

  // P1-3 v2: emit 'duplicated' event on the NEW copy. Source row is
  // untouched — duplicating is a new-page event, not an edit.
  await recordPageEvent({
    pageId: newId,
    spaceId: source.spaceId,
    kind: 'duplicated',
    actor: me,
    payload: { sourcePageId: id },
  })

  const [row] = await selectPagesWithAuthor(eq(pages.id, newId), { viewerUserId: me.id }).limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageNodeSchema.parse(rowToPageNode(row)), 201)
})

/* ─── POST /api/pages/:id/restore ─────────────────────────────────────
 *  Admin-only. Restores a single trashed page by clearing its deleted_at.
 *  Refuses 409 parent_trashed if the page's parent_id points at a still-
 *  trashed row (admin must restore the parent first). Refuses 409
 *  not_trashed if the row isn't in the trash (idempotency: a no-op double
 *  restore shouldn't silently succeed).
 */
pagesRouter.post('/:id/restore', async (c) => {
  const me = c.get('user')
  if (me.role !== 'admin') {
    return c.json({ error: 'forbidden', message: '需要管理员权限' }, 403)
  }
  const id = c.req.param('id')

  // Load the row regardless of trash state — we need parent_id and spaceId
  // even on trashed rows to validate the parent chain.
  const existing = (await db.select().from(pages).where(eq(pages.id, id)).limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (existing.deletedAt == null) {
    return c.json({ error: 'not_trashed' }, 409)
  }
  // Parent must exist AND not be trashed (null parent is fine — root).
  if (existing.parentId !== null) {
    const [parent] = await db
      .select({ deletedAt: pages.deletedAt })
      .from(pages)
      .where(eq(pages.id, existing.parentId))
      .limit(1)
    if (!parent || parent.deletedAt !== null) {
      return c.json(
        { error: 'parent_trashed', parentId: existing.parentId },
        409,
      )
    }
  }

  await db
    .update(pages)
    .set({ deletedAt: null, deletedBy: null, updatedAt: Date.now(), updatedBy: me.id })
    .where(and(eq(pages.id, id), isNotNull(pages.deletedAt)))

  // P1-3 v2: emit 'restored' event so the activity feed surfaces the
  // recovery (vs. mistaking it for an edit).
  await recordPageEvent({
    pageId: id,
    spaceId: existing.spaceId,
    kind: 'restored',
    actor: me,
  })

  return c.body(null, 204)
})

/* ─── DELETE /api/pages/:id ───────────────────────────────────────────
 *  Stage 5: soft-delete by default. Hard-delete is admin-only via
 *  `?purge=true` and requires the row to already be trashed.
 *
 *  Soft-delete:
 *    - Refuses 409 has_children if non-trashed children exist (admin/user
 *      must delete children first).
 *    - Single-row UPDATE — no recursion needed because we don't allow
 *      trashing parents.
 *    - Anyone with access to the page's space can soft-delete (matches
 *      pre-Stage 5 DELETE behaviour for permissions).
 *
 *  Purge (admin only):
 *    - Row must already be trashed, else 409 not_trashed.
 *    - Recursive CTE hard-delete of the subtree (handles the case where
 *      descendants were individually trashed earlier).
 */
pagesRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const purge = c.req.query('purge') === 'true'

  if (purge && me.role !== 'admin') {
    return c.json({ error: 'forbidden', message: '需要管理员权限' }, 403)
  }

  // Pre-check: load row regardless of trash state — purge needs to see
  // already-trashed rows. Soft-delete filters them out so we don't
  // double-trash.
  const existing = (await db
    .select({
      spaceId: pages.spaceId,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1))[0]
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Admin can't soft-delete a personal-space page (purge is fine — admin
  // recovery / compliance path is explicitly allowed by the design).
  if (!purge) {
    const blocked = await assertAdminNotWritingPersonalSpace(c, me, existing.spaceId)
    if (blocked) return blocked
  }

  if (purge) {
    if (existing.deletedAt == null) {
      return c.json({ error: 'not_trashed' }, 409)
    }
    // Stage 6 extension: page purge must also wipe its comments and
    // notifications. The id join uses `getPageSubtree` (Stage 5 recursive
    // CTE) so descendants that were individually trashed earlier still
    // belong to this root and get wiped too.
    const subtreeIds = await getPageSubtree(id)
    if (subtreeIds.length === 0) return c.json({ error: 'not_found' }, 404)
    // Attachments: collect S3 keys BEFORE the transaction wipes the rows, so
    // we can best-effort delete the objects after COMMIT. DB is source of
    // truth; orphaned S3 objects are tolerated (a future GC can sweep them).
    const attachmentRows = await db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(inArray(attachments.pageId, subtreeIds))
    await db.transaction(async (tx) => {
      await tx
        .delete(notificationsTable)
        .where(inArray(notificationsTable.pageId, subtreeIds))
      await tx
        .delete(commentsTable)
        .where(inArray(commentsTable.pageId, subtreeIds))
      // Stage 8: history + labels ride along with page purge. No FK so
      // they're wiped explicitly in the same transaction as pages.
      await tx
        .delete(pageVersions)
        .where(inArray(pageVersions.pageId, subtreeIds))
      await tx
        .delete(pageLabels)
        .where(inArray(pageLabels.pageId, subtreeIds))
      await tx
        .delete(pageLikes)
        .where(inArray(pageLikes.pageId, subtreeIds))
      await tx
        .delete(attachments)
        .where(inArray(attachments.pageId, subtreeIds))
      await tx.delete(pages).where(inArray(pages.id, subtreeIds))
    })
    // Best-effort object cleanup — failures leave orphans, only logged.
    for (const { storageKey } of attachmentRows) {
      try {
        await deleteObject(storageKey)
      } catch (err) {
        console.warn('[purge] failed to delete object', storageKey, err)
      }
    }
    // Activity feed — purge event references the now-deleted pageId. The
    // LEFT JOIN in GET /activity will surface title=null and the view
    // renders "(无标题)". Event row stays put (no FK, no cascade).
    await recordPageEvent({
      pageId: id,
      spaceId: existing.spaceId,
      kind: 'purged',
      actor: me,
    })
    return c.body(null, 204)
  }

  // Soft-delete path. The row must not already be trashed (idempotency).
  if (existing.deletedAt !== null) {
    return c.json({ error: 'not_trashed' }, 409)
  }

  // Count non-trashed children with the same parent_id = this page.
  // Cheap (already covered by `pages_parent_idx`) and avoids any
  // cross-space / recursive CTE.
  const childRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.parentId, id),
        isNull(pages.deletedAt),
      ),
    )
  if (childRows.length > 0) {
    return c.json(
      { error: 'has_children', childCount: childRows.length },
      409,
    )
  }

  await db
    .update(pages)
    .set({ deletedAt: Date.now(), deletedBy: me.id, updatedAt: Date.now(), updatedBy: me.id })
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))

  await recordPageEvent({
    pageId: id,
    spaceId: existing.spaceId,
    kind: 'trashed',
    actor: me,
  })

  return c.body(null, 204)
})

// Re-export the alphabet for tests / fixtures.
export { PAGE_ID_ALPHABET }