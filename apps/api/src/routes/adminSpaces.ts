/**
 * Admin space routes — Stage 4c.
 *
 *   GET    /api/admin/spaces                    list all spaces + accessGroupIds
 *   POST   /api/admin/spaces                    create
 *   GET    /api/admin/spaces/:id                single space + accessGroupIds
 *   PATCH  /api/admin/spaces/:id                update name/description/color/icon
 *   DELETE /api/admin/spaces/:id                delete (refuses if pages exist OR
 *                                              if kind='personal'; audit row written)
 *   PUT    /api/admin/spaces/:id/access         replace the full set of access groups
 *
 * All routes require admin role. Non-admin users go through /api/spaces
 * (apps/api/src/routes/spaces.ts) which filters by their group memberships.
 *
 * setAccess replaces the full group set in a single transaction (delete +
 * bulk insert). The single-toggle UI uses POST/DELETE on /:id/access/:groupId
 * for optimistic per-group updates; PUT stays for batch ops.
 *
 * `pg-*` group ids are filtered out of every `accessGroupIds` response —
 * those rows are auto-created by ensurePersonalSpace() per user to bind
 * that user to their personal space. Showing them in the admin space-edit
 * UI as a "1-person auto group" entry would be noise; the binding still
 * works underneath. Frontend tabs (manager/spaces + manager/trash) filter
 * personal vs shared by `kind`, which we expose here.
 *
 * DELETE on `kind='personal'` is refused (400 `personal_space_cannot_delete`).
 * Personal spaces are bound to their owner user — deleting one would leave the
 * owner with no scratchpad and orphan their `pg-<userId>` group. To retire a
 * personal space the owner (or an admin) should archive it (future feature);
 * for now the only path to "remove" a personal space is to anonymize the user,
 * which sweeps their personal space as part of the cascade.
 */
import { Hono } from 'hono'
import { eq, inArray, sql, and, asc } from 'drizzle-orm'
import {
  CreateSpaceInputSchema,
  PaginatedListSchema,
  SetSpaceAccessInputSchema,
  SpaceSchema,
  UpdateSpaceInputSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { spaceGroupAccess, spaceRoleGrants, spaces, userGroups } from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { getSpacePageStats, getSpaceOwnerNames, type SpacePageStats } from '../lib/spaceStats'
import { loadGrantsForSpaces, type SpaceGrants } from '../lib/permissions'
import { recordPermissionAudit } from '../lib/auditLog'
import type { Space } from '@power-wiki/shared'
import type { SpaceRow } from '../db/schema'

export const adminSpacesRouter = new Hono<{ Variables: Variables }>()

adminSpacesRouter.use('*', requireAdmin)

/* ─── helpers ─────────────────────────────────────────────────────────── */

function rowToSpace(row: SpaceRow, accessGroupIds: string[] = []): Space {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color,
    icon: row.icon ?? undefined,
    kind: row.kind,
    ownerId: row.ownerId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accessGroupIds: accessGroupIds.filter((g) => !g.startsWith('pg-')),
  }
}

/** Compose row + access + page-stats into the final DTO.
 *  `ownerNameMap` is optional — only the admin path passes it (personal
 *  spaces only). Shared spaces never get an `ownerName` field.
 *  `grantsMap` is optional — Phase A: only the admin list path passes it so
 *  the manager UI can show the structured role grants inline. */
function attachStats(
  space: Space,
  stats: SpacePageStats | undefined,
  ownerNameMap?: Map<string, string>,
  grantsMap?: Map<string, SpaceGrants>,
): Space {
  const ownerName = ownerNameMap?.get(space.id)
  return {
    ...space,
    pageCount: stats?.pageCount ?? 0,
    childPageCount: stats?.childPageCount ?? 0,
    lastPageUpdatedAt: stats?.lastPageUpdatedAt ?? null,
    ...(ownerName ? { ownerName } : {}),
    ...(grantsMap ? { accessGrants: grantsMap.get(space.id) ?? { groups: [], users: [] } } : {}),
  }
}

async function getAccessGroupIds(spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: spaceGroupAccess.groupId })
    .from(spaceGroupAccess)
    .where(eq(spaceGroupAccess.spaceId, spaceId))
  return rows.map((r) => r.groupId)
}

