/**
 * Drizzle schema for power-wiki's Postgres database.
 *
 * Stage 4 + Stage 5 scope: pages + users + sessions + user_groups +
 * user_group_members + spaces + space_group_access +
 * Stage 6: comments + notifications.
 *
 * Naming convention:
 *   - DB columns: snake_case (matches Postgres convention)
 *   - TS fields:  camelCase (matches the shared types in packages/shared)
 *
 * Timestamps (`created_at`, `updated_at`) are stored as bigint in milliseconds since epoch.
 * bigint mode 'number' gives JS number (safe up to 2^53 ms ≈ year 287396).
 *
 * ─── NO foreign key constraints (hard project rule) ──────────────────
 * Per user constraint (see CLAUDE.md "硬约束"), this schema does NOT declare
 * any `.references()`. Relations are tracked in app code; cascade deletes
 * happen explicitly in route handlers (e.g. adminGroups DELETE cleans up
 * `user_group_members` + `space_group_access` before deleting the group).
 *
 * `pages.author_id` is also a free-form string by design — older seed pages
 * may have authorId='me' which isn't a real user id, and the frontend renders
 * whatever string is there.
 *
 * Stage 6 (comments / notifications): same no-FK rule. The cascade graph for
 * page purge is handled in apps/api/src/routes/pages.ts DELETE via a single
 * recursive CTE — page subtree + its comments + its notifications all wipe
 * in one statement.
 */

import type { TiptapJSON } from '@power-wiki/shared'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/* ─────────────────────────────────────────────────────────────────
 *  Users / Auth
 * ───────────────────────────────────────────────────────────────── */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  status: text('status', { enum: ['active', 'disabled', 'must_reset_password'] })
    .notNull()
    .default('must_reset_password'),
  color: text('color').notNull().default('#0052CC'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastLoginAt: bigint('last_login_at', { mode: 'number' }),
})

