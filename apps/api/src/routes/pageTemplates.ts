/**
 * Page templates API — Stage 8.
 *
 *   GET    /api/templates?space=<id>          → PageTemplate[] (built-ins + space-scoped)
 *   POST   /api/templates                     → 201 + PageTemplate
 *   DELETE /api/templates/:id                 → 204 (built-ins: admin only)
 *
 * Mounted at /api/templates in apps/api/src/index.ts.
 *
 * Permission model:
 *   - GET with `?space=<id>` requires `canAccessSpace`. Omitting `space`
 *     returns ONLY the global templates (admin still bypasses the
 *     space-access check because they see all spaces).
 *   - POST with `spaceId: null/undefined` is admin-only (global template).
 *   - POST with `spaceId: <X>` requires `canAccessSpace(me, admin, X)`
 *     (Notion-style — any space member can create). Admin can also write
 *     to personal spaces for templates? No — we apply the same personal-
 *     space guard as pages (admin supervises, doesn't write templates
 *     to user spaces either).
 *   - DELETE: built-ins refuse 403 unless me.role === 'admin'. Admin's
 *     deletion of a built-in is permanent (bootstrap only inserts if
 *     absent — it never re-creates deleted built-ins).
 *
 * The 5 built-in templates (空白 / 会议纪要 / RFC / SOP / 周报) are seeded
 * by `apps/api/src/auth/bootstrap.ts` step 6 on first run, idempotently.
 */

import { Hono } from 'hono'
import { and, asc, eq, getTableColumns, isNull } from 'drizzle-orm'
import {
  CreateTemplateInputSchema,
  PageTemplateSchema,
} from '@power-wiki/shared/schemas'
import type { PageTemplate } from '@power-wiki/shared'
import { db } from '../db/client'
import { pageTemplates, users } from '../db/schema'
import { generatePageId } from '../lib/ids'
import { canAccessSpace } from '../lib/accessibleSpaceIds'
import { assertAdminNotWritingPersonalSpace } from '../lib/personalSpaceGuard'
import { type Variables } from '../auth/middleware'

export const pageTemplatesRouter = new Hono<{ Variables: Variables }>()

type TemplateRowWithAuthor = {
  id: string
  spaceId: string | null
  title: string
  description: string | null
  contentJson: PageTemplate['contentJSON']
  contentHtml: string
  icon: string | null
  isBuiltIn: boolean
  createdBy: string
  createdAt: number
  createdByName: string | null
  createdByColor: string | null
}

function rowToPageTemplate(row: TemplateRowWithAuthor): PageTemplate {
  const t: PageTemplate = {
    id: row.id,
    spaceId: row.spaceId,
    title: row.title,
    contentJSON: row.contentJson,
    contentHTML: row.contentHtml,
    isBuiltIn: row.isBuiltIn,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    createdByColor: row.createdByColor,
    createdAt: row.createdAt,
  }
  if (row.description !== null) t.description = row.description
  if (row.icon !== null) t.icon = row.icon
  return t
}

/* ─── GET /api/templates ──────────────────────────────────────────────
 *  If `?space=<id>` is provided: returns built-ins + space-scoped templates
 *  for that space. Caller must canAccessSpace (admin bypasses).
 *  If no `space`: returns only the built-ins (anyone can see them).
 */
