/**
 * ID generation utilities + cycle check for `movePage`.
 *
 * - `isDescendantOrSelf`: returns true if `targetId` is `candidateAncestorId` itself
 *   or any of its descendants (walking DOWN the tree from candidateAncestorId).
 *   Why "down": when moving page `id` to be a child of `newParentId`, we must reject
 *   the move if `newParentId` is in the subtree rooted at `id`. So `targetId = newParentId`,
 *   `candidateAncestorId = id`, and we walk down from `id` looking for `newParentId`.
 *   `newParentId = null` (move to top level) is filtered out by the caller.
 *
 * - `generateSessionId`: 32-char nanoid used as the opaque session token (also stored
 *   in the HTTP-only cookie). 32 chars gives ~190 bits of entropy — overkill for a
 *   cookie that gets rotated frequently but cheap enough to not worry about.
 */
import { customAlphabet } from 'nanoid'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'

const PAGE_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // 31 chars — matches apps/web/src/lib/id.ts
const newPageId = customAlphabet(PAGE_ID_ALPHABET, 10)

const SESSION_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const newSessionId = customAlphabet(SESSION_ID_ALPHABET, 32)

/** 10-char page id, same alphabet as the frontend's `newId()` */
export function generatePageId(): string {
  return newPageId()
}

/** 32-char opaque session token */
export function generateSessionId(): string {
  return newSessionId()
}

export async function isDescendantOrSelf(targetId: string, candidateAncestorId: string): Promise<boolean> {
  if (targetId === candidateAncestorId) return true
  const rows = await db.execute<{ ok: boolean }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT id, parent_id FROM pages WHERE id = ${candidateAncestorId}
      UNION ALL
      SELECT p.id, p.parent_id FROM pages p
      INNER JOIN descendants d ON p.parent_id = d.id
    )
    SELECT EXISTS (SELECT 1 FROM descendants WHERE id = ${targetId}) AS ok
  `)
  const first = rows.rows[0]
  return first?.ok === true
}