export const sessions = pgTable(
  'sessions',
  {
    /** nanoid(32) — the session token, also stored in the HTTP-only cookie */
    id: text('id').primaryKey(),
    /** No FK — cleanup is handled by session.ts (killSessionsForUser on disable / reset). */
    userId: text('user_id').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/* ─────────────────────────────────────────────────────────────────
 *  User Groups
 * ───────────────────────────────────────────────────────────────── */

export const userGroups = pgTable('user_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

export const userGroupMembers = pgTable(
  'user_group_members',
  {
    /** No FK — cleanup is handled by adminGroups DELETE (explicit). */
    groupId: text('group_id').notNull(),
    /** No FK — disabled/removed users get their memberships swept by app code if needed. */
    userId: text('user_id').notNull(),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('ugm_user_idx').on(t.userId),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Spaces
 * ───────────────────────────────────────────────────────────────── */

export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#0052CC'),
  icon: text('icon'),
  /**
   * 'shared' (团队空间) | 'personal' (个人空间,每用户一个,ownerId 指向 users.id).
   * 老行默认 'shared',由 0004 migration 补默认值。
   */
  kind: text('kind', { enum: ['personal', 'shared'] }).notNull().default('shared'),
  /**
   * 仅 kind='personal' 有意义,指向 users.id;nullable(团队空间为 null)。
   * No FK — 禁用/删除用户不级联(由 admin bypass 维持 admin 可读)。
   */
  ownerId: text('owner_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const spaceGroupAccess = pgTable(
  'space_group_access',
  {
    /** No FK — cleanup is handled by adminSpaces DELETE (explicit). */
    spaceId: text('space_id').notNull(),
    /** No FK — cleanup is handled by adminGroups DELETE (explicit). */
    groupId: text('group_id').notNull(),
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.groupId] })],
)

/* ─────────────────────────────────────────────────────────────────
 *  Pages
 * ───────────────────────────────────────────────────────────────── */

export const pages = pgTable(
  'pages',
  {
    id: text('id').primaryKey(),

    /**
     * Parent page id, NULL = top-level.
     * No FK — descendant cleanup happens in pages.ts DELETE via a recursive CTE
     * (one statement, same roundtrip cost as the old FK cascade).
     */
    parentId: text('parent_id'),

    /**
     * Space id (Stage 4+). Nullable at the DB level for migration safety, but every new
     * page MUST have a spaceId (POST /api/pages validates). bootstrap.ts backfills
     * existing rows to the default space on first boot after the schema migration.
     *
     * No FK — pages survive a deleted space (UI just shows them as orphans; admin
     * can delete the space only when empty anyway).
     */
    spaceId: text('space_id'),

    title: text('title').notNull().default(''),
    contentJson: jsonb('content_json').$type<TiptapJSON>().notNull().default({}),
    contentHtml: text('content_html').notNull().default(''),
    icon: text('icon'),

    /** Sibling sort order, lower comes first. */
    sortOrder: integer('sort_order').notNull().default(0),

    /** Date.now() ms — see header comment for why bigint-mode-number. */
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),

    /**
     * User id of the creator. Free-form string — see header comment.
     */
    authorId: text('author_id').notNull().default('me'),

    starred: boolean('starred').notNull().default(false),

    /**
     * Stage 5 soft-delete. NULL = live page; non-NULL = trashed.
     * `deleted_by` records who moved it (admin restores via /api/pages/:id/restore;
     * purge via DELETE /api/pages/:id?purge=true). No FK — see header rule.
     */
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    deletedBy: text('deleted_by'),
  },
  (table) => [
    index('pages_parent_idx').on(table.parentId),
    index('pages_parent_order_idx').on(table.parentId, table.sortOrder),
    index('pages_space_idx').on(table.spaceId),
    index('pages_trash_idx').on(table.spaceId, table.deletedAt),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Comments — Stage 6
 *  Top-level + 1-level replies (parentId nullable). Markdown v0; the
 *  content_text snapshot is what the notification preview shows.
 *  Soft-deletable; writes are gated by canAccessSpace + the admin
 *  personal-space guard (see lib/comments/guards.ts).
 * ───────────────────────────────────────────────────────────────── */

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),

    /** No FK — cascade from page is handled in pages.ts DELETE (recursive CTE). */
    pageId: text('page_id').notNull(),

    /** No FK — replies nest 1 level deep (top-level comments only have replies,
     *  replies have no replies of their own in v0; further nesting dropped). */
    parentId: text('parent_id'),

    /** No FK — authorId may be a free-form legacy id like 'me'; UI handles it. */
    authorId: text('author_id').notNull(),

    /** Markdown body. v0 has no toolbar; the composer is plain markdown. */
    contentMd: text('content_md').notNull(),

    /** Plain-text snapshot of content_md (markdown stripped). Stored on write so
     *  notification previews don't have to re-parse markdown at render time. */
    contentText: text('content_text').notNull(),

    /** The ONLY source of truth for "@userId" mentions on this comment.
     *  Notifications are generated from this column via enqueueNotifications();
     *  this avoids the alternative of a mentions sub-table while keeping the
     *  trigger logic read-once simple. Vulnerability: concurrent PATCH of two
     *  different mentions is last-write-wins — accepted for v0 (rare case). */
    mentionedUserIds: jsonb('mentioned_user_ids')
      .$type<string[]>()
      .notNull()
      .default([]),

    isEdited: boolean('is_edited').notNull().default(false),
    editedAt: bigint('edited_at', { mode: 'number' }),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),

    /** Soft delete — author or admin may delete; the row stays so existing
     *  notifications pointing at it don't lose their anchor (UI degrades to
     *  page-level link if comment_id no longer resolves). */
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    deletedBy: text('deleted_by'),
  },
  (t) => [
    index('comments_page_idx').on(t.pageId, t.createdAt),
    index('comments_parent_idx').on(t.parentId),
    index('comments_author_idx').on(t.authorId),
    index('comments_page_live_idx').on(t.pageId, t.deletedAt),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Notifications — Stage 6
 *  One row per (recipient, event). Three event kinds:
 *    - 'mention'           → recipient was @mentioned in a comment
 *    - 'reply'             → recipient's comment got a reply
 *    - 'comment_on_my_page'→ recipient is the page author; a top-level
 *                            comment was added
 *  Reads are filtered by userId === current user; there is no admin
 *  bypass. 30s poll for unread-count on the frontend (see
 *  composables/useNotifications.ts); SSE is v0.1.
 * ───────────────────────────────────────────────────────────────── */

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),

    /** recipient — notification is private; NEVER queryable by anyone else. */
    userId: text('user_id').notNull(),

    /** actor — the person whose action triggered this notification
     *  (LEFT JOIN users on read to populate actorName/actorColor). */
    actorId: text('actor_id').notNull(),

    kind: text('kind', {
      enum: ['mention', 'reply', 'comment_on_my_page'],
    }).notNull(),

    /** Landing target — clicking the notification jumps to /p/{pageId}
     *  with optional #comment-{commentId} hash. */
    pageId: text('page_id').notNull(),
    /** Snapshot of the page title at trigger time — renamed pages don't
     *  retroactively rewrite notification history (Slack/Discord behavior). */
    pageTitle: text('page_title'),

    /** null for kind='comment_on_my_page' is possible but we always carry it
     *  to keep "jump to comment" UX consistent. */
    commentId: text('comment_id'),

    /** Filled only for kind='mention' — equals one of the mentioned_user_ids
     *  in the triggering comment. Null for reply / comment_on_my_page. */
    mentionUserId: text('mention_user_id'),

    isRead: boolean('is_read').notNull().default(false),
    readAt: bigint('read_at', { mode: 'number' }),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    /** Hot path for the bell badge: WHERE user_id=? AND is_read=false. */
    index('notifications_user_unread_idx').on(t.userId, t.isRead, t.createdAt),
    /** Hot path for the notifications list page (ORDER BY created_at DESC). */
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    /** Cascade path: page purge scans notifications WHERE page_id IN subtree. */
    index('notifications_page_idx').on(t.pageId),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Page versions — Stage 8 (history / version compare)
 *
 *  One row per PATCH that mutates content (title / contentJSON /
 *  contentHTML / icon). starred-only PATCHes do NOT create a version
 *  (metadata, not content). v0 retention = keep the latest 30 per page;
 *  older rows are pruned in the same transaction that inserts the new
 *  version (see apps/api/src/routes/pageVersions.ts + pages.ts PATCH).
 *
 *  No FK — page hard-delete wipes this table by page_subtree, same
 *  pattern as comments / notifications.
 * ───────────────────────────────────────────────────────────────── */
