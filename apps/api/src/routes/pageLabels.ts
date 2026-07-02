/**
 * Page labels API — Stage 8.
 *
 *   POST   /api/pages/:id/labels                  body {label}    → 204
 *   DELETE /api/pages/:id/labels/:label            (URL param)     → 204
 *   GET    /api/labels/search?q=<prefix>&limit=20                   → string[]
 *
 * The router is mounted at TWO prefixes in apps/api/src/index.ts:
 *   - /api/pages   (for the per-page add / remove under /:id/labels/...)
 *   - /api/labels  (for /search)
 *
 * Storage rules (server-enforced):
 *   - Server normalizes: trim + lowercase. Caller's original case is gone.
 *   - Length: 1-32 chars after normalize.
 *   - Idempotent add: same label twice is a no-op (composite PK).
 *
 * Permission model (Notion-style, confirmed with user):
 *   - Any user who can READ the page can add / remove any label on it.
 *   - 404 on inaccessible page (not 403, leak prevention).
 *   - 403 admin writing personal space (same guard as pages PATCH).
 *   - `search` returns labels only on pages the user can access.
 */

import { Hono } from 'hono'
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { AddLabelInputSchema } from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { pageLabels, pages } from '../db/schema'
import { canAccessSpace, getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'
import { assertAdminNotWritingPersonalSpace } from '../lib/personalSpaceGuard'
import { type Variables } from '../auth/middleware'

export const pageLabelsRouter = new Hono<{ Variables: Variables }>()

const MAX_LABEL_LEN = 32

/** trim + lowercase + length check. Returns null on rejection. */
function normalizeLabel(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  if (v.length < 1 || v.length > MAX_LABEL_LEN) return null
  // Reject labels that are pure punctuation / whitespace — visible to user as
  // "added nothing" which is confusing.
  if (!/[\p{L}\p{N}]/u.test(v)) return null
  return v
}

/* ─── POST /api/pages/:id/labels ──────────────────────────────────────
 *  Idempotent: ON CONFLICT DO NOTHING. Returns 204 either way (Notion-style:
 *  re-adding is a silent no-op, not a 409).
 */
pageLabelsRouter.post('/:id/labels', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = AddLabelInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const normalized = normalizeLabel(parsed.data.label)
  if (!normalized) {
    return c.json({ error: 'invalid_label', message: '标签必须包含字母或数字,长度 1-32' }, 400)
  }

  const [page] = await db
    .select({ spaceId: pages.spaceId, deletedAt: pages.deletedAt })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1)
  if (!page || page.spaceId === null || page.deletedAt !== null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', page.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const blocked = await assertAdminNotWritingPersonalSpace(c, me, page.spaceId)
  if (blocked) return blocked

  await db
    .insert(pageLabels)
    .values({
      pageId: id,
      label: normalized,
      authorId: me.id,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()

  return c.body(null, 204)
})

/* ─── DELETE /api/pages/:id/labels/:label ──────────────────────────────
 *  URL :label is assumed pre-normalized (lowercase + trimmed). Server
 *  normalizes defensively anyway. 404 if the label wasn't on the page —
 *  caller can't distinguish "page gone" from "label gone" (same leak
 *  prevention as the rest of the API).
 */
pageLabelsRouter.delete('/:id/labels/:label', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')
  const normalized = normalizeLabel(c.req.param('label'))
  if (!normalized) {
    // The URL is malformed — treat as 404 (no leak).
    return c.json({ error: 'not_found' }, 404)
  }

  const [page] = await db
    .select({ spaceId: pages.spaceId, deletedAt: pages.deletedAt })
    .from(pages)
    .where(eq(pages.id, id))
    .limit(1)
  if (!page || page.spaceId === null || page.deletedAt !== null) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!(await canAccessSpace(me.id, me.role === 'admin', page.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const blocked = await assertAdminNotWritingPersonalSpace(c, me, page.spaceId)
  if (blocked) return blocked

  await db
    .delete(pageLabels)
    .where(and(eq(pageLabels.pageId, id), eq(pageLabels.label, normalized)))

  return c.body(null, 204)
})

/* ─── GET /api/labels/search ──────────────────────────────────────────
 *  Distinct label names containing q (case-insensitive substring match on
 *  the lowercased stored values) that appear on at least one page the user
 *  can access. Ordered alphabetically. Capped at `limit` (default 20).
 *
 *  Used by LabelAddPopover autocomplete. NOT mounted at /api/pages — this
 *  lives at /api/labels/search (see index.ts).
 */
pageLabelsRouter.get('/search', async (c) => {
  const me = c.get('user')
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  if (q.length === 0) return c.json([], 200)
  const limitRaw = Number(c.req.query('limit') ?? '20')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 50) : 20

  // Admin sees everything; non-admin sees labels on pages in accessible
  // spaces only.
  let accessible: Awaited<ReturnType<typeof getAccessibleSpaceIds>> | '*'
  if (me.role === 'admin') {
    accessible = '*'
  } else {
    accessible = await getAccessibleSpaceIds(me.id, false)
    if (accessible === '*' || accessible.length === 0) return c.json([], 200)
  }

  // Drizzle build the JOIN + WHERE. The DISTINCT runs through SQL helper.
  const base = db
    .selectDistinct({ label: pageLabels.label })
    .from(pageLabels)
    .innerJoin(pages, eq(pages.id, pageLabels.pageId))
    .where(
      and(
        isNull(pages.deletedAt),
        like(pageLabels.label, `%${q}%`),
        accessible === '*' ? sql`TRUE` : inArray(pages.spaceId, accessible as string[]),
      ),
    )
    .orderBy(pageLabels.label)
    .limit(limit)
  const rows = await base
  return c.json(rows.map((r) => r.label))
})