/**
 * Notification enqueue helpers — Stage 6 + M13.
 *
 * Two entry points:
 *   - `enqueueNotifications` — Stage 6 kinds (mention / reply /
 *     comment_on_my_page / page_like). 1:1 / 1:N deterministic fanout
 *     to a known recipient set.
 *   - `enqueueWatchFanout`   — M13 watch fanout (page_edit /
 *     page_renamed / page_moved / page_restored / page_deleted /
 *     comment_add). Recipients are derived from `user_watched_pages`,
 *     with 5-min dedup + author dedup for comment_add.
 *
 * Route handlers MUST go through these helpers rather than
 * `tx.insert(notifications)` directly so the deduplication /
 * self-notification / kind-specific rules are consistent.
 *
 * Invariants enforced:
 *   - actor.id === recipient.id → no row is inserted (don't notify yourself)
 *   - mention kind: one row per mentioned user (excluding the actor)
 *   - reply kind: zero or one row, target = parent comment author
 *   - comment_on_my_page: zero or one row, target = page author
 *   - page_like kind: zero or one row, target = page author; only on LIKE
 *     (unlike is silent — no notification, no email). commentId is null
 *     since likes are not tied to a comment.
 *   - watch fanout: recipients = user_watched_pages minus actor; 5-min
 *     dedup on (userId, pageId, kind, actorId); comment_add also dedups
 *     the page author (they get comment_on_my_page from the comment route
 *     instead — see 2026-07-10 spec).
 *   - `pageTitle` snapshotted at trigger time (denormalized for history)
 */
import { nanoid } from 'nanoid'
import { and, eq, gt, inArray } from 'drizzle-orm'
import type { AuthenticatedUser } from '../auth/session'
import { notifications, userWatchedPages } from '../db/schema'
import type { db } from '../db/client'

export type NotificationKind =
  | 'mention'
  | 'reply'
  | 'comment_on_my_page'
  | 'page_like'
  // M13 watch fanout kinds
  | 'page_edit'
  | 'page_renamed'
  | 'page_moved'
  | 'page_restored'
  | 'page_deleted'
  | 'comment_add'

/** Subset of NotificationKind that flows through the watch fanout helper. */
export type WatchFanoutKind = Extract<
  NotificationKind,
  | 'page_edit'
  | 'page_renamed'
  | 'page_moved'
  | 'page_restored'
  | 'page_deleted'
  | 'comment_add'
>

/** 5 分钟去重窗口(2026-07-10 锁定 spec)。 */
const WATCH_FANOUT_DEDUP_WINDOW_MS = 5 * 60 * 1000

export interface EnqueueArgs {
  kind: NotificationKind
  actor: AuthenticatedUser
  pageId: string
  /** Page title snapshot — pass through from the trigger site. */
  pageTitle?: string | null
  /** Required for comment-derived kinds (mention/reply/comment_on_my_page).
   *  Pass `null` for `page_like` — likes are not tied to a comment. */
  commentId?: string | null
  /** Required for kind='mention'. Ignored for others. */
  mentionedUserIds?: string[]
  /** Required for kind='reply'. */
  parentAuthorId?: string | null
  /** Required for kind='comment_on_my_page' and kind='page_like'. */
  pageAuthorId?: string | null
}

