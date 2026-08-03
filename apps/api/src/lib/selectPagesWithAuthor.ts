/**
 * Shared `pages` + LEFT JOIN `users` + LEFT JOIN `page_labels` query helper.
 *
 * Extracted from apps/api/src/routes/pages.ts so multiple routers (pages,
 * users `/me/watched`) can reuse the same shape without duplicating the
 * correlated subqueries for labels / hasChildren / likesCount / likedByMe /
 * likedBySample / watchedByMe / watchersCount.
 *
 * Behaviour mirrors the inline version 1:1 — keep these in sync with
 * the route handler's expectations.
 */
import { aliasedTable, and, eq, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import {
  pages,
  pageLabels,
  pageLikes,
  userWatchedPages,
  users,
} from '../db/schema'

export function selectPagesWithAuthor(
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
  const hasChildrenExpr = sql<boolean>`
    EXISTS (
      SELECT 1 FROM pages c
      WHERE c.parent_id = ${pages.id}
        AND c.deleted_at IS NULL
    )
  `.as('has_children')
  const likesCountExpr = sql<number>`
    (SELECT COUNT(*)::int
     FROM page_likes pl
     WHERE pl.page_id = ${pages.id})
  `.as('likes_count')
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
  const likedBySampleExpr = sql<Array<{ id: string; name: string | null; color: string | null; avatarKind?: string | null; avatarRef?: string | null }>>`
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', u.id,
            'name', u.name,
            'color', u.color,
            'avatarKind', u.avatar_kind,
            'avatarRef', u.avatar_ref
          )
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
  // M13 👁 visibility — 跟 page_likes 完全对齐的 EXISTS/COUNT 模式:
  //   - watchedByMe:当前用户是否关注了该页(EXISTS)
  //   - watchersCount:该页被多少用户关注(COUNT)
  // 索引都已经在 user_watched_pages 表上建好:
  //   - user_watched_user_idx(user_id) → watchedByMe 用 EXISTS 走 PK
  //   - user_watched_page_idx(page_id) → watchersCount COUNT 命中索引
  const watchedByMeExpr = opts.viewerUserId != null
    ? sql<boolean>`
        COALESCE(
          EXISTS (
            SELECT 1 FROM user_watched_pages wp
            WHERE wp.page_id = ${pages.id}
              AND wp.user_id = ${opts.viewerUserId}
          ),
          false
        )
      `.as('watched_by_me')
    : sql<boolean>`false`.as('watched_by_me')
  const watchersCountExpr = sql<number>`
    (SELECT COUNT(*)::int
     FROM user_watched_pages wp
     WHERE wp.page_id = ${pages.id})
  `.as('watchers_count')
  // B-3 (2026-08-03):hasViewRestriction / hasEditRestriction 由服务端
  // EXISTS 子查询填充 —— 之前 schema 注释承诺但代码没实现,导致 Sidebar
  // / 列表 UI 永远看不到「受限」chip。两条 EXISTS 各自走 page_restrictions_page_idx
  // (page_id, kind),独立 index seek,不增加额外 JOIN。
  const hasViewRestrictionExpr = sql<boolean>`
    EXISTS (
      SELECT 1 FROM page_restrictions pr
      WHERE pr.page_id = ${pages.id} AND pr.kind = 'view'
    )
  `.as('has_view_restriction')
  const hasEditRestrictionExpr = sql<boolean>`
    EXISTS (
      SELECT 1 FROM page_restrictions pr
      WHERE pr.page_id = ${pages.id} AND pr.kind = 'edit'
    )
  `.as('has_edit_restriction')
  const editorUsers = aliasedTable(users, 'editor_users')
  const q = db
    .select({
      ...getTableColumns(pages),
      authorName: users.name,
      authorColor: users.color,
      authorAvatarKind: users.avatarKind,
      authorAvatarRef: users.avatarRef,
      updatedByName: editorUsers.name,
      updatedByColor: editorUsers.color,
      updatedByAvatarKind: editorUsers.avatarKind,
      updatedByAvatarRef: editorUsers.avatarRef,
      labels: labelsAgg,
      hasChildren: hasChildrenExpr,
      likesCount: likesCountExpr,
      likedByMe: likedByMeExpr,
      likedBySample: likedBySampleExpr,
      watchedByMe: watchedByMeExpr,
      watchersCount: watchersCountExpr,
      hasViewRestriction: hasViewRestrictionExpr,
      hasEditRestriction: hasEditRestrictionExpr,
    })
    .from(pages)
    .leftJoin(users, eq(pages.authorId, users.id))
    .leftJoin(editorUsers, eq(pages.updatedBy, editorUsers.id))
    .leftJoin(pageLabels, eq(pageLabels.pageId, pages.id))
    .groupBy(
      pages.id,
      users.name,
      users.color,
      users.avatarKind,
      users.avatarRef,
      editorUsers.name,
      editorUsers.color,
      editorUsers.avatarKind,
      editorUsers.avatarRef,
    )
  const filters: SQL[] = []
  if (!opts.includeDeleted) filters.push(isNull(pages.deletedAt))
  if (where) filters.push(where)
  return filters.length ? q.where(and(...filters)) : q
}
