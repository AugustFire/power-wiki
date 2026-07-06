/**
 * Search API — `GET /api/search?q=&space=&label=&limit=&offset=`
 *
 * 零中间件搜索:`pages.title ILIKE '%q%'` + 可选 space / label 过滤 + 可见空间闸门。
 * 不引 FTS、不引 pg_trgm、不建新表、不上 migration。当前规模(< 5k 页)单表 ILIKE < 10ms,
 * 等到性能真痛再加 tsvector。
 *
 * 三个过滤维度(全部 optional,AND 组合):
 *   - `q`     → title 子串(大小写不敏感;LIKE 通配符 `%` `_` `\` 自动转义)
 *   - `space` → 空间 id。空 = 不过滤空间
 *   - `label` → 精确匹配(已规范化的 lowercase 字符串)
 *
 * 权限模型与 `pages.list` 一致:
 *   - admin      → 看全部
 *   - 非 admin   → `getAccessibleSpaceIds(me.id, false)` 限定的可见空间
 *   - 不可见空间 → `accessibleScope` AND 自然过滤为 0 行,不返 404(避免泄漏空间存在性)
 *
 * 响应:`Paginated<PageNode>`,沿用 `pages.list` 的 schema 边界校验模式。
 */
import { Hono } from 'hono'
import { and, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { PageNodeSchema, PaginatedListSchema } from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { pageLabels, pages, users } from '../db/schema'
import { rowToPageNode } from '../lib/rowToPageNode'
import { getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { type Variables } from '../auth/middleware'

export const searchRouter = new Hono<{ Variables: Variables }>()

/**
 * Escape LIKE wildcards in user input. Without this, a user typing `%` in the
 * search box would match every row (LIKE treats `%` as "any string"). The
 * backend uses `ESCAPE '\\'` so the resulting SQL is `title ILIKE $1 ESCAPE '\'`.
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

searchRouter.get('/', async (c) => {
  const me = c.get('user')
  const rawQ = (c.req.query('q') ?? '').trim()
  const spaceId = c.req.query('space')?.trim() || null
  const labelRaw = c.req.query('label')?.trim() || null
  // Labels are stored normalized (lowercase + trim, server-enforced in
  // pageLabels.ts). Lowercasing here is a defensive backstop in case the
  // caller didn't normalize.
  const label = labelRaw ? labelRaw.toLowerCase() : null

  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  let { limit, offset } = parsed.args
  if (limit === undefined) limit = 20
  // Hard cap at 50 to bound the JSON-aggregation query plan; matches the
  // cap used by pageVersions.ts:99.
  if (limit > 50) limit = 50

  // Accessibility scope. Admin short-circuits to TRUE; non-admin builds an
  // inArray over the user's visible spaces. An empty visible set returns
  // early with no DB hit beyond the access lookup itself.
  let accessibleScope: SQL
  if (me.role === 'admin') {
    accessibleScope = sql`TRUE`
  } else {
    const ids = await getAccessibleSpaceIds(me.id, false)
    if (ids === '*' || ids.length === 0) {
      return c.json({ items: [], limit, offset, hasMore: false })
    }
    accessibleScope = inArray(pages.spaceId, ids)
  }

  // Each filter is `TRUE` when its dimension is not provided, so the same
  // SQL template works for any combination of q/space/label.
  const titleFilter: SQL = rawQ
    ? sql`${pages.title} ILIKE ${'%' + escapeLike(rawQ) + '%'} ESCAPE '\\'`
    : sql`TRUE`
  const spaceFilter: SQL = spaceId ? eq(pages.spaceId, spaceId) : sql`TRUE`
  // Label filter via EXISTS subquery. The LEFT JOIN to page_labels is still
  // needed below for the labels aggregation, but the WHERE filter rides on
  // EXISTS so we don't multiply result rows and don't need DISTINCT on the
  // GROUP BY.
  const labelFilter: SQL = label
    ? sql`EXISTS (SELECT 1 FROM ${pageLabels} WHERE ${pageLabels.pageId} = ${pages.id} AND ${pageLabels.label} = ${label})`
    : sql`TRUE`

  const labelsAgg = sql<string[]>`
    COALESCE(
      json_agg(DISTINCT ${pageLabels.label})
        FILTER (WHERE ${pageLabels.label} IS NOT NULL),
      '[]'::json
    )
  `.as('labels')
  // 与 pages.ts 的 selectPagesWithAuthor 同样的 EXISTS 子查询 — 搜索结果
  // 也返回 PageNode,前端 PageTree 渲染依赖 hasChildren 判断 caret,缺这个字段
  // 会让搜索结果的页面在 sidebar 里被加进树时显示错误 caret。
  const hasChildrenExpr = sql<boolean>`
    EXISTS (
      SELECT 1 FROM pages c
      WHERE c.parent_id = ${pages.id}
        AND c.deleted_at IS NULL
    )
  `.as('has_children')

  const rows = await db
    .select({
      ...getTableColumns(pages),
      authorName: users.name,
      authorColor: users.color,
      labels: labelsAgg,
      hasChildren: hasChildrenExpr,
    })
    .from(pages)
    .leftJoin(users, eq(pages.authorId, users.id))
    .leftJoin(pageLabels, eq(pageLabels.pageId, pages.id))
    .where(
      and(
        isNull(pages.deletedAt),
        titleFilter,
        spaceFilter,
        labelFilter,
        accessibleScope,
      ),
    )
    .groupBy(pages.id, users.name, users.color)
    // updatedAt DESC: freshest first. v0 doesn't need a relevance score —
    // title substring + recency covers the "what changed recently" use case
    // well enough. Sort by relevance only if a user reports that the most
    // recent page wins over the title-hit one.
    .orderBy(sql`${pages.updatedAt} DESC`)
    .limit(limit + 1)
    .offset(offset)

  const result = applyPagination(rows.map(rowToPageNode), limit, offset)
  return c.json(PaginatedListSchema(PageNodeSchema).parse(result))
})