export interface WatchFanoutArgs {
  kind: WatchFanoutKind
  actor: AuthenticatedUser
  pageId: string
  /** Page title snapshot — pass through from the trigger site. */
  pageTitle?: string | null
  /** Required —— 用于 comment_add 的 author dedup(避免作者同收两条
   *  comment_add + comment_on_my_page)。其它 kind 也无害,统一必填。 */
  pageAuthorId: string
  /** comment_add 必传(给通知"跳到 #comment-{id}"用);
   *  其它 kind 给 null。 */
  commentId?: string | null
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
  /** Comment row id for comment-derived kinds (mention/reply/comment_on_my_page);
   *  null for page_like (likes aren't tied to a comment). */
  commentId: string | null
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
          commentId: args.commentId ?? null,
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
          commentId: args.commentId ?? null,
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
          commentId: args.commentId ?? null,
          mentionUserId: null,
          isRead: false,
          createdAt: now,
        })
      }
      break
    }
    case 'page_like': {
      const target = args.pageAuthorId
      if (target && target !== args.actor.id) {
        rows.push({
          id: newNid(),
          userId: target,
          actorId: args.actor.id,
          kind: 'page_like',
          pageId: args.pageId,
          pageTitle: args.pageTitle ?? null,
          commentId: null,
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

/* ─── M13 watch fanout ───────────────────────────────────────────────
 *
 * 给「我关注了这个页」的所有人发通知(扣除 actor 自己 + comment_add 的
 * 作者去重 + 5 分钟去重)。被订阅页的 6 类事件统一走这里:
 *
 *   - page_edit      POST /:id/snapshots   (snapshot 边界 = 编辑边界)
 *   - page_renamed   PATCH /:id title 变更
 *   - page_moved     PATCH /:id/move
 *   - page_restored  POST /:id/restore
 *   - page_deleted   DELETE /:id 软删
 *   - comment_add    POST /api/comments 顶层
 *
 * 三层去重:
 *   1. actor 排除 —— 自己不通知自己
 *   2. comment_add 的 page author 排除 —— 作者走 comment_on_my_page(由
 *      comments.ts POST 的 enqueueNotifications 处理),不双发 comment_add
 *   3. 5 分钟同 (userId, pageId, kind, actorId) 去重 —— 该用户在最近
 *      5 分钟内已收过同一种通知的话跳过(避免 snapshot 边界 + auto-save
 *      双触发,或批量 rename / move 短时间内多次触发)
 *
 * 性能:
 *   - 走 user_watched_user_idx(user_id) 反向 → page_id
 *   - 5-min dedup 走 notifications_user_unread_idx 前缀(单 user 范围)
 *   - 一次往返完成 watch 查 + dedup 查 + insert(同 tx)
 */
export async function enqueueWatchFanout(
  tx: NotifyTx,
  args: WatchFanoutArgs,
): Promise<number> {
  const now = Date.now()

  // Step 1: 查所有 watcher — user_watched_pages 按 (page_id) 走 page_idx
  // 单列索引(N 表,N+1 一致)。
  const watchers = await tx
    .select({ userId: userWatchedPages.userId })
    .from(userWatchedPages)
    .where(eq(userWatchedPages.pageId, args.pageId))
  if (watchers.length === 0) return 0

  // Step 2: 排除 actor。Note:actor 是 disabled / 删账号时也走
  // `actor.id !== userId` 兜底,数据库那条 watcher 行可能因为 user
  // 被 sweep 而不存在,但 `actor` 本身是从 session 拿的合法值。
  const candidates = watchers
    .map((w) => w.userId)
    .filter((uid) => uid !== args.actor.id)
  if (candidates.length === 0) return 0

  // Step 3: 5-min dedup —— 查最近 5 分钟内同 (userId, pageId, kind, actorId)
  // 的现有通知,存在的 userId 跳过。NOT IN 风格:在 candidates 范围里做
  // 命中,避免扫全表。inArray(candidates) + eq(kind) + gt(createdAt) 走
  // notifications_page_idx + 时间范围扫,N+1 一致。
  const recent = await tx
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        inArray(notifications.userId, candidates),
        eq(notifications.pageId, args.pageId),
        eq(notifications.kind, args.kind),
        eq(notifications.actorId, args.actor.id),
        gt(notifications.createdAt, now - WATCH_FANOUT_DEDUP_WINDOW_MS),
      ),
    )
  const recentSet = new Set(recent.map((r) => r.userId))
  let fresh = candidates.filter((uid) => !recentSet.has(uid))
  if (fresh.length === 0) return 0

  // Step 4: comment_add author dedup —— page 作者只收 comment_on_my_page,
  // 由 comments.ts POST 路径处理,这里跳过避免双发。其它 kind 不去重
  // author(他们如果同时是 watcher,该收就收)。
  if (args.kind === 'comment_add' && args.pageAuthorId) {
    fresh = fresh.filter((uid) => uid !== args.pageAuthorId)
    if (fresh.length === 0) return 0
  }

  const rows = fresh.map((uid) => ({
    id: newNid(),
    userId: uid,
    actorId: args.actor.id,
    kind: args.kind,
    pageId: args.pageId,
    pageTitle: args.pageTitle ?? null,
    // comment_add 才有 commentId —— "跳到 #comment-{id}" 用。其它 kind
    // 一律 null(snapshots / move / restore / delete 都是 page-level 事件,
    // 没有 comment anchor)。
    commentId: args.kind === 'comment_add' ? (args.commentId ?? null) : null,
    mentionUserId: null,
    isRead: false,
    createdAt: now,
  }))

  await tx.insert(notifications).values(rows)
  return rows.length
}
