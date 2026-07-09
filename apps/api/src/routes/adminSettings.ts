/**
 * Admin settings routes — P1-8 回收站保留期配置。
 *
 *   GET   /api/admin/settings                  all settings (key-value bag)
 *   GET   /api/admin/settings/:key             single setting
 *   PATCH /api/admin/settings/:key             upsert a single setting
 *
 * 现阶段只支持:
 *   - `trash_retention_days`:0=永不清,30=默认,>0=天数。
 *     schema 通用,future settings 走同一个 PATCH 端点。
 *
 * 全部 admin-only(register requireAdmin router-locally)。
 *
 * Per CLAUDE.md "不主动 commit / push":changes stay local;user says
 * "提交吧" before any git commit/push.
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  AdminSettingSchema,
  UpdateAdminSettingInputSchema,
  type AdminSetting,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { adminSettings } from '../db/schema'
import { requireAdmin, type Variables } from '../auth/middleware'
import { DEFAULT_TRASH_RETENTION_DAYS } from '../lib/retention'

export const adminSettingsRouter = new Hono<{ Variables: Variables }>()

adminSettingsRouter.use('*', requireAdmin)

/** Whitelisted setting keys — currently only `trash_retention_days`.
 *  Future settings get a new key + branch here. */
const SUPPORTED_KEYS = ['trash_retention_days'] as const
type SupportedKey = (typeof SUPPORTED_KEYS)[number]

function rowToSetting(row: typeof adminSettings.$inferSelect): AdminSetting {
  return AdminSettingSchema.parse({
    key: row.key,
    value: row.value,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  })
}

function isSupportedKey(key: string): key is SupportedKey {
  return (SUPPORTED_KEYS as readonly string[]).includes(key)
}

// ─── GET /api/admin/settings ──────────────────────────────────────────────
adminSettingsRouter.get('/', async (c) => {
  const rows = await db.select().from(adminSettings)
  // 永远 ensure `trash_retention_days` 存在(缺则返默认 30)。这样前端
  // 不用处理"DB 里没行"的边界 — 总是看到稳定 shape。
  const out: AdminSetting[] = rows.map(rowToSetting)
  if (!out.find((s) => s.key === 'trash_retention_days')) {
    out.push(
      AdminSettingSchema.parse({
        key: 'trash_retention_days',
        value: String(DEFAULT_TRASH_RETENTION_DAYS),
        updatedAt: 0,
        updatedBy: null,
      }),
    )
  }
  return c.json({ items: out })
})

// ─── GET /api/admin/settings/:key ────────────────────────────────────────
adminSettingsRouter.get('/:key', async (c) => {
  const key = c.req.param('key')
  if (!isSupportedKey(key)) {
    return c.json({ error: 'unknown_key', key }, 400)
  }
  const row = (
    await db
      .select()
      .from(adminSettings)
      .where(eq(adminSettings.key, key))
      .limit(1)
  )[0]
  if (row) return c.json(rowToSetting(row))
  // 缺 key 时返默认 0(等于"未配置 → 走 DEFAULT_TRASH_RETENTION_DAYS")。
  return c.json(
    AdminSettingSchema.parse({
      key,
      value: String(DEFAULT_TRASH_RETENTION_DAYS),
      updatedAt: 0,
      updatedBy: null,
    }),
  )
})

// ─── PATCH /api/admin/settings/:key ──────────────────────────────────────
// Body: { value: number } (数字,会存为字符串)。
adminSettingsRouter.patch('/:key', async (c) => {
  const me = c.get('user')
  const key = c.req.param('key')
  if (!isSupportedKey(key)) {
    return c.json({ error: 'unknown_key', key }, 400)
  }
  const body = await c.req.json().catch(() => ({}))
  const parsed = UpdateAdminSettingInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const now = Date.now()
  await db
    .insert(adminSettings)
    .values({
      key,
      value: String(parsed.data.value),
      updatedAt: now,
      updatedBy: me.id,
    })
    .onConflictDoUpdate({
      target: adminSettings.key,
      set: {
        value: String(parsed.data.value),
        updatedAt: now,
        updatedBy: me.id,
      },
    })
  return c.json(
    AdminSettingSchema.parse({
      key,
      value: String(parsed.data.value),
      updatedAt: now,
      updatedBy: me.id,
    }),
  )
})
