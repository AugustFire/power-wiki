/**
 * snake_case row → camelCase entity mappers.
 *
 * Lives in `apps/api/src/lib/` next to the existing `rowToPageNode.ts`. New
 * entities (Stage 4) added here to keep mapping logic centralized.
 *
 * Why a dedicated file: each row → entity mapping has the same shape (rename
 * + optional nullable handling + default). Pulling them apart by entity keeps
 * each function < 20 lines.
 */
import type { SpaceRow, UserRow } from '../db/schema'
import type { Space, User } from '@power-wiki/shared'

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt ?? null,
    // DB CHECK 约束限定值集合为 'preset' | 'custom' | NULL,但 text()
    // 推不出 literal 联合。用窄化断言确保下游不会把任意字符串透出去
    avatarKind: (row.avatarKind ?? null) as User['avatarKind'],
    avatarRef: row.avatarRef ?? null,
  }
}

/**
 * rowToSpace — DB row → API contract. Pass `includeOwner` = true for admin
 * responses (the sidebar manager UI + /manager/spaces/:id use it to render
 * the "所有者" field); false for regular users (who don't need to know who
 * owns a space they have access to).
 */
export function rowToSpace(row: SpaceRow, opts: { includeOwner?: boolean } = {}): Space {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color,
    icon: row.icon ?? undefined,
    kind: row.kind,
    // ownerId is admin-only metadata; regular users would otherwise be able to
    // discover other users' personal space ids.
    ownerId: opts.includeOwner ? row.ownerId ?? undefined : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