/** Count pages in a space — used by GET single + admin list. */
async function countPagesInSpace(spaceId: string): Promise<number> {
  const result = await db.execute<{ count: number }>(
    sql`SELECT COUNT(*)::int AS count FROM pages WHERE space_id = ${spaceId}`,
  )
  return result.rows[0]?.count ?? 0
}

/* ─── GET /api/admin/spaces ───────────────────────────────────────────── */
adminSpacesRouter.get('/', async (c) => {
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args
  // Stable order by creation time so the manager list (and the topbar
  // SpaceSwitcher dropdown) doesn't shuffle between refreshes — Postgres
  // doesn't guarantee an implicit order for a plain SELECT, and nanoid
  // primary keys are random so the default order is meaningless.
  let q = db.select().from(spaces).orderBy(asc(spaces.createdAt)).$dynamic()
  if (limit !== undefined) q = q.limit(limit + 1).offset(offset)
  const rows = await q
  // Pull all access mappings in one query to avoid N+1.
  const accessRows = await db
    .select({ spaceId: spaceGroupAccess.spaceId, groupId: spaceGroupAccess.groupId })
    .from(spaceGroupAccess)
  const accessBySpace = new Map<string, string[]>()
  for (const r of accessRows) {
    const list = accessBySpace.get(r.spaceId) ?? []
    list.push(r.groupId)
    accessBySpace.set(r.spaceId, list)
  }
  // Per-space page stats in one GROUP BY query — replaces the N+1 the
  // SpacesView would otherwise pay (one pages.list call per space card).
  const statsBySpace = await getSpacePageStats(rows.map((r) => r.id))
  // Owner names for personal spaces — one LEFT JOIN, only the personal rows
  // are looked up. Avoids the manager UI firing N `users/:id` per row.
  const ownerNameBySpace = await getSpaceOwnerNames(rows.map((r) => r.id))
  // Phase A: structured role grants (groups + users + role), batched so we
  // don't pay an N+1 vs the per-row approach. Admin-only path; non-admin
  // requests go through /api/spaces instead.
  const grantsBySpace = await loadGrantsForSpaces(rows.map((r) => r.id))
  const items = rows.map((r) =>
    attachStats(
      rowToSpace(r, accessBySpace.get(r.id) ?? []),
      statsBySpace.get(r.id),
      ownerNameBySpace,
      grantsBySpace,
    ),
  )
  const result = applyPagination(items, limit, offset)
  return c.json(PaginatedListSchema(SpaceSchema).parse(result))
})

/* ─── POST /api/admin/spaces ──────────────────────────────────────────── */
adminSpacesRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateSpaceInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const id = generatePageId()
  const now = Date.now()
  await db.insert(spaces).values({
    id,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    color: parsed.data.color ?? '#0052CC',
    icon: parsed.data.icon ?? null,
    createdAt: now,
    updatedAt: now,
  })
  const created = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  // New space → no pages yet, skip the aggregate query.
  return c.json(attachStats(rowToSpace(created), undefined), 201)
})

/* ─── GET /api/admin/spaces/:id ───────────────────────────────────────── */
adminSpacesRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]
  if (!row) return c.json({ error: 'not_found' }, 404)
  const accessGroupIds = await getAccessGroupIds(id)
  const statsBySpace = await getSpacePageStats([id])
  const ownerNameBySpace = await getSpaceOwnerNames([id])
  // Phase A: 单 space 也带 accessGrants,与 list 路径行为一致。
  const grantsBySpace = await loadGrantsForSpaces([id])
  return c.json(
    attachStats(
      rowToSpace(row, accessGroupIds),
      statsBySpace.get(id),
      ownerNameBySpace,
      grantsBySpace,
    ),
  )
})

