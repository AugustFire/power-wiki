/**
 * Row → PageNode mapping (snake_case DB → camelCase API).
 *
 * Kept tiny and pure so it's trivial to unit-test later if needed.
 *
 * Stage 4: `spaceId` is required on the API contract. The DB column is nullable
 * to keep the migration safe, but every code path that returns a page to the
 * client MUST have already passed through the bootstrap backfill OR the POST
 * handler that requires spaceId. If we see a null here, the bootstrap hasn't
 * run for this row — surface it loudly instead of silently returning a
 * space-less page that would then 500 in the frontend.
 *
 * Author info is denormalized via LEFT JOIN users. The caller passes a row
 * that already carries `authorName` / `authorColor` columns (see
 * `pagesWithAuthorSelect()` in pages.ts) — both nullable when the page's
 * authorId doesn't match a real user (legacy 'me' seed or a deleted user).
 *
 * Stage 8: `labels` is also denormalized via a LEFT JOIN + json_agg in
 * `pages.ts`. The mapper accepts the joined array (always present; [] when
 * the page has no labels or when the caller didn't bother to join).
 *
 * Page likes: `likesCount` (always present on joined rows; `0` default) +
 * `likedByMe` (false default) come from correlated subqueries in
 * `selectPagesWithAuthor`. Hand-undefined in fallback paths so callers that
 * skip the JOIN still produce a valid DTO.
 */

import type { PageNode } from '@power-wiki/shared'
import type { PageRow } from '../db/schema'

export type PageRowWithAuthor = PageRow & {
  authorName: string | null
  authorColor: string | null
  /** 最后编辑者姓名,LEFT JOIN users 填充;updated_by 为空或用户已删时为 null */
  updatedByName: string | null
  /** 最后编辑者头像色,同上 */
  updatedByColor: string | null
  /** Stage 8: labels aggregator from pages.ts LEFT JOIN.
   *  Always present on the row after the join; default [] otherwise. */
  labels: string[]
  /**
   * 服务端 EXISTS 子查询结果 —— 是否有未删除的子页面。Sidebar 用它判断是否
   * 显示 caret:懒加载模式下 children 数组为空不代表无子,不能用那个判断。
   * 任何走 selectPagesWithAuthor 的路径(GET / 和 GET /:id)都会自动计算。
   */
  hasChildren: boolean
  /** 点赞总数。Joined rows 一定有这个字段(0 / 数字),未走 join 的 fallback
   *  在 rowToPageNode 里 fallback 成 0。 */
  likesCount?: number
  /** 当前用户是否已赞。Joined rows 为 boolean(SELECT COALESCE) ,
   *  未传 viewerUserId 时返回 false。Fallback 路径给 false。 */
  likedByMe?: boolean
  /** 点赞者 sample(前 5 人) —— LEFT JOIN users 拿 name/color,user 被
   *  disabled 时 name/color 为 null。Fallback 路径给 []。 */
  likedBySample?: Array<{ id: string; name: string | null; color: string | null }>
  /** M13 👁 当前用户是否关注此页。EXISTS correlated subquery,未传
   *  viewerUserId 时 selectPagesWithAuthor 给 false。Fallback 给 false。 */
  watchedByMe?: boolean
  /** M13 👁 该页关注者总数。COUNT correlated,未走 join fallback 0。 */
  watchersCount?: number
}

export function rowToPageNode(row: PageRowWithAuthor): PageNode {
  if (row.spaceId === null) {
    throw new Error(
      `page ${row.id} has no space_id — bootstrap.ts backfill must run before the API serves pages`,
    )
  }
  const node: PageNode = {
    id: row.id,
    parentId: row.parentId,
    spaceId: row.spaceId,
    title: row.title,
    contentJSON: row.contentJson,
    contentHTML: row.contentHtml,
    order: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    authorId: row.authorId,
    authorName: row.authorName,
    authorColor: row.authorColor,
    updatedBy: row.updatedBy,
    updatedByName: row.updatedByName,
    updatedByColor: row.updatedByColor,
    labels: row.labels ?? [],
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    hasChildren: row.hasChildren,
    likesCount: row.likesCount ?? 0,
    likedByMe: row.likedByMe ?? false,
    likedBySample: row.likedBySample ?? [],
    watchedByMe: row.watchedByMe ?? false,
    watchersCount: row.watchersCount ?? 0,
  }
  if (row.icon !== null) node.icon = row.icon
  return node
}