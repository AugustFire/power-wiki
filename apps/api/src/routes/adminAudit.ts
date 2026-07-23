/**
 * Admin 审计日志路由 — Phase C。
 *
 *   GET /api/admin/audit?kind=&actorId=&targetKind=&targetId=&from=&to=&limit=&offset=
 *
 * Admin only。返回按 created_at DESC 排序的分页列表,actor 通过 LEFT JOIN
 * users 拼展示字段(name / email / color / avatar),不二次拉取。
 *
 * 设计要点:
 *   - **append-only 后端** —— GET 是唯一入口,无 POST/PATCH/DELETE 暴露给
 *     HTTP 层。唯一写入路径是 recordPermissionAudit(),在 mutation 路由的
 *     db.transaction() 内调用。
 *   - 过滤条件(actor / target / 时间段 / kind)任意组合;空 = 全部。
 *   - 默认 limit=50、offset=0;前端翻页用 total/limit 算 max page。
 *   - payload 是 JSONB 自由形态 —— schema 上保留 unknown,前端按 kind
 *     分支展示(before/after diff)。
 *   - 不暴露 actor 的 password_hash / sensitive 字段(只 SELECT 白名单列)。
 */
import { Hono } from 'hono'
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import {
  AuditEntrySchema,
  AuditListQuerySchema,
  AuditListResponseSchema,
  type AuditEntry,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { permissionAudit, users } from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'

export const adminAuditRouter = new Hono<{ Variables: Variables }>()

adminAuditRouter.use('*', requireAdmin)

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

adminAuditRouter.get('/audit', async (c) => {
  const raw = c.req.query()
  const parsed = AuditListQuerySchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const q = parsed.data

  const limit = q.limit ?? DEFAULT_LIMIT
  const offset = q.offset ?? 0

  // 过滤条件按需累加,避免 WHERE 1=1 这种 anti-pattern。
  const conds: SQL[] = []
  if (q.kind) conds.push(eq(permissionAudit.kind, q.kind))
  if (q.actorId) conds.push(eq(permissionAudit.actorId, q.actorId))
  if (q.targetKind) conds.push(eq(permissionAudit.targetKind, q.targetKind))
  if (q.targetId) conds.push(eq(permissionAudit.targetId, q.targetId))
  if (q.from !== undefined) conds.push(gte(permissionAudit.createdAt, q.from))
  if (q.to !== undefined) conds.push(lte(permissionAudit.createdAt, q.to))
  const where = conds.length === 0 ? undefined : and(...conds)

  // 总数(分页用) —— 用同一 WHERE 跑一次 COUNT;行数大时可优化到 estimated
  // count,但 audit 表本身只 append-only 增长,count(*) 走 created_idx 也够用。
  const totalRow = (
    await db
      .select({ n: permissionAudit.id })
      .from(permissionAudit)
      .where(where)
  ).length

  // 主查询:LEFT JOIN users 取 actor 展示字段(白名单列,不暴露 password)。
  const rows = await db
    .select({
      id: permissionAudit.id,
      kind: permissionAudit.kind,
      actorId: permissionAudit.actorId,
      actorName: users.name,
      actorEmail: users.email,
      actorColor: users.color,
      actorAvatarKind: users.avatarKind,
      actorAvatarRef: users.avatarRef,
      targetKind: permissionAudit.targetKind,
      targetId: permissionAudit.targetId,
      createdAt: permissionAudit.createdAt,
      payload: permissionAudit.payload,
    })
    .from(permissionAudit)
    .leftJoin(users, eq(users.id, permissionAudit.actorId))
    .where(where)
    .orderBy(desc(permissionAudit.createdAt), desc(permissionAudit.id))
    .limit(limit)
    .offset(offset)

  const entries: AuditEntry[] = rows.map((r) => ({
    id: r.id,
    // AuditEntrySchema 限定 11 个 kind 值;DB CHECK 已把守,这里再 narrow 一下。
    kind: r.kind as AuditEntry['kind'],
    actorId: r.actorId,
    actorName: r.actorName ?? null,
    actorEmail: r.actorEmail ?? null,
    actorColor: r.actorColor ?? null,
    actorAvatarKind: (r.actorAvatarKind ?? null) as AuditEntry['actorAvatarKind'],
    actorAvatarRef: r.actorAvatarRef ?? null,
    targetKind: r.targetKind as AuditEntry['targetKind'],
    targetId: r.targetId,
    createdAt: r.createdAt,
    payload: r.payload ?? null,
  }))

  const resp = AuditListResponseSchema.parse({ total: totalRow, entries })
  return c.json(resp)
})