/* ─── PATCH /api/admin/spaces/:id ─────────────────────────────────────── */
adminSpacesRouter.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateSpaceInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'invalid_input', message: '至少需要更新一个字段' }, 400)
  }
  const existing = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: Date.now() }
  if (parsed.data.name !== undefined) patch.name = parsed.data.name
  if (parsed.data.description !== undefined) patch.description = parsed.data.description ?? null
  if (parsed.data.color !== undefined) patch.color = parsed.data.color
  if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon ?? null

  await db.update(spaces).set(patch).where(eq(spaces.id, id))
  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  const accessGroupIds = await getAccessGroupIds(id)
  const statsBySpace = await getSpacePageStats([id])
  const ownerNameBySpace = await getSpaceOwnerNames([id])
  return c.json(
    attachStats(
      rowToSpace(updated, accessGroupIds),
      statsBySpace.get(id),
      ownerNameBySpace,
    ),
  )
})

/* ─── DELETE /api/admin/spaces/:id ────────────────────────────────────── */
// Refuses if the space has any pages (409 space_not_empty) or is a personal
// space (400 personal_space_cannot_delete — see route header). Cascade
// delete would silently drop the entire subtree, which is the kind of action
// that should require an extra confirmation in the UI rather than be
// triggered by accident.
adminSpacesRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const existing = (
    await db
      .select({ id: spaces.id, name: spaces.name, kind: spaces.kind })
      .from(spaces)
      .where(eq(spaces.id, id))
      .limit(1)
  )[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  // Personal spaces are owner-bound; deleting one orphans the owner's pg-*
  // group and leaves them with no scratchpad. The only legitimate path to
  // remove a personal space is via user anonymization (Phase 3), which
  // sweeps the personal space + group + role grants in one cascade.
  if (existing.kind === 'personal') {
    return c.json(
      {
        error: 'personal_space_cannot_delete',
        message: '个人空间不能直接删除。请改用「匿名化该用户」清理。',
      },
      400,
    )
  }

  const pageCount = await countPagesInSpace(id)
  if (pageCount > 0) {
    return c.json(
      {
        error: 'space_not_empty',
        message: `该空间下还有 ${pageCount} 个页面,请先删除或移动这些页面`,
        pageCount,
      },
      409,
    )
  }
  // No FK CASCADE — sweep the access join tables explicitly so we don't
  // leave rows pointing at a deleted space. Phase A adds the
  // space_role_grants sweep alongside the legacy space_group_access one.
  // Audit row written in the same transaction so it rolls back together
  // with the delete (Phase C invariant: tx rollback ⇒ no audit pollution).
  await db.transaction(async (tx) => {
    await tx.delete(spaceGroupAccess).where(eq(spaceGroupAccess.spaceId, id))
    await tx.delete(spaceRoleGrants).where(eq(spaceRoleGrants.spaceId, id))
    await tx.delete(spaces).where(eq(spaces.id, id))
    await recordPermissionAudit(tx, {
      kind: 'space_deleted',
      actorId: me.id,
      targetKind: 'space',
      targetId: id,
      payload: { before: { id, name: existing.name, kind: existing.kind } },
    })
  })
  return c.body(null, 204)
})

/* ─── PUT /api/admin/spaces/:id/access ────────────────────────────────── */
/**
 * @deprecated Phase A.5 起停止写入。改用 `PUT /api/spaces/:id/permissions`
 * (`apps/api/src/routes/spacePermissions.ts`)。此端点保留作为 rollback 安全网,
 * 不再有前端调用 —— 命中时 `console.warn` 报警,便于追查残留脚本 / 测试桩。
 */
// Replaces the full set of access groups in a single transaction.
adminSpacesRouter.put('/:id/access', async (c) => {
  console.warn('[adminSpaces] legacy PUT /:id/access hit — migrate caller to /api/spaces/:id/permissions')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = SetSpaceAccessInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { groupIds } = parsed.data

  const existing = (await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, id)).limit(1))[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)

  // Validate all groupIds exist — prevents dangling FKs.
  if (groupIds.length > 0) {
    const found = await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(inArray(userGroups.id, groupIds))
    if (found.length !== groupIds.length) {
      const foundSet = new Set(found.map((r) => r.id))
      const missing = groupIds.filter((g) => !foundSet.has(g))
      return c.json(
        { error: 'invalid_input', message: '用户组不存在', missingGroupIds: missing },
        400,
      )
    }
  }

  // Replace in two statements: delete old, insert new. Wrap in a transaction
  // so a partial failure doesn't leave the space with empty access.
  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx.delete(spaceGroupAccess).where(eq(spaceGroupAccess.spaceId, id))
    if (groupIds.length > 0) {
      await tx.insert(spaceGroupAccess).values(
        groupIds.map((groupId) => ({ spaceId: id, groupId, grantedAt: now })),
      )
    }
    await tx.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, id))
  })

  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  const statsBySpace = await getSpacePageStats([id])
  const ownerNameBySpace = await getSpaceOwnerNames([id])
  return c.json(
    attachStats(
      rowToSpace(updated, groupIds),
      statsBySpace.get(id),
      ownerNameBySpace,
    ),
  )
})

