import { eq } from 'drizzle-orm'
import type { UpdateSpaceInput } from '@power-wiki/shared'
import { db } from '../db/client'
import { spaces, type SpaceRow } from '../db/schema'

export async function updateSpaceMetadata(
  spaceId: string,
  input: UpdateSpaceInput,
): Promise<SpaceRow | null> {
  const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: Date.now() }
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description
  if (input.color !== undefined) patch.color = input.color
  if (input.icon !== undefined) patch.icon = input.icon

  const [updated] = await db
    .update(spaces)
    .set(patch)
    .where(eq(spaces.id, spaceId))
    .returning()
  return updated ?? null
}
