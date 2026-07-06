/**
 * Page versions API — Stage 8 (history / version compare).
 *
 *   GET    /api/pages/:id/versions?limit=20&offset=0 → Paginated<PageVersion>
 *   POST   /api/pages/:id/versions/:versionId/restore → PageNode (snapshot
 *                                                       re-applied + new
 *                                                       version row inserted)
 *
 * Mounted in apps/api/src/index.ts under `/api/pages` (sub-router). The
 * `versions` PATCH integration lives in apps/api/src/routes/pages.ts — every
 * successful content PATCH inserts a snapshot row inside the same tx.
 *
 * Permissions:
 *   - GET requires `canAccessSpace(me, admin, page.spaceId)`. 404 (not 403)
 *     when inaccessible, to avoid leaking page id existence.
 *   - POST restore requires `canAccessSpace` (write = read in this codebase)
 *     PLUS `assertAdminNotWritingPersonalSpace` — restore is a write.
 *
 * Retention: keep latest 30 per page. Both the PATCH tx and the restore tx
 * trim rows after the INSERT.
 */

import { Hono } from 'hono'
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import { PageNodeSchema, PageVersionSchema, PaginatedListSchema } from '@power-wiki/shared/schemas'
import type { PageVersion } from '@power-wiki/shared'
import { db } from '../db/client'
import { pageVersions, pages, users } from '../db/schema'
import { generatePageId } from '../lib/ids'
import { rowToPageNode } from '../lib/rowToPageNode'
import { canAccessSpace } from '../lib/accessibleSpaceIds'
import { assertAdminNotWritingPersonalSpace } from '../lib/personalSpaceGuard'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { type Variables } from '../auth/middleware'

export const pageVersionsRouter = new Hono<{ Variables: Variables }>()

/** 历史保留条数 —— 同步给 `pages.ts` 的 snapshot route。 */
export const RETENTION = 30

type VersionRowWithEditor = {
  id: string
  pageId: string
  versionNumber: number
  title: string
  contentJson: PageVersion['contentJSON']
  contentHtml: string
  icon: string | null
  editedBy: string
  editedAt: number
  changeNote: string | null
  editedByName: string | null
  editedByColor: string | null
}

function rowToPageVersion(row: VersionRowWithEditor): PageVersion {
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
  return v
}

/* ─── GET /api/pages/:id/versions ────────────────────────────────────
 *  Returns versions for one page, newest first. ?limit (1-50, default 20).
 *  404 if page missing / inaccessible / trashed (leak prevention).
 */
pageVersionsRouter.get('/:id/versions', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  const [page] = await db
    .select({ spaceId: pages.spaceId, deletedAt: pages.deletedAt })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1)
  if (!page || page.spaceId === null || page.deletedAt !== null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', page.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  // Hard-cap limit at 50 to bound the LEFT JOIN + ORDER BY.
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  let { limit, offset } = parsed.args
  if (limit === undefined) limit = 20
  if (limit > 50) limit = 50
  if (offset === undefined) offset = 0

  const rows = await db
    .select({
      ...getTableColumns(pageVersions),
      editedByName: users.name,
      editedByColor: users.color,
    })
    .from(pageVersions)
    .leftJoin(users, eq(users.id, pageVersions.editedBy))
    .where(eq(pageVersions.pageId, id))
    .orderBy(sql`${pageVersions.versionNumber} DESC`)
    .limit(limit + 1)
    .offset(offset)

  const items = rows.map(rowToPageVersion)
  const result = applyPagination(items, limit, offset)
  return c.json(PaginatedListSchema(PageVersionSchema).parse(result))
})

/* ─── POST /api/pages/:id/versions/:versionId/restore ─────────────────
 *  Re-applies the snapshot fields (title / contentJSON / contentHTML / icon)
 *  to the page and inserts a new version row with auto-note
 *  "restored from v{N}". Returns the updated PageNode.
 *
 *  Trashed pages refuse 409 (restore the page first). Admin-on-personal 403.
 *  Missing version → 404.
 */
pageVersionsRouter.post('/:id/versions/:versionId/restore', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const versionId = c.req.param('versionId')

  // Pre-check: page must exist, be accessible, and not be trashed.
  const [existing] = await db
    .select()
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1)
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (existing.deletedAt !== null) {
    return c.json({ error: 'page_trashed' }, 409)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', existing.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const blocked = await assertAdminNotWritingPersonalSpace(c, me, existing.spaceId)
  if (blocked) return blocked

  const [version] = await db
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.id, versionId), eq(pageVersions.pageId, id)))
    .limit(1)
  if (!version) return c.json({ error: 'not_found' }, 404)

  const now = Date.now()
  await db.transaction(async (tx) => {
    // Insert a new version row representing the post-restore state. The
    // snapshot mirrors the restored version's fields; changeNote notes
    // the source so the user can trace what happened.
    const versionResult = await tx.execute<{ nextVersion: number }>(sql`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion"
      FROM page_versions
      WHERE page_id = ${id}
    `)
    const nextVersion = Number(versionResult.rows[0]?.nextVersion ?? 1)
    await tx.insert(pageVersions).values({
      id: generatePageId(),
      pageId: id,
      versionNumber: nextVersion,
      title: version.title,
      contentJson: version.contentJson,
      contentHtml: version.contentHtml,
      icon: version.icon,
      editedBy: me.id,
      editedAt: now,
      changeNote: `restored from v${version.versionNumber}`,
    })
    await tx
      .update(pages)
      .set({
        title: version.title,
        contentJson: version.contentJson,
        contentHtml: version.contentHtml,
        icon: version.icon,
        updatedAt: now,
      })
      .where(eq(pages.id, id))
    await tx.execute(sql`
      DELETE FROM page_versions
      WHERE page_id = ${id}
        AND version_number <= (
          SELECT MAX(version_number) FROM page_versions WHERE page_id = ${id}
        ) - ${RETENTION}
    `)
  })

  // Re-fetch via the existing pages.ts LEFT JOIN helper for author + labels.
  // Inline a small equivalent here to avoid coupling to the unexported helper.
  const labelsAgg = sql<string[]>`
    COALESCE(
      json_agg(DISTINCT ${sql.raw('pl.label')}) FILTER (WHERE ${sql.raw('pl.label')} IS NOT NULL),
      '[]'::json
    )
  `.as('labels')
  // Mirror selectPagesWithAuthor's hasChildren EXISTS so the restored PageNode
  // matches the list/get response shape (Sidebar caret display depends on it).
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
    .leftJoin(users, eq(users.id, pages.authorId))
    .leftJoin(sql`page_labels pl`, sql`pl.page_id = ${pages.id}`)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .groupBy(pages.id, users.name, users.color)
  const row = rows[0]
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageNodeSchema.parse(rowToPageNode(row as Parameters<typeof rowToPageNode>[0])))
})