/* ─── POST /api/admin/spaces/:id/access/:groupId ──────────────────────── */
/**
 * @deprecated Phase A.5 起停止写入。改用 `POST /api/spaces/:id/permissions/groups/:groupId`。
 * 此端点保留作为 rollback 安全网,命中时 `console.warn` 报警。
 */
// Grants a single group access to the space. Idempotent — re-adding an
// already-authorized group is a no-op (returns 200, not 409) so the frontend
// can fire-and-forget without tracking prior state.
adminSpacesRouter.post('/:id/access/:groupId', async (c) => {
  console.warn('[adminSpaces] legacy POST /:id/access/:groupId hit — migrate caller to /api/spaces/:id/permissions/groups/:groupId')
  const id = c.req.param('id')
  const groupId = c.req.param('groupId')

  const [space] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, id))
    .limit(1)
  if (!space) return c.json({ error: 'not_found' }, 404)

  const [group] = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(eq(userGroups.id, groupId))
    .limit(1)
  if (!group) {
    return c.json({ error: 'invalid_input', message: '用户组不存在' }, 400)
  }

  const now = Date.now()
  // ON CONFLICT DO NOTHING keeps this idempotent — the frontend doesn't have
  // to track prior membership, and a stale tab clicking again is harmless.
  await db
    .insert(spaceGroupAccess)
    .values({ spaceId: id, groupId, grantedAt: now })
    .onConflictDoNothing()
  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, id))

  const accessGroupIds = await getAccessGroupIds(id)
  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  const statsBySpace = await getSpacePageStats([id])
  const ownerNameBySpace = await getSpaceOwnerNames([id])
  return c.json(
    attachStats(
      rowToSpace(updated, accessGroupIds),
      statsBySpace.get(id),
      ownerNameBySpace,
    ),
  )
})

/* ─── DELETE /api/admin/spaces/:id/access/:groupId ───────────────────── */
/**
 * @deprecated Phase A.5 起停止写入。改用 `DELETE /api/spaces/:id/permissions/groups/:groupId`。
 * 此端点保留作为 rollback 安全网,命中时 `console.warn` 报警。
 */
// Revokes a single group's access. Idempotent — removing an already-unauthorized
// group returns 200 with the current set, not 404.
adminSpacesRouter.delete('/:id/access/:groupId', async (c) => {
  console.warn('[adminSpaces] legacy DELETE /:id/access/:groupId hit — migrate caller to /api/spaces/:id/permissions/groups/:groupId')
  const id = c.req.param('id')
  const groupId = c.req.param('groupId')

  const [space] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, id))
    .limit(1)
  if (!space) return c.json({ error: 'not_found' }, 404)

  const now = Date.now()
  await db
    .delete(spaceGroupAccess)
    .where(
      and(eq(spaceGroupAccess.spaceId, id), eq(spaceGroupAccess.groupId, groupId)),
    )
  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, id))

  const accessGroupIds = await getAccessGroupIds(id)
  const updated = (await db.select().from(spaces).where(eq(spaces.id, id)).limit(1))[0]!
  const statsBySpace = await getSpacePageStats([id])
  const ownerNameBySpace = await getSpaceOwnerNames([id])
  return c.json(
    attachStats(
      rowToSpace(updated, accessGroupIds),
      statsBySpace.get(id),
      ownerNameBySpace,
    ),
  )
})

// Re-export for tests / introspection.
export { countPagesInSpace, getAccessGroupIds }
