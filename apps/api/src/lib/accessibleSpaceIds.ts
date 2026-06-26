/**
 * Compute the set of space IDs visible to a given user.
 *
 *   admin             → '*' sentinel meaning "all spaces"
 *   regular user      → space ids whose access groups intersect with the
 *                       user's group memberships
 *
 * Stage 4c introduces space-scoping: every page is in exactly one space, and
 * a user can only see pages in spaces they have access to. The query is
 * designed to be a single round-trip via JOIN:
 *
 *   SELECT DISTINCT sga.space_id
 *   FROM space_group_access sga
 *   JOIN user_group_members ugm ON sga.group_id = ugm.group_id
 *   WHERE ugm.user_id = $1
 *
 * Admin shortcut: we return '*' so the caller can short-circuit (typically
 * by skipping the WHERE clause) and the query plan stays cheap.
 *
 * Returns:
 *   - '*' for admin (caller should treat as "no filter")
 *   - string[] for regular user (possibly empty — user with no groups sees no spaces)
 *
 * The function is sync-named despite being async because it always hits the DB;
 * the name follows the call-site convention.
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { spaceGroupAccess, userGroupMembers } from '../db/schema'

export type AccessibleSpaceIdsResult = '*' | string[]

export async function getAccessibleSpaceIds(
  userId: string,
  isAdmin: boolean,
): Promise<AccessibleSpaceIdsResult> {
  if (isAdmin) return '*'

  // For a non-admin, query the join directly. Empty result → user sees no spaces.
  // We use raw SQL because drizzle's join + select distinct is verbose and the
  // query is single-purpose.
  const result = await db.execute<{ spaceId: string }>(sql`
    SELECT DISTINCT sga.space_id AS "spaceId"
    FROM space_group_access sga
    JOIN user_group_members ugm ON sga.group_id = ugm.group_id
    WHERE ugm.user_id = ${userId}
  `)
  return result.rows.map((r) => r.spaceId)
}

/**
 * Predicate: does the user have access to this specific space?
 * Used by routes/pages.ts to gate single-page operations (GET by id, PATCH, DELETE, MOVE).
 *
 * Admins always have access. Regular users must have at least one group that
 * is granted access to the space. We use a simpler query than the bulk one —
 * existence check, not a list.
 */
export async function canAccessSpace(
  userId: string,
  isAdmin: boolean,
  spaceId: string,
): Promise<boolean> {
  if (isAdmin) return true
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1
      FROM space_group_access sga
      JOIN user_group_members ugm ON sga.group_id = ugm.group_id
      WHERE sga.space_id = ${spaceId} AND ugm.user_id = ${userId}
    ) AS exists
  `)
  return result.rows[0]?.exists === true
}
