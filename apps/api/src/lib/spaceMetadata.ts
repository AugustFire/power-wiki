import { and, eq, isNull } from 'drizzle-orm'
import type { UpdateSpaceInput } from '@power-wiki/shared'
import { db } from '../db/client'
import { pages, spaces, type SpaceRow } from '../db/schema'

export async function updateSpaceMetadata(
  spaceId: string,
  input: UpdateSpaceInput,
): Promise<SpaceRow | null> {
  const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: Date.now() }
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description
  if (input.color !== undefined) patch.color = input.color
  if (input.icon !== undefined) patch.icon = input.icon
  if (input.homepagePageId !== undefined) patch.homepagePageId = input.homepagePageId

  const [updated] = await db
    .update(spaces)
    .set(patch)
    .where(eq(spaces.id, spaceId))
    .returning()
  return updated ?? null
}

/**
 * Validate that a candidate homepagePageId points to a real, non-trashed
 * page in the given space. Called by PATCH /api/spaces/:id before invoking
 * updateSpaceMetadata, so we can return 400 with a precise message rather
 * than silently writing a dangling id.
 *
 * Rules (matches UpdateSpaceInputSchema.homepagePageId JSDoc):
 *   - null  → 永远合法(清空主页,`/` 恢复仪表盘)
 *   - 非 null → 该 page 必须存在,space_id = spaceId,deleted_at IS NULL
 *
 * Returns null on success, otherwise a 400 message string.
 */
export async function validateHomepageForSpace(
  spaceId: string,
  homepagePageId: string | null,
): Promise<string | null> {
  if (homepagePageId === null) return null
  const [row] = await db
    .select({ id: pages.id, spaceId: pages.spaceId })
    .from(pages)
    .where(and(eq(pages.id, homepagePageId), isNull(pages.deletedAt)))
    .limit(1)
  if (!row) {
    return '主页页面不存在或已被移入回收站'
  }
  if (row.spaceId !== spaceId) {
    return '主页页面不属于本空间'
  }
  return null
}