export const pageVersions = pgTable(
  'page_versions',
  {
    id: text('id').primaryKey(),
    /** No FK — page hard-delete cleans up explicitly. */
    pageId: text('page_id').notNull(),
    /** Monotonic per-page version number (1, 2, 3 …). Computed in the
     *  route as MAX(versionNumber) + 1 inside a transaction; the unique
     *  index below is the concurrency guard. */
    versionNumber: integer('version_number').notNull(),
    /** Snapshot of editable fields at the time of this PATCH. */
    title: text('title').notNull().default(''),
    contentJson: jsonb('content_json').$type<TiptapJSON>().notNull().default({}),
    contentHtml: text('content_html').notNull().default(''),
    icon: text('icon'),
    /** Free-form author id (matches pages.author_id). */
    editedBy: text('edited_by').notNull(),
    /** Date.now() ms — when the PATCH landed. */
    editedAt: bigint('edited_at', { mode: 'number' }).notNull(),
    /** Optional user-supplied changelog (e.g. "fixed typo in section 2").
     *  Auto-set on restore ("restored from v{N}") but v0 has no UI to
     *  type one for normal edits. */
    changeNote: text('change_note'),
  },
  (t) => [
    /** Hot path: list versions of one page, newest first. */
    index('page_versions_page_idx').on(t.pageId, t.versionNumber),
    /** Concurrency guard: PATCH handler relies on a unique (page, version)
     *  pair to prevent two parallel PATCHes from minting the same number. */
    uniqueIndex('page_versions_page_version_uq').on(t.pageId, t.versionNumber),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Page labels — Stage 8
 *
 *  Global, free-form labels (Notion-style, not Confluence-style
 *  namespaces). One row per (page, label) pair — composite PK = idempotent
 *  add. Same label can be on N pages, same page can have N labels.
 *
 *  Scope is global by design: labels/search joins against the user's
 *  accessible pages so a label like "工程" can surface pages from any
 *  team space the user has access to.
 *
 *  Storage: lowercase + trimmed + ≤32 chars (server normalizes; reject
 *  otherwise). Case display follows storage (Notion-style).
 *
 *  No FK — page hard-delete wipes this table by page_subtree, same
 *  pattern as comments / notifications.
 * ───────────────────────────────────────────────────────────────── */
export const pageLabels = pgTable(
  'page_labels',
  {
    /** No FK — page hard-delete cleans up explicitly. */
    pageId: text('page_id').notNull(),
    /** Lowercased + trimmed, ≤32 chars. Free-form string. */
    label: text('label').notNull(),
    /** No FK — authorId may be a free-form legacy id like 'me'; UI handles it. */
    authorId: text('author_id').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    /** Composite PK = one label per (page, label) — idempotent add. */
    primaryKey({ columns: [t.pageId, t.label] }),
    /** Hot path: search by label, scoped to accessible pages. */
    index('page_labels_label_idx').on(t.label),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Page templates — Stage 8
 *
 *  Reusable page skeletons. spaceId null = global template (visible
 *  to everyone); set = space-scoped (visible to space members + admin
 *  bypass). Seeding: bootstrap.ts installs 5 built-ins on first run
 *  (idempotent — checks for existence by title before insert).
 *  Built-ins: 空白 / 会议纪要 / RFC / SOP / 周报.
 *
 *  No FK — space hard-delete wipes this table by spaceId in the
 *  adminSpaces DELETE transaction.
 * ───────────────────────────────────────────────────────────────── */
export const pageTemplates = pgTable(
  'page_templates',
  {
    id: text('id').primaryKey(),
    /** Null = global template (visible to everyone).
     *  Set = space-scoped (visible to space members + admin). */
    spaceId: text('space_id'),
    title: text('title').notNull(),
    description: text('description'),
    /** Tiptap doc + HTML snapshot (contentHTML is pre-sanitized for v-html). */
    contentJson: jsonb('content_json').$type<TiptapJSON>().notNull().default({}),
    contentHtml: text('content_html').notNull().default(''),
    icon: text('icon'),
    /** Built-in flag: bootstrap-installed templates can't be deleted by
     *  users; admin can override (but bootstrap never re-inserts). */
    isBuiltIn: boolean('is_built_in').notNull().default(false),
    /** No FK — disabled users get their templates left as-is (orphan authorId
     *  is handled in the UI like other free-form id references). */
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('page_templates_space_idx').on(t.spaceId)],
)

/* ─────────────────────────────────────────────────────────────────
 *  Row types
 * ───────────────────────────────────────────────────────────────── */

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert
export type UserGroupRow = typeof userGroups.$inferSelect
export type NewUserGroupRow = typeof userGroups.$inferInsert
export type SpaceRow = typeof spaces.$inferSelect
export type NewSpaceRow = typeof spaces.$inferInsert
export type PageRow = typeof pages.$inferSelect
export type NewPageRow = typeof pages.$inferInsert
export type CommentRow = typeof comments.$inferSelect
export type NewCommentRow = typeof comments.$inferInsert
export type NotificationRow = typeof notifications.$inferSelect
export type NewNotificationRow = typeof notifications.$inferInsert
export type PageVersionRow = typeof pageVersions.$inferSelect
export type NewPageVersionRow = typeof pageVersions.$inferInsert
export type PageLabelRow = typeof pageLabels.$inferSelect
export type NewPageLabelRow = typeof pageLabels.$inferInsert
export type PageTemplateRow = typeof pageTemplates.$inferSelect
export type NewPageTemplateRow = typeof pageTemplates.$inferInsert
