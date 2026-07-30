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
  AdminSpacesListResponseSchema,
  SetSpaceAccessInputSchema,
  UpdateSpaceInputSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { spaceGroupAccess, spaceRoleGrants, spaces, userGroups } from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { getSpacePageStats, getSpaceOwnerNames, type SpacePageStats } from '../lib/spaceStats'
import { updateSpaceMetadata, validateHomepageForSpace } from '../lib/spaceMetadata'
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
    // P1-1: admin 路径透传归档字段(同 rowToUser 等价策略)。
    archivedAt:
      typeof row.archivedAt === 'string' ? Number(row.archivedAt) : row.archivedAt ?? null,
    archivedByUserId: row.archivedByUserId ?? undefined,
    // 主页字段:admin / 非 admin 都返回(决定 `/` 渲染路径)。
    homepagePageId: row.homepagePageId ?? null,
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
  const { limit, offset, kind } = parsed.args
  // Stable order by creation time so the manager list (and the topbar
  // SpaceSwitcher dropdown) doesn't shuffle between refreshes — Postgres
  // doesn't guarantee an implicit order for a plain SELECT, and nanoid
  // primary keys are random so the default order is meaningless.
  let q = db.select().from(spaces).orderBy(asc(spaces.createdAt)).$dynamic()
  // P1-1: `?kind=shared|personal` 过滤 —— 让前端 tab 维度的分页对齐。
  // 不传 = 全量(向后兼容 stores / 单次拉全的脚本)。
  // kind 维度的分页必须对齐 tab,否则 limit=50 拿到 48 personal + 2 shared,
  // 第 3 个 shared 会被切掉,前端 tab 永远显示不全。
  if (kind === 'shared' || kind === 'personal') {
    q = q.where(eq(spaces.kind, kind))
  }
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
  const kindCountRows = await db
    .select({
      kind: spaces.kind,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(spaces)
    .groupBy(spaces.kind)
  const kindCounts = { shared: 0, personal: 0 }
  for (const row of kindCountRows) {
    if (row.kind === 'shared' || row.kind === 'personal') {
      kindCounts[row.kind] = row.count
    }
  }
  return c.json(AdminSpacesListResponseSchema.parse({ ...result, kindCounts }))
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
  // P0-3: admin 重命名 / 改描述 / 改图标 personal space 等同于改 owner 的
  // 个人内容,与 personal-space read-only 矩阵冲突。与 user-scope
  // spaces.ts:198 的 kind !== 'shared' 短路对齐,直接 404 让 admin UI 也走
  // 「该空间不可编辑」分支,而不是落库后 owner 在自己页面看到名字被改。
  const existing = (
    await db.select({ kind: spaces.kind }).from(spaces).where(eq(spaces.id, id)).limit(1)
  )[0]
  if (!existing || existing.kind === 'personal') {
    return c.json({ error: 'not_found' }, 404)
  }
  // homepagePageId 必须在 updateSpaceMetadata 之前校验 —— 目标 page
  // 必须存在 + 属于本 space + 未被 soft-delete。校验失败返 400。
  // 顺序在 404 gate 之后:空间不存在 / personal 时不该先漏一条主页相关的
  // 400,那会泄漏「这个 id 是个 space」。
  if (parsed.data.homepagePageId !== undefined) {
    const homepageError = await validateHomepageForSpace(id, parsed.data.homepagePageId)
    if (homepageError) {
      return c.json({ error: 'invalid_input', message: homepageError }, 400)
    }
  }
  const updated = await updateSpaceMetadata(id, parsed.data)
  if (!updated) return c.json({ error: 'not_found' }, 404)
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
        message: '个人空间不能直接删除。请改用「注销该用户」清理。',
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

/* ─── POST /api/admin/spaces/:id/archive ────────────────────────────────
 * P1-1: 空间归档(team space 生命周期中间态)。
 *
 *   - 拒绝 personal space(矩阵:个人空间走 owner anonymize 路径,不属于归档
 *     语义;DB CHECK spaces_archived_kind_check 已经强制,这里再前置一次返回
 *     清晰 400 而不是裸 5xx CHECK 违例)。
 *   - 拒绝已经归档(idempotent 走 archived_at IS NOT NULL 早返,audit 不写
 *     —— 已归档再发"归档"是 noop,不该污染审计)。
 *   - 同事务写 permission_audit(kind='space_archived')。
 *
 * 归档后:
 *   - canEditSpace 在 archived 时返 false(见 permissions.ts)→ 自动拦截所有
 *     page-side 写路径;
 *   - GET /api/spaces 非 admin 路径过滤 archived(main switcher 自动隐藏);
 *   - page-side 读不受影响(成员走直接 page URL 仍能访问)。
 *
 * Admin 写权限:由 router 上游 `requireAdmin` middleware 守住 —— archive 是
 * 元数据变更,任何人(包括空间 admin)都不能自己归档自己的空间(避免一个空间
 * admin 离职/误操作把 team space 隐了,影响其他成员)。只有全局 admin 才允许
 * 这个动作。
 */
adminSpacesRouter.post('/:id/archive', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const existing = (
    await db
      .select({
        id: spaces.id,
        name: spaces.name,
        kind: spaces.kind,
        archivedAt: spaces.archivedAt,
      })
      .from(spaces)
      .where(eq(spaces.id, id))
      .limit(1)
  )[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)
  if (existing.kind === 'personal') {
    return c.json(
      {
        error: 'personal_space_cannot_archive',
        message: '个人空间不支持归档,请走「注销该用户」清理。',
      },
      400,
    )
  }
  if (existing.archivedAt !== null) {
    const [row] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1)
    if (!row) return c.json({ error: 'not_found' }, 404)
    return c.json(await archiveResponse(row, id))
  }

  const now = Date.now()
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(spaces)
      .set({ archivedAt: now, archivedByUserId: me.id, updatedAt: now })
      .where(eq(spaces.id, id))
      .returning()
    const row = rows[0]
    if (!row) return undefined
    await recordPermissionAudit(tx, {
      kind: 'space_archived',
      actorId: me.id,
      targetKind: 'space',
      targetId: id,
      payload: { after: { name: existing.name, archivedAt: now, archivedByUserId: me.id } },
    })
    return row
  })
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json(await archiveResponse(updated, id))
})

