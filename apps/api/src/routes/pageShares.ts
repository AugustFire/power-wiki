/**
 * Page-level public share routes — Phase D (Confluence 风格匿名只读分享)。
 *
 *   POST   /api/pages/:id/share           body: {expiresInDays?: number|null}  — edit-access on page
 *   GET    /api/pages/:id/shares                                                      — edit-access on page
 *   DELETE /api/pages/:id/share/:shareId                                              — edit-access on page
 *
 * 区别于 `/api/public/pages/:token` 路由(挂在 requireAuth 之前,纯匿名):
 * 这套端点需要 auth + edit-access,管理「哪些 share 在跑、谁在用、撤销」。
 * 三个端点都用「edit-access on page」或以上做 gate —— page 作者 / space-
 * admin / global admin / 空间 editor 都能管理(与 canManageRestrictions 对称,
 * 实际上是同一权限集合)。
 *
 * 关键约束(POST 校验):
 *   1. page 必须在 `kind='shared'` 空间(个人空间永不可分享)。
 *   2. page 不能有 view restriction(否则「外部分享」等于绕过限制,
 *      与 view 限制的「谁能看到」语义相悖)。
 *   3. page 不能在回收站(deletedAt 非 null)。
 *   4. expiresInDays > 0 且 ≤ 365(可空 null = 永不过期)。
 *
 * 创建响应里的 `token` 是**明文,只此一次**——丢失即失效(再 create
 * 新的 / revoke 旧的)。前端拿到立刻复制,DB 里只有 sha256 hash。
 *
 * Phase C 审计:create / revoke 在 db.transaction() 内 recordPermissionAudit
 * (targetKind='page_share'),与业务行同事务同生死。
 */
import { Hono } from 'hono'
import { and, desc, eq, or } from 'drizzle-orm'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  CreateShareInputSchema,
  CreateShareResponseSchema,
  ShareListResponseSchema,
  type CreateShareResponse,
  type ShareRow,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import {
  pagePublicShares,
  pageRestrictions,
  spaces,
  users,
} from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { generatePageId } from '../lib/ids'
import {
  canAdminSpace,
  canEditPage,
  loadPageMeta,
  principalFromUser,
} from '../lib/permissions'
import { recordPermissionAudit } from '../lib/auditLog'
import { generateShareToken, hashToken } from '../lib/shareTokens'

export const pageSharesRouter = new Hono<{ Variables: Variables }>()

// requireAuth 兜底;handler 内细判 canEditPage / canAdminSpace / global admin。
pageSharesRouter.use('*', requireAuth)

/* ─── Helpers ─────────────────────────────────────────────────────── */

/**
 * 鉴权 + 业务前约束:
 *   - 404 page not found / trashed
 *   - 400 share_forbidden (personal space / view restriction)
 *   - 404 caller can't edit (404-not-403 政策)
 */
async function gateShareManage(c: {
  req: { param: (k: string) => string }
  var: { user: { id: string; role: 'admin' | 'user' } }
}): Promise<
  | { ok: true; pageId: string; spaceId: string; spaceKind: 'personal' | 'shared' | null }
  | { ok: false; status: number; code: string; message: string }
> {
  const pageId = c.req.param('id')
  const me = principalFromUser(c.var.user)
  const meta = await loadPageMeta(pageId)
  if (!meta) return { ok: false, status: 404, code: 'not_found', message: '页面不存在' }
  if (meta.deletedAt !== null) {
    return { ok: false, status: 404, code: 'not_found', message: '页面已在回收站' }
  }

  // canEditPage 包含:admin / page 作者 / 空间 editor / 空间 admin。
  // share 路由对 space-admin 也要放行(canAdminSpace 单独判断)—— 但
  // canEditPage 已经把「空间 editor」放进了,空间 admin 顺带。
  const canEdit = await canEditPage(me, pageId, meta.spaceId, meta.authorId)
  const isAdmin = me.isAdmin || (await canAdminSpace(me, meta.spaceId))
  if (!canEdit && !isAdmin) {
    return { ok: false, status: 404, code: 'not_found', message: '页面不存在' }
  }

  // 取 space 自身 kind(用于 share_forbidden 校验)
  const sp = (
    await db
      .select({ kind: spaces.kind })
      .from(spaces)
      .where(eq(spaces.id, meta.spaceId))
      .limit(1)
  )[0]
  if (!sp) return { ok: false, status: 404, code: 'not_found', message: '空间不存在' }
  return { ok: true, pageId, spaceId: meta.spaceId, spaceKind: sp.kind }
}

/** view 限制存在性:任意 view-allow-list 行 = 已被限制,不能分享。 */
async function hasViewRestriction(pageId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: pageRestrictions.id })
      .from(pageRestrictions)
      .where(and(eq(pageRestrictions.pageId, pageId), eq(pageRestrictions.kind, 'view')))
      .limit(1)
  )[0]
  return !!row
}

/** DB row → ShareRow DTO(actor 名字 LEFT JOIN 平铺)。 */
function rowToShare(
  row: {
    id: string
    pageId: string
    createdBy: string
    createdAt: number
    expiresAt: number | null
    revokedAt: number | null
    revokedBy: string | null
    lastAccessedAt: number | null
  },
  actorName: string | null,
  revokerName: string | null,
): ShareRow {
  return {
    id: row.id,
    pageId: row.pageId,
    createdBy: row.createdBy,
    createdByName: actorName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    revokedByName: revokerName,
    lastAccessedAt: row.lastAccessedAt,
  }
}

/* ─── POST /api/pages/:id/share ────────────────────────────────────── */