pageTemplatesRouter.get('/', async (c) => {
  const me = c.get('user')
  const querySpace = c.req.query('space') ?? null

  if (querySpace !== null) {
    if (!(await canAccessSpace(me.id, me.role === 'admin', querySpace))) {
      return c.json({ error: 'not_found' }, 404)
    }
  }

  const rows = await db
    .select({
      ...getTableColumns(pageTemplates),
      createdByName: users.name,
      createdByColor: users.color,
    })
    .from(pageTemplates)
    .leftJoin(users, eq(users.id, pageTemplates.createdBy))
    .where(
      querySpace === null
        ? isNull(pageTemplates.spaceId)
        : // Space-scoped match. Built-ins are appended via a second SELECT
          // below — `OR (spaceId IS NULL)` would also work but would force
          // us to merge the group-by/agg logic for createdBy join, which is
          // already in this query. Two SELECTs + concat keeps the existing
          // shape.
          eq(pageTemplates.spaceId, querySpace),
    )
    .orderBy(asc(pageTemplates.title))

  // The "?space" branch above only matches space-scoped. To include built-ins
  // when ?space is present, do a second SELECT and concat.
  let builtInRows: typeof rows = []
  if (querySpace !== null) {
    builtInRows = await db
      .select({
        ...getTableColumns(pageTemplates),
        createdByName: users.name,
        createdByColor: users.color,
      })
      .from(pageTemplates)
      .leftJoin(users, eq(users.id, pageTemplates.createdBy))
      .where(isNull(pageTemplates.spaceId))
      .orderBy(asc(pageTemplates.title))
  }

  const all = [...builtInRows, ...rows]
  // Validate with zod — surfaces any drift at the boundary.
  return c.json(all.map(rowToPageTemplate).map((t) => PageTemplateSchema.parse(t)))
})

/* ─── POST /api/templates ─────────────────────────────────────────────
 *  Body: { spaceId?: string|null, title, description?, contentJSON,
 *          contentHTML, icon? }
 *  Rules: see header. Personal-space guard applies when spaceId is set
 *  and points at a personal space.
 */
pageTemplatesRouter.post('/', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateTemplateInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data

  // Global template → admin only.
  if (input.spaceId == null) {
    if (me.role !== 'admin') {
      return c.json({ error: 'forbidden', message: '只有管理员能创建全局模板' }, 403)
    }
  } else {
    if (!(await canAccessSpace(me.id, me.role === 'admin', input.spaceId))) {
      return c.json({ error: 'not_found' }, 404)
    }
    const blocked = await assertAdminNotWritingPersonalSpace(c, me, input.spaceId)
    if (blocked) return blocked
  }

  const id = generatePageId()
  const now = Date.now()
  await db.insert(pageTemplates).values({
    id,
    spaceId: input.spaceId ?? null,
    title: input.title,
    description: input.description ?? null,
    contentJson: input.contentJSON,
    contentHtml: input.contentHTML,
    icon: input.icon ?? null,
    isBuiltIn: false,
    createdBy: me.id,
    createdAt: now,
  })

  const rows = await db
    .select({
      ...getTableColumns(pageTemplates),
      createdByName: users.name,
      createdByColor: users.color,
    })
    .from(pageTemplates)
    .leftJoin(users, eq(users.id, pageTemplates.createdBy))
    .where(eq(pageTemplates.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(PageTemplateSchema.parse(rowToPageTemplate(row)), 201)
})

/* ─── DELETE /api/templates/:id ───────────────────────────────────────
 *  Built-ins: admin only. Other templates: any user who can access the
 *  template's space (or any user for global templates — admin only by
 *  virtue of the create rule above, so global delete is admin only too).
 */
pageTemplatesRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  const [row] = await db
    .select()
    .from(pageTemplates)
    .where(eq(pageTemplates.id, id))
    .limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)

  if (row.isBuiltIn && me.role !== 'admin') {
    return c.json(
      { error: 'forbidden', message: '内置模板只能由管理员删除' },
      403,
    )
  }

  // For non-built-in, non-global templates, the caller must have access
  // to the template's space. Global templates (spaceId NULL) require admin.
  if (row.spaceId !== null) {
    if (!(await canAccessSpace(me.id, me.role === 'admin', row.spaceId))) {
      return c.json({ error: 'not_found' }, 404)
    }
    const blocked = await assertAdminNotWritingPersonalSpace(c, me, row.spaceId)
    if (blocked) return blocked
  } else if (me.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403)
  }

  await db.delete(pageTemplates).where(eq(pageTemplates.id, id))
  return c.body(null, 204)
})