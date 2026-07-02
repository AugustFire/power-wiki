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
 */

import type { PageNode } from '@power-wiki/shared'
import type { PageRow } from '../db/schema'

export type PageRowWithAuthor = PageRow & {
  authorName: string | null
  authorColor: string | null
  /** Stage 8: labels aggregator from pages.ts LEFT JOIN.
   *  Always present on the row after the join; default [] otherwise. */
  labels: string[]
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
    starred: row.starred,
    labels: row.labels ?? [],
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
  }
  if (row.icon !== null) node.icon = row.icon
  return node
}