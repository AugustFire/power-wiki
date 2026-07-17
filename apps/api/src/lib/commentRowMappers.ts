/**
 * snake_case row → camelCase Comment / Notification mappers.
 *
 * Stage 6: comments + notifications.
 *
 * Mirror pattern of `rowMappers.ts`. Each mapping function takes a DB row
 * (+ optional LEFT JOIN-aggregated display fields) and returns the camelCase
 * DTO that the `CommentSchema` / `NotificationSchema` accepts. The route
 * handlers then `Schema.parse(...)` at the response boundary.
 */
import type { CommentRow, NotificationRow, SpaceRow } from '../db/schema'
import type { Comment, Notification } from '@power-wiki/shared'

/** mentions column comes from Drizzle as the inferred JSONB type. We always
 *  emit it as a plain `string[]` so consumers don't have to coerce. */
function asMentionedUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/**
 * CommentRow + author info from LEFT JOIN users → Comment DTO.
 *
 * `authorName` / `authorColor` are nullable on purpose: legacy comment rows
 * with authorId='me' or rows where the user has been disabled should render
 * with a fallback avatar in the UI.
 *
 * `authorAvatarKind` / `authorAvatarRef` 同步透传(M11 头像三态);前端
 * 当前按设计 CommentItem 不显示头像,但 DTO 带齐字段便于未来启用。
 */
export function rowToComment(
  row: CommentRow,
  opts: {
    authorName?: string | null
    authorColor?: string | null
    authorAvatarKind?: string | null
    authorAvatarRef?: string | null
  } = {},
): Comment {
  return {
    id: row.id,
    pageId: row.pageId,
    parentId: row.parentId ?? null,
    authorId: row.authorId,
    contentMd: row.contentMd,
    contentText: row.contentText,
    mentionedUserIds: asMentionedUserIds(row.mentionedUserIds),
    isEdited: row.isEdited,
    editedAt: row.editedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    authorName: opts.authorName ?? null,
    authorColor: opts.authorColor ?? null,
    authorAvatarKind: (opts.authorAvatarKind as Comment['authorAvatarKind']) ?? null,
    authorAvatarRef: opts.authorAvatarRef ?? null,
  }
}

/**
 * NotificationRow + actor info → Notification DTO.
 * `pageTitle` snapshot in the row is already the historical title;
 * no LEFT JOIN on pages is necessary (rows may outlive the page — purge).
 *
 * `actorName` / `actorColor` mirror the comment pattern.
 *
 * `actorAvatarKind` / `actorAvatarRef` 同步透传(M11 头像三态);NotificationBell
 * 用真实头像替换手写首字母圆。
 */
export function rowToNotification(
  row: NotificationRow,
  opts: {
    actorName?: string | null
    actorColor?: string | null
    actorAvatarKind?: string | null
    actorAvatarRef?: string | null
  } = {},
): Notification {
  return {
    id: row.id,
    userId: row.userId,
    actorId: row.actorId,
    actorName: opts.actorName ?? null,
    actorColor: opts.actorColor ?? null,
    actorAvatarKind: (opts.actorAvatarKind as Notification['actorAvatarKind']) ?? null,
    actorAvatarRef: opts.actorAvatarRef ?? null,
    kind: row.kind,
    pageId: row.pageId,
    pageTitle: row.pageTitle ?? null,
    commentId: row.commentId ?? null,
    mentionUserId: row.mentionUserId ?? null,
    isRead: row.isRead,
    readAt: row.readAt ?? null,
    createdAt: row.createdAt,
  }
}

/** Re-export of SpaceRow mapper-style helper.
 *
 *  Notifications reference a page whose space is sometimes needed (e.g. admin
 *  debug endpoints or future "go-to-space" links). This re-export keeps
 *  consumers from having to know `rowToSpace` lives in `rowMappers.ts`.
 */
export type { SpaceRow }