/* ─── POST /api/admin/spaces/:id/unarchive ──────────────────────────────
 * P1-1: 解除归档。恢复成正常 team space,所有写路径自动可用(canEditSpace
 * 重新打开,见 lib/permissions.ts)。
 *
 *   - 拒绝 personal space(同 archive,矩阵不允许)。
 *   - 拒绝未归档(no-op,audit 不写)。
 *   - 写 permission_audit(kind='space_unarchived',payload.before 记归档
 *     时间 + 操作者)。
 */
adminSpacesRouter.post('/:id/unarchive', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const existing = (
    await db
      .select({
        id: spaces.id,
        name: spaces.name,
        kind: spaces.kind,
        archivedAt: spaces.archivedAt,
        archivedByUserId: spaces.archivedByUserId,
      })
      .from(spaces)
      .where(eq(spaces.id, id))
      .limit(1)
  )[0]
  if (!existing) return c.json({ error: 'not_found' }, 404)
  if (existing.kind === 'personal') {
    return c.json(
      {
        error: 'personal_space_cannot_unarchive',
        message: '个人空间不属于归档生命周期。',
      },
      400,
    )
  }
  if (existing.archivedAt === null) {
    const [row] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1)
    if (!row) return c.json({ error: 'not_found' }, 404)
    return c.json(await archiveResponse(row, id))
  }

  const before = {
    name: existing.name,
    archivedAt:
      typeof existing.archivedAt === 'string'
        ? Number(existing.archivedAt)
        : existing.archivedAt,
    archivedByUserId: existing.archivedByUserId,
  }
  const now = Date.now()
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(spaces)
      .set({ archivedAt: null, archivedByUserId: null, updatedAt: now })
      .where(eq(spaces.id, id))
      .returning()
    const row = rows[0]
    if (!row) return undefined
    await recordPermissionAudit(tx, {
      kind: 'space_unarchived',
      actorId: me.id,
      targetKind: 'space',
      targetId: id,
      payload: { before },
    })
    return row
  })
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json(await archiveResponse(updated, id))
})

/**
 * Compose the standard admin Space DTO for archive / unarchive responses.
 * 不带 page stats —— 归档状态变更不影响 pageCount / childPageCount /
 * lastPageUpdatedAt;前端 invalidate 缓存后 GET 时再聚合。
 */
async function archiveResponse(row: SpaceRow, id: string): Promise<Space> {
  const accessGroupIds = await getAccessGroupIds(id)
  const ownerNames = await getSpaceOwnerNames([id])
  return attachStats(rowToSpace(row, accessGroupIds), undefined, ownerNames)
}

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