pageSharesRouter.post('/:id/share', async (c) => {
  const gate = await gateShareManage(c)
  if (!gate.ok) {
    return c.json(
      { error: gate.code, code: gate.code, message: gate.message },
      gate.status as ContentfulStatusCode,
    )
  }
  const { pageId, spaceKind } = gate

  if (spaceKind !== 'shared') {
    return c.json(
      { error: 'share_forbidden', message: '个人空间不能分享' },
      400,
    )
  }
  if (await hasViewRestriction(pageId)) {
    return c.json(
      {
        error: 'share_forbidden',
        message: '该页面已设置查看限制,不能创建公开分享',
      },
      400,
    )
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateShareInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { expiresInDays = null } = parsed.data

  const me = principalFromUser(c.var.user)
  const token = generateShareToken()
  const tokenHash = hashToken(token)
  const now = Date.now()
  const expiresAt = expiresInDays === null || expiresInDays === undefined
    ? null
    : now + expiresInDays * 24 * 60 * 60 * 1000

  const id = generatePageId()
  await db.transaction(async (tx) => {
    await tx.insert(pagePublicShares).values({
      id,
      pageId,
      tokenHash,
      createdBy: me.id,
      createdAt: now,
      expiresAt,
      revokedAt: null,
      revokedBy: null,
      lastAccessedAt: null,
    })
    await recordPermissionAudit(tx, {
      kind: 'page_share_create',
      actorId: me.id,
      targetKind: 'page_share',
      targetId: id,
      payload: {
        after: { pageId, expiresAt, createdAt: now },
      },
    })
  })

  const url = `/public/pages/${token}`
  const resp = CreateShareResponseSchema.parse({
    id,
    token,
    url,
    expiresAt,
    createdAt: now,
  } satisfies CreateShareResponse)
  return c.json(resp, 201)
})

/* ─── GET /api/pages/:id/shares ────────────────────────────────────── */

pageSharesRouter.get('/:id/shares', async (c) => {
  const gate = await gateShareManage(c)
  if (!gate.ok) {
    return c.json(
      { error: gate.code, code: gate.code, message: gate.message },
      gate.status as ContentfulStatusCode,
    )
  }
  const { pageId } = gate

  // LEFT JOIN users × 2:created_by + revoked_by,平铺展示。
  // 单 share 行 → 2 行(users × created_by,users × revoked_by);
  // GROUP BY 重组?为简单,改用两次 SELECT + 拼 map。
  const rows = await db
    .select({
      id: pagePublicShares.id,
      pageId: pagePublicShares.pageId,
      createdBy: pagePublicShares.createdBy,
      createdAt: pagePublicShares.createdAt,
      expiresAt: pagePublicShares.expiresAt,
      revokedAt: pagePublicShares.revokedAt,
      revokedBy: pagePublicShares.revokedBy,
      lastAccessedAt: pagePublicShares.lastAccessedAt,
    })
    .from(pagePublicShares)
    .where(eq(pagePublicShares.pageId, pageId))
    .orderBy(desc(pagePublicShares.createdAt))

  // 收集所有 userId(created_by + revoked_by),一次 LEFT JOIN 拿 name
  const userIds = new Set<string>()
  for (const r of rows) {
    userIds.add(r.createdBy)
    if (r.revokedBy) userIds.add(r.revokedBy)
  }
  const nameMap = new Map<string, string>()
  if (userIds.size > 0) {
    const us = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(or(...[...userIds].map((id) => eq(users.id, id)))!)
    for (const u of us) nameMap.set(u.id, u.name)
  }

  const shares: ShareRow[] = rows.map((r) =>
    rowToShare(r, nameMap.get(r.createdBy) ?? null, r.revokedBy ? nameMap.get(r.revokedBy) ?? null : null),
  )
  return c.json(ShareListResponseSchema.parse({ shares }))
})

/* ─── DELETE /api/pages/:id/share/:shareId ─────────────────────────── */

pageSharesRouter.delete('/:id/share/:shareId', async (c) => {
  const gate = await gateShareManage(c)
  if (!gate.ok) {
    return c.json(
      { error: gate.code, code: gate.code, message: gate.message },
      gate.status as ContentfulStatusCode,
    )
  }
  const { pageId } = gate
  const shareId = c.req.param('shareId')
  const me = principalFromUser(c.var.user)

  const existing = (
    await db
      .select({
        id: pagePublicShares.id,
        pageId: pagePublicShares.pageId,
        createdBy: pagePublicShares.createdBy,
        createdAt: pagePublicShares.createdAt,
        expiresAt: pagePublicShares.expiresAt,
        revokedAt: pagePublicShares.revokedAt,
        revokedBy: pagePublicShares.revokedBy,
        lastAccessedAt: pagePublicShares.lastAccessedAt,
      })
      .from(pagePublicShares)
      .where(and(eq(pagePublicShares.id, shareId), eq(pagePublicShares.pageId, pageId)))
      .limit(1)
  )[0]
  if (!existing) {
    // id 不存在 / 不属于该 page → 404(而非 200/204),管理面要明确反馈。
    return c.json({ error: 'not_found', message: '分享链接不存在' }, 404)
  }
  if (existing.revokedAt !== null) {
    return c.json(
      {
        error: 'share_already_revoked',
        message: '该分享链接已撤销',
      },
      400,
    )
  }

  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .update(pagePublicShares)
      .set({ revokedAt: now, revokedBy: me.id })
      .where(eq(pagePublicShares.id, shareId))
    await recordPermissionAudit(tx, {
      kind: 'page_share_revoke',
      actorId: me.id,
      targetKind: 'page_share',
      targetId: shareId,
      payload: {
        before: {
          pageId: existing.pageId,
          createdBy: existing.createdBy,
          createdAt: existing.createdAt,
          expiresAt: existing.expiresAt,
        },
      },
    })
  })

  return c.body(null, 204)
})
