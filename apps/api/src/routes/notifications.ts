/**
 * Notifications API — Stage 6.
 *
 *   GET    /api/notifications?limit=&offset=  → current user's inbox (read + unread)
 *   GET    /api/notifications/unread-count    → { count } for the bell badge
 *   POST   /api/notifications/mark-read       → mark ids (or all) read
 *   POST   /api/notifications/clear-all       → delete read rows (keep unread)
 *
 * Privacy model: every query is constrained by `WHERE user_id = me.id`. There
 * is NO admin bypass — admin views their own notifications, period. This
 * matches Confluence and Slack: notifications are recipient-private.
 *
 * Unread-count is served by a dedicated hot endpoint so the frontend's 30s
 * poll stays cheap (a single COUNT(*) on the (user_id, is_read, created_at)
 * index). See apps/web/src/composables/useNotifications.ts.
 *
 * `clear-all` does NOT touch unread rows — deleting unread would silently
 * lose notifications the user hasn't seen yet. Slack/Discord behavior:
 * "Clear" only removes what's already marked read.
 */

import { Hono } from 'hono'
import { and, count, desc, eq } from 'drizzle-orm'
import { inArray, isNull, sql } from 'drizzle-orm'
import {
  MarkReadInputSchema,
  NotificationSchema,
  PaginatedListSchema,
  UnreadCountResponseSchema,
} from '@power-wiki/shared/schemas'
import { db } from '../db/client'
import { notifications, users } from '../db/schema'
import { requireAuth, type Variables } from '../auth/middleware'
import { applyPagination, safeParsePagination } from '../lib/paginate'
import { rowToNotification } from '../lib/commentRowMappers'
import { getAccessibleSpaceIds } from '../lib/accessibleSpaceIds'

export const notificationsRouter = new Hono<{ Variables: Variables }>()
notificationsRouter.use('*', requireAuth)

/* ─── GET /api/notifications ──────────────────────────────────────────
 *
 * Pagination: `?limit=` (1-100, smaller than pages because each card is fat)
 * + `?offset=`. Both optional — absent = "first 50 to seed the view, frontend
 * can `loadMore` to extend".
 */
notificationsRouter.get('/', async (c) => {
  const me = c.get('user')
  const parsed = safeParsePagination(c)
  if (!parsed.ok) return parsed.response
  const { limit, offset } = parsed.args
  // Hard cap at 100 to keep response bodies manageable (each notification
  // has actor LEFT JOIN fields).
  const cappedLimit = limit !== undefined ? Math.min(100, Math.max(1, limit)) : 50

  let q = db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      actorId: notifications.actorId,
      kind: notifications.kind,
      pageId: notifications.pageId,
      pageTitle: notifications.pageTitle,
      commentId: notifications.commentId,
      mentionUserId: notifications.mentionUserId,
      isRead: notifications.isRead,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actorName: users.name,
      actorColor: users.color,
      actorAvatarKind: users.avatarKind,
      actorAvatarRef: users.avatarRef,
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.actorId, users.id))
    .where(eq(notifications.userId, me.id))
    .orderBy(desc(notifications.createdAt))
    .$dynamic()
  q = q.limit(cappedLimit + 1).offset(offset)
  const rows = await q
  const items = rows
    .slice(0, cappedLimit)
    .map((r) =>
      NotificationSchema.parse(
        rowToNotification(r, {
          actorName: r.actorName,
          actorColor: r.actorColor,
          actorAvatarKind: r.actorAvatarKind,
          actorAvatarRef: r.actorAvatarRef,
        }),
      ),
    )
  const result = applyPagination(items, cappedLimit, offset)
  return c.json(PaginatedListSchema(NotificationSchema).parse(result))
})

/* ─── GET /api/notifications/unread-count ─────────────────────────────
 *
 * Hot path for the bell badge. Single COUNT(*) on the
 * `(user_id, is_read, created_at)` covering index — sub-millisecond.
 */
notificationsRouter.get('/unread-count', async (c) => {
  const me = c.get('user')
  const rows = await db
    .select({ c: count() })
    .from(notifications)
    .where(
      and(eq(notifications.userId, me.id), eq(notifications.isRead, false)),
    )
  const c0 = rows[0]?.c ?? 0
  return c.json(UnreadCountResponseSchema.parse({ count: Number(c0) }))
})

/* ─── POST /api/notifications/mark-read ───────────────────────────────
 *
 * Two flavors: `{ ids: [...] }` for granular "dismiss these", or `{ all: true }`
 * for the "mark everything as read" button. Schema enforces one or the other.
 *
 * Updates only rows owned by `me.id` — a forged foreign id is silently ignored
 * (no error; the predicate `user_id = me.id` filters it out anyway).
 */
notificationsRouter.post('/mark-read', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = MarkReadInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const now = Date.now()
  const input = parsed.data
  if (input.all === true) {
    await db
      .update(notifications)
      .set({ isRead: true, readAt: now })
      .where(and(eq(notifications.userId, me.id), eq(notifications.isRead, false)))
  } else if (input.ids && input.ids.length > 0) {
    await db
      .update(notifications)
      .set({ isRead: true, readAt: now })
      .where(
        and(
          eq(notifications.userId, me.id),
          inArray(notifications.id, input.ids),
        ),
      )
  }
  return c.json({ ok: true })
})

/* ─── POST /api/notifications/clear-all ───────────────────────────────
 *
 * Delete only rows where `is_read = true` for the current user. Unread
 * rows are preserved — clearing unread silently would defeat the whole
 * point of an unread badge.
 *
 * Returns the deleted count for the frontend to update its cache.
 */
notificationsRouter.post('/clear-all', async (c) => {
  const me = c.get('user')
  const deleted = await db
    .delete(notifications)
    .where(
      and(eq(notifications.userId, me.id), eq(notifications.isRead, true)),
    )
    .returning({ id: notifications.id })
  return c.json({ deleted: deleted.length })
})
