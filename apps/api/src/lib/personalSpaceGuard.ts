/**
 * Admin-on-personal-space guard.
 *
 *  Aligns with Confluence Cloud's default: admin is a *supervisor*, not an
 *  *editor*. Admins can LIST/READ personal spaces (existing role bypass in
 *  `accessibleSpaceIds.ts`), and can RESTORE/PURGE trashed pages inside them
 *  (recovery / compliance), but every other write op returns 403.
 *
 *  `assertAdminNotWritingPersonalSpace(me, targetSpaceId)` is called by the
 *  POST / PATCH / PATCH-move / DELETE-soft paths in pages.ts. It does an
 *  O(1) lookup against the spaces row — we already need that row to check
 *  accessibility, so the extra cost is negligible.
 *
 *  The `targetSpaceId` is the space the write would land in: for `POST` it's
 *  the new page's `spaceId`; for `PATCH`/`DELETE` it's the *existing* page's
 *  space; for `PATCH /:id/move` it's the destination's `newSpaceId` (or, if
 *  the move is same-space, the source's space — admin can't even *re-parent*
 *  a personal-space page within its own space, because that's still a write
 *  to the personal space).
 */
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { db } from '../db/client'
import { spaces } from '../db/schema'
import type { AuthenticatedUser } from '../auth/session'

/**
 * Returns the spaces.kind for a given spaceId, or null if the space doesn't
 * exist. One round-trip; we already have the space row for other reasons in
 * most callers, but keeping the guard self-contained means it stays easy to
 * add to new write paths.
 */
export async function getSpaceKind(spaceId: string): Promise<'personal' | 'shared' | null> {
  const [row] = await db
    .select({ kind: spaces.kind })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1)
  return row?.kind ?? null
}

/**
 * If the caller is admin AND the target space is `personal`, returns the 403
 * response body so the caller can `return c.json(...)` directly. Otherwise
 * returns null and the caller proceeds.
 *
 * The 403 code is `personal_space_readonly` to make the UX hint precise —
 * the frontend can branch on it if it wants a more specific banner than the
 * generic 403.
 */
export async function assertAdminNotWritingPersonalSpace(
  c: Context,
  me: AuthenticatedUser,
  targetSpaceId: string | null,
): Promise<Response | null> {
  if (me.role !== 'admin') return null
  if (!targetSpaceId) return null
  const kind = await getSpaceKind(targetSpaceId)
  if (kind === 'personal') {
    return c.json(
      {
        error: 'personal_space_readonly',
        message: '管理员不能直接编辑个人空间的内容',
      },
      403,
    )
  }
  return null
}
