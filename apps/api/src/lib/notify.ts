/**
 * Notification enqueue helper — Stage 6.
 *
 * Single point of entry for writing `notifications` rows. Route handlers
 * MUST go through this rather than `tx.insert(notifications)` directly
 * so the deduplication / self-notification / kind-specific rules are
 * consistent across comments POST / future reply / future mention-edit.
 *
 * Invariants enforced:
 *   - actor.id === recipient.id → no row is inserted (don't notify yourself)
 *   - mention kind: one row per mentioned user (excluding the actor)
 *   - reply kind: zero or one row, target = parent comment author
 *   - comment_on_my_page: zero or one row, target = page author
 *   - `pageTitle` snapshotted at trigger time (denormalized for history)
 */
import { nanoid } from 'nanoid'
import type { AuthenticatedUser } from '../auth/session'
import { notifications } from '../db/schema'
import type { db } from '../db/client'

export type NotificationKind = 'mention' | 'reply' | 'comment_on_my_page'

export interface EnqueueArgs {
  kind: NotificationKind
  actor: AuthenticatedUser
  pageId: string
  /** Page title snapshot — pass through from the comment trigger site. */
  pageTitle?: string | null
  commentId: string
  /** Required for kind='mention'. Ignored for others. */
  mentionedUserIds?: string[]
  /** Required for kind='reply'. */
  parentAuthorId?: string | null
  /** Required for kind='comment_on_my_page'. */
  pageAuthorId?: string | null
}

/** Drizzle's tx type, derived from the concrete `db` client so we don't
 *  hard-code generic parameters. Callers pass `tx` obtained from
 *  `db.transaction((tx) => ...)`. */
type NotifyTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Generate id with the project's nanoid alphabet (matches pages/users). */
function newNid(): string {
  return nanoid(10)
}

type NotificationRowShape = {
  id: string
  userId: string
  actorId: string
  kind: NotificationKind
  pageId: string
  pageTitle: string | null
  commentId: string
  mentionUserId: string | null
  isRead: false
  createdAt: number
}

/** Insert one or more new notification rows.
 *
 *  Returns the number actually inserted after dedupe + self-filter.
 *  Returns 0 if there's nothing to do (silent no-op). */
export async function enqueueNotifications(
  tx: NotifyTx,
  args: EnqueueArgs,
): Promise<number> {
  const now = Date.now()
  const rows: NotificationRowShape[] = []

  switch (args.kind) {
    case 'mention': {
      const ids = (args.mentionedUserIds ?? []).filter((u) => u !== args.actor.id)
      const seen = new Set<string>()
      for (const uid of ids) {
        if (seen.has(uid)) continue
        seen.add(uid)
        rows.push({
          id: newNid(),
          userId: uid,
          actorId: args.actor.id,
          kind: 'mention',
          pageId: args.pageId,
          pageTitle: args.pageTitle ?? null,
          commentId: args.commentId,
          mentionUserId: uid,
          isRead: false,
          createdAt: now,
        })
      }
      break
    }
    case 'reply': {
      const target = args.parentAuthorId
      if (target && target !== args.actor.id) {
        rows.push({
          id: newNid(),
          userId: target,
          actorId: args.actor.id,
          kind: 'reply',
          pageId: args.pageId,
          pageTitle: args.pageTitle ?? null,
          commentId: args.commentId,
          mentionUserId: null,
          isRead: false,
          createdAt: now,
        })
      }
      break
    }
    case 'comment_on_my_page': {
      const target = args.pageAuthorId
      if (target && target !== args.actor.id) {
        rows.push({
          id: newNid(),
          userId: target,
          actorId: args.actor.id,
          kind: 'comment_on_my_page',
          pageId: args.pageId,
          pageTitle: args.pageTitle ?? null,
          commentId: args.commentId,
          mentionUserId: null,
          isRead: false,
          createdAt: now,
        })
      }
      break
    }
  }

  if (rows.length === 0) return 0
  await tx.insert(notifications).values(rows)
  return rows.length
}
