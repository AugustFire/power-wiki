/**
 * Per-space page statistics — one round-trip for the whole list.
 *
 * Used by GET /api/spaces and /api/admin/spaces (list + single) so the
 * frontend can render space cards (page count, child count, last update)
 * without firing N requests for "pages?space=<id>".
 *
 * Single SQL: GROUP BY space_id aggregates every non-trashed page in the DB
 * once. We then look up by id on the caller side. This is O(K) CPU where
 * K = distinct space count on the page, instead of O(K) network round-trips.
 *
 * Hard rule: schema has no FKs (see CLAUDE.md), so the join is implicit by
 * `WHERE space_id IN (...)`. Soft-deleted rows (deleted_at IS NOT NULL) are
 * excluded so a space's "page count" reflects the live tree, not the trash.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { pages, spaces, users } from '../db/schema'

export interface SpacePageStats {
  /** Total non-trashed pages in the space. */
  pageCount: number
  /** Non-trashed pages with a non-null parent_id. */
  childPageCount: number
  /** MAX(updated_at) over non-trashed pages in the space; null = space has no pages. */
  lastPageUpdatedAt: number | null
}

/**
 * 归档人冗余信息(P1-1 归档 banner「由 张三 归档」所需)。
 *
 * 跟 ownerName 同款 batch pattern:一个 round-trip 拉完全部归档空间的
 * 归档人 + 头像字段,前端 DTO 直接嵌入。LEFT JOIN users —— 已 anonymize
 * / 已删用户的归档行 name = null,UI 兜底「?」/「已匿名用户」(跟 audit
 * log 的 actor 渲染一致)。
 *
 * 字段对齐 feedback_denorm_user_embed_avatar.md:name + color + avatar
 * 三件套(M11 起 user DTO 全量贯通 avatar fields),archivedBy* 同款语义。
 *
 * 未归档空间不进 map —— caller `archivedByName` 字段直接 undefined,跟
 * archivedAt 同步表达「未归档」。
 */
export interface ArchivedByUser {
  name: string | null
  color: string | null
  avatarKind: 'preset' | 'custom' | null
  avatarRef: string | null
}

export type ArchivedByUserBySpaceId = Map<string, ArchivedByUser>

/** Map keyed by `spaceId`. Spaces with no pages are not in the map. */
export type SpacePageStatsById = Map<string, SpacePageStats>

/**
 * Aggregate stats for a fixed set of space ids in one query.
 *
 * Returns an empty map early when `spaceIds` is empty so the common
 * "no access" path doesn't pay an extra DB round-trip.
 */
export async function getSpacePageStats(
  spaceIds: string[],
): Promise<SpacePageStatsById> {
  if (spaceIds.length === 0) return new Map()
  const rows = await db
    .select({
      spaceId: pages.spaceId,
      pageCount: sql<number>`COUNT(*)::int`,
      childCount: sql<number>`COUNT(*) FILTER (WHERE ${pages.parentId} IS NOT NULL)::int`,
      lastPageUpdatedAt: sql<number | null>`MAX(${pages.updatedAt})`,
    })
    .from(pages)
    .where(and(inArray(pages.spaceId, spaceIds), isNull(pages.deletedAt)))
    .groupBy(pages.spaceId)
  const out: SpacePageStatsById = new Map()
  for (const r of rows) {
    // spaceId is the GROUP BY key — rows here always have a non-null value.
    // Drizzle types it as `string | null` because the column allows null at
    // the table level, but a NULL space_id wouldn't survive GROUP BY.
    if (r.spaceId == null) continue
    out.set(r.spaceId, {
      pageCount: r.pageCount,
      childPageCount: r.childCount,
      lastPageUpdatedAt: r.lastPageUpdatedAt != null ? Number(r.lastPageUpdatedAt) : null,
    })
  }
  return out
}

/**
 * Owner display names for personal spaces — one round-trip for the whole list.
 *
 * Only entries with `kind = 'personal'` AND a non-null `owner_id` get looked
 * up. Returns a map keyed by `spaceId`. Shared spaces are intentionally not
 * in the map (caller can `?? undefined`).
 *
 * Hard rule: schema has no FKs, so the join is `WHERE spaces.id IN (...)
 * AND kind = 'personal' LEFT JOIN users ON users.id = owner_id`. The LEFT
 * JOIN means a deleted owner yields a NULL name (caller omits `ownerName`
 * in that case rather than shipping a stale id).
 */
export async function getSpaceOwnerNames(
  spaceIds: string[],
): Promise<Map<string, string>> {
  if (spaceIds.length === 0) return new Map()
  const rows = await db
    .select({
      spaceId: spaces.id,
      ownerName: users.name,
    })
    .from(spaces)
    .leftJoin(users, eq(users.id, spaces.ownerId))
    .where(
      and(
        inArray(spaces.id, spaceIds),
        eq(spaces.kind, 'personal'),
        isNotNull(spaces.ownerId),
      ),
    )
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.ownerName != null) out.set(r.spaceId, r.ownerName)
  }
  return out
}

/**
 * Batch lookup of archived-by user info for a fixed set of space ids.
 *
 * Only archived spaces (`archived_at IS NOT NULL` AND `archived_by_user_id IS NOT NULL`)
 * are joined — unarchived spaces are intentionally absent from the returned map
 * so the caller can rely on `archivedByName === undefined` to mean "not archived".
 *
 * Same LEFT JOIN pattern as `getSpaceOwnerNames`: anonymized / deleted archivers
 * surface as null name/color/avatar fields; the UI falls back to "?" / "已匿名用户".
 */
export async function getArchivedByUserInfo(
  spaceIds: string[],
): Promise<ArchivedByUserBySpaceId> {
  if (spaceIds.length === 0) return new Map()
  const rows = await db
    .select({
      spaceId: spaces.id,
      name: users.name,
      color: users.color,
      avatarKind: users.avatarKind,
      avatarRef: users.avatarRef,
    })
    .from(spaces)
    .leftJoin(users, eq(users.id, spaces.archivedByUserId))
    .where(
      and(
        inArray(spaces.id, spaceIds),
        isNotNull(spaces.archivedAt),
        isNotNull(spaces.archivedByUserId),
      ),
    )
  const out: ArchivedByUserBySpaceId = new Map()
  for (const r of rows) {
    if (r.spaceId == null) continue
    out.set(r.spaceId, {
      name: r.name ?? null,
      color: r.color ?? null,
      avatarKind: (r.avatarKind ?? null) as 'preset' | 'custom' | null,
      avatarRef: r.avatarRef ?? null,
    })
  }
  return out
}
