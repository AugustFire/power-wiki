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
import type { UserRow } from '../db/schema'
import type { User } from '@power-wiki/shared'

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
  }
}
