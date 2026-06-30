/**
 * Resolve the @-mention candidates for a given page.
 *
 * Hard requirement (from the user prompt):
 *   Comment / @-mention recipients MUST be scoped to users who have access
 *   to the page's space — NOT the entire workspace user list.
 *
 * Algorithm:
 *   pages → spaces (via page.spaceId)
 *        → space_group_access (groups granted on that space)
 *        → user_group_members (members of those groups)
 *        → users (filter to status='active', reject the requester)
 *
 * Single round-trip via raw SQL using the same idiom as
 * `accessibleSpaceIds.ts`. We deliberately do NOT use drizzle's join
 * chain because DISTINCT ON + name ILIKE + LIMIT is verbose and the
 * query is single-purpose here.
 *
 * `pg-*` (personal-space groups) are valid access routes — the personal
 * space's owner is the only member, so they naturally surface as the
 * candidate when commenting in their own personal page. The frontend
 * composer then strips `actor.id === self` from the visible list.
 *
 * Caller is expected to have verified visibility on the page BEFORE
 * calling this function (404 if not); we don't re-check here to keep
 * the SQL side cheap and the predicate local to the route.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client'

export interface MentionCandidateRow {
  id: string
  name: string
  color: string
  email: string
}

export async function getMentionCandidates(
  pageId: string,
  excludeUserId: string,
  query = '',
  limit = 30,
): Promise<MentionCandidateRow[]> {
  const trimmedQuery = query.trim()
  const ilike = trimmedQuery.length > 0 ? sql`AND u.name ILIKE ${'%' + trimmedQuery + '%'}` : sql``
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))

  // Inline row-shape type — `db.execute<T>` requires T extends
  // `Record<string, unknown>`, which a named interface doesn't satisfy
  // (Drizzle's generic is fine with inline literal types).
  const result = await db.execute<{
    id: string
    name: string
    color: string
    email: string
  }>(sql`
    SELECT DISTINCT ON (u.id)
      u.id,
      u.name,
      u.color,
      u.email
    FROM users u
    JOIN user_group_members ugm ON ugm.user_id = u.id
    JOIN space_group_access sga ON sga.group_id = ugm.group_id
    JOIN pages p ON p.id = ${pageId}
    WHERE sga.space_id = p.space_id
      AND u.status = 'active'
      AND u.id <> ${excludeUserId}
      ${ilike}
    ORDER BY u.id, u.name ASC
    LIMIT ${safeLimit}
  `)

  // DISTINCT ON with ORDER BY u.id → rows come back grouped by id but
  // not necessarily alpha. Re-sort by name (≤ limit rows, in-memory cheap).
  return result.rows
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
}
