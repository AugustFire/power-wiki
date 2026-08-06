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
 *   - GET requires `canReadPage(me, pageId, spaceId)`. 404 (not 403)
 *     when inaccessible, to avoid leaking page id existence.
 *   - POST restore requires `canEditPage` (write path, respects page-level
 *     edit restrictions) PLUS `assertAdminNotWritingPersonalSpace`.
 *
 * Retention: keep latest 30 per page. Both the PATCH tx and the restore tx
 * trim rows after the INSERT.
 */

import { Hono } from 'hono'
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import { PageNodeSchema, PageVersionSchema, PaginatedListSchema } from '@power-wiki/shared/schemas'
import type { PageVersion } from '@power-wiki/shared'
import { db } from '../db/client'
import { pageVersions, pageYjsState, pages, spaces, users } from '../db/schema'
import { generatePageId } from '../lib/ids'
import { rowToPageNode } from '../lib/rowToPageNode'
import { canReadPage, canEditPage, principalFromUser } from '../lib/permissions'
import { assertCanWriteToPersonalSpace } from '../lib/personalSpaceGuard'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { type Variables } from '../auth/middleware'
import { assertNoActiveLockForWrite, evictCollabDocuments } from './pages'

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
  editedByAvatarKind: string | null
  editedByAvatarRef: string | null
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
    editedByAvatarKind: (row.editedByAvatarKind as PageVersion['editedByAvatarKind']) ?? null,
    editedByAvatarRef: row.editedByAvatarRef ?? null,
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
  if (!(await canReadPage(principalFromUser(me), id, page.spaceId))) {
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
      editedByAvatarKind: users.avatarKind,
      editedByAvatarRef: users.avatarRef,
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
 *
 *  M13+: 跟 DELETE 同样过 assertNoActiveLockForWrite(action='restore') 闸门
 *  —— 防止 admin 的版本回滚被 in-flight 编辑的 onStoreDocument mirror
 *  静默覆盖。具体 race:
 *    1. admin 调 restore,UPDATE pages.contentJson = 版本内容
 *    2. 1-3s 后 Alice 的 Hocuspocus onStoreDocument debounce 触发
 *    3. mirror 写 pages.contentJson = Alice 的 Y.Doc 状态 → restore 丢失
 *    4. Alice 完全不知道自己的编辑被覆盖,继续编辑 → page_yjs_state
 *       持有跟 pages.contentJson 不一致的字节
 *  修法:锁闸门挡住 restore,holder 让出锁才能继续。同时:
 *    - 事务内 DELETE page_yjs_state(让 onLoadDocument 重新从 contentJson hydrate)
 *    - 事务外 evictCollabDocuments + sendStatelessToPage page_restored
 *    - client 端 onStateless handler 接住 page_restored → reload/re-fetch
 *  三件事必须**都**做,缺一就有 race。
 */
pageVersionsRouter.post('/:id/versions/:versionId/restore', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const versionId = c.req.param('versionId')

  // Pre-check: page must exist, be accessible, and not be trashed.
  const [existing] = await db
    .select({
      id: pages.id,
      spaceId: pages.spaceId,
      authorId: pages.authorId,
      deletedAt: pages.deletedAt,
      title: pages.title,
      spaceKind: spaces.kind,
      spaceOwnerId: spaces.ownerId,
    })
    .from(pages)
    .leftJoin(spaces, eq(spaces.id, pages.spaceId))
    .where(eq(pages.id, id))
    .limit(1)
  if (!existing || existing.spaceId === null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (existing.deletedAt !== null) {
    return c.json({ error: 'page_trashed' }, 409)
  }
  if (!(await canEditPage(principalFromUser(me), existing.id, existing.spaceId, existing.authorId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const blocked = await assertCanWriteToPersonalSpace(
    c,
    me,
    existing.spaceKind ?? null,
    existing.spaceOwnerId ?? null,
  )
  if (blocked) return blocked

  // M13+: 锁闸门 —— 拒绝时推 page_locked_during_restore,跟 soft-delete
  // 共用 assertNoActiveLockForWrite(action='restore'),holder 端 usePageLock
  // 收到后挂 PageRestoringBanner。extraMessage 带 versionNumber 让 banner
  // 显示「正在尝试回滚到 v{N}」。
  //
  // 先 SELECT versionNumber(version 整行读在锁闸门过完之后),锁闸门提前拒了
  // 也能在 banner 上挂准确的版本号。锁拒时多一次 SELECT 完全可以接受 —— 这
  // 本来就是异常路径。
  const [versionHead] = await db
    .select({ versionNumber: pageVersions.versionNumber })
    .from(pageVersions)
    .where(and(eq(pageVersions.id, versionId), eq(pageVersions.pageId, id)))
    .limit(1)
  if (!versionHead) return c.json({ error: 'not_found' }, 404)

  const lockResp = await assertNoActiveLockForWrite(c, [id], me, 'restore', {
    versionNumber: versionHead.versionNumber,
  })
  if (lockResp) return lockResp

  const [version] = await db
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.id, versionId), eq(pageVersions.pageId, id)))
    .limit(1)
  if (!version) return c.json({ error: 'not_found' }, 404)
  // versionHead 已确认存在且 versionNumber 一致,这里走乐观路径 —— 如果并发
  // 删除让 version 行消失(极罕见,跟锁定不在同一语义),transaction 内 upsert
  // 仍能 throw,不影响整体。
  void versionHead

  const now = Date.now()
  let nextVersion = 1
  await db.transaction(async (tx) => {
    // Insert a new version row representing the post-restore state. The
    // snapshot mirrors the restored version's fields; changeNote notes
    // the source so the user can trace what happened.
    const versionResult = await tx.execute<{ nextVersion: number }>(sql`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion"
      FROM page_versions
      WHERE page_id = ${id}
    `)
    nextVersion = Number(versionResult.rows[0]?.nextVersion ?? 1)
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
    // M13+: 清 page_yjs_state —— restore 让 pages.contentJson 回到版本内容,
    // 但 bytea 仍然是最新 CRDT。下次 onLoadDocument 会优先选 page_yjs_state
    // (见 collab/hooks.ts),restore 就被静默 no-op 了。这里 DELETE 让下次
    // connect 走冷启动 hydration 从 pages.contentJson 重建 Y.Doc。
    await tx.delete(pageYjsState).where(eq(pageYjsState.pageId, id))
    await tx.execute(sql`
      DELETE FROM page_versions
      WHERE page_id = ${id}
        AND version_number <= (
          SELECT MAX(version_number) FROM page_versions WHERE page_id = ${id}
        ) - ${RETENTION}
    `)
  })

  // M13+: 主动 evict 服务端 Y.Doc —— Hocuspocus 是 process-level 单例,
  // 没有 internal eviction。page_yjs_state 已经被事务清掉,但 server 内存
  // 还有 in-memory Y.Doc 持有 Yjs 操作历史,client reconnect 时 Hocuspocus
  // 不会再调我们的 onLoadDocument(因为 document 已经在内存里)。evict 之后
  // 下一个 client 连进来 → 重新走 onLoadDocument → page_yjs_state 是空 →
  // 走冷启动 hydration 从 pages.contentJson(版本内容)重建。
  evictCollabDocuments([id])

  // M13+: 推 page_restored stateless —— 已连着的 client(EditView / ReadView)
  // 收不到 server 的 DELETE 路径 page_actually_deleted,但 page_yjs_state
  // 已经被清,他们的 in-memory Y.Doc 还是旧 CRDT。必须通知他们 reload:
  //   - EditView holder: 离开编辑器(自己的 in-flight 编辑已被覆盖)
  //   - EditView viewer / ReadView: 重新拉数据(UI 展示版本内容)
  const { sendStatelessToPage } = await import('../collab/stateless')
  await sendStatelessToPage(id, {
    kind: 'page_restored',
    actorId: me.id,
    pageId: id,
    versionNumber: nextVersion,
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
      authorAvatarKind: users.avatarKind,
      authorAvatarRef: users.avatarRef,
      labels: labelsAgg,
      hasChildren: hasChildrenExpr,
    })
    .from(pages)
    .leftJoin(users, eq(users.id, pages.authorId))
    .leftJoin(sql`page_labels pl`, sql`pl.page_id = ${pages.id}`)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .groupBy(pages.id, users.name, users.color, users.avatarKind, users.avatarRef)
  const row = rows[0]
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageNodeSchema.parse(rowToPageNode(row as unknown as Parameters<typeof rowToPageNode>[0])))
})