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
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/* ─────────────────────────────────────────────────────────────────
 *  Users / Auth
 * ───────────────────────────────────────────────────────────────── */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  /** argon2id 密码哈希(@node-rs/argon2,见 apps/api/src/auth/password.ts)。
   *  格式 `$argon2id$v=19$m=...,t=...,p=...$salt$hash`。登录时 verifyPassword
   *  常量时间校验,不要在这里做字符串比较或 decode。 */
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  /**
   * 账号状态 4 态(M16):
   *   - 'active'              正常,可登录可操作
   *   - 'disabled'            admin 临时禁用;enable 端点可恢复
   *   - 'must_reset_password' 新建/重置密码后待首次重设
   *   - 'anonymized'          admin 匿名化(不可逆),name/email/password/
   *                           avatar 全清,sweep 见 adminUsers.ts anonymize
   *                           handler。enable 端点拒绝(409 invalid_state)。
   * CHECK users_status_check 限定 4 态(迁移 0030 加)。
   * 早期代码靠 name='已注销用户' 作为 anonymized 的 sentinel string;
   * M16 起 status 字段即是事实来源,sentinel 仅作渲染兜底。
   */
  status: text('status', {
    enum: ['active', 'disabled', 'must_reset_password', 'anonymized'],
  })
    .notNull()
    .default('must_reset_password'),
  color: text('color').notNull().default('#0052CC'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastLoginAt: bigint('last_login_at', { mode: 'number' }),
  /**
   * 头像形态:NULL(默认,用 initials+color)/'preset'(静态预制,前端通过
   * GET /api/avatars/presets 运行时扫 apps/web/public/avatars/ 动态发现
   * slug,不写死)/'custom'(用户自定义上传,MinIO,元数据见 user_avatars 表)。
   * 三态互斥,DB CHECK users_avatar_kind_check + users_avatar_consistency_check
   * 限定合法值与 avatar_ref 同 NULL/同非 NULL,迁移 0022 加。M11 v2 起
   * preset 不再依赖 AVATAR_PRESETS enum(原 shared/constants 常量已删)。
   */
  avatarKind: text('avatar_kind'),
  /**
   * 头像引用:与 avatar_kind 同 NULL/同非 NULL。'preset' 存 slug
   * (后端 z.string 校验格式,不限 enum,文件不存在时前端 <img @error>
   * 兜底回 initials);'custom' 存 user_avatars.id。NULL 时整段不渲染
   * 头像图片,只走 initials+color。
   */
  avatarRef: text('avatar_ref'),
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

/**
 * @deprecated Phase A.5 起停止写入。新授权一律走 space_role_grants,
 *  并由 lib/permissions.migrateLegacyGroupGrant 在写入时把同 (space,
 *  group) 的 legacy 行就地迁入新表(role='editor',同事务 DELETE 本表)。
 *
 *  代码路径仍读取本表(effectiveSpaceRole UNION ALL、loadGrantsForSpace
 *  NOT EXISTS 互补去重),作为短期 fallback —— 既保留旧行为(legacy 行
 *  视为 'editor',最宽松)又给全量迁移留窗口。本表没有任何新写入入口:
 *  - adminSpaces 三个 PUT/POST/DELETE /access[/:groupId] 端点已加
 *    @deprecated + console.warn,保留仅作 rollback 安全网;
 *  - spacePermissions 写入路径全部走 space_role_grants,经 helper
 *    DELETE 本表对应行。
 *
 *  全量收尾(follow-up migration job)任务:扫剩余 legacy 行
 *  bulk insert 进 space_role_grants role='editor',DROP 本表 + 唯一索引。
 */
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

    /**
     * 最近编辑者 user id(P1-3 活动流的数据来源)。
     * 每次 PATCH / move / restore 都同步更新。无 FK — disabled / deleted
     * users 的行保留不动(UI 派生时 LEFT JOIN users,缺 name/color 用 null 渲染)。
     * 老存量行在 0012 migration 里 backfill 成 author_id。
     */
    updatedBy: text('updated_by'),

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
    index('pages_updated_by_idx').on(table.updatedBy),
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
 *  Notifications — Stage 6 + M13
 *  One row per (recipient, event). Ten event kinds:
 *    Stage 6(既有):
 *    - 'mention'           → recipient was @mentioned in a comment
 *    - 'reply'             → recipient's comment got a reply
 *    - 'comment_on_my_page'→ recipient is the page author; a top-level
 *                            comment was added
 *    - 'page_like'         → recipient is the page author; someone liked
 *                            their page (POST /api/pages/:id/like)
 *
 *    M13 watch fanout(新增):
 *    - 'page_edit'         → snapshot 边界(idle 30s 自动 / 手动)通知全部 watcher
 *    - 'page_renamed'      → title PATCH 通知全部 watcher
 *    - 'page_moved'        → parentId / spaceId 变化通知全部 watcher
 *    - 'page_restored'     → 回收站还原通知全部 watcher
 *    - 'page_deleted'      → 软删通知全部 watcher(30 天内可还原)
 *    - 'comment_add'       → 顶层评论插入通知全部 watcher;
 *                            page 作者去重为 comment_on_my_page(避免双发)
 *
 *  fanout 规则:
 *    - actor != user_id(自己不通知自己)
 *    - 5 分钟同页同 actor 多事件去重(应用层 enqueueNotifications 内合并)
 *    - mention / page_like 不在 watch fanout 路径里触发(避免与既有 kind 双发)
 *
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
      enum: [
        // 既有四种(Stage 6):mention / reply / comment_on_my_page / page_like
        'mention',
        'reply',
        'comment_on_my_page',
        'page_like',
        // M13 watch fanout 新增:被 watch 的页面发生事件时,通知所有 watcher(排除 actor 自己)
        // - page_edit       :snapshot 边界(idle 30s 自动 / 手动 snapshot)
        // - page_renamed    :title PATCH
        // - page_moved      :parentId / spaceId 变化
        // - page_restored   :回收站还原
        // - page_deleted    :软删
        // - comment_add     :顶层评论插入;page 作者去重为 comment_on_my_page,避免双发
        'page_edit',
        'page_renamed',
        'page_moved',
        'page_restored',
        'page_deleted',
        'comment_add',
      ],
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
 *  contentHTML / icon). metadata-only PATCHes (e.g. labels, future
 *  watch/unwatch 之外的非内容字段)do NOT create a version. v0 retention
 *  = keep the latest 30 per page;
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
 *  Attachments — 页面级附件(image/* + application/pdf)
 *
 *  一行 = 一个上传文件,归属单一 page。文件字节存 MinIO/S3,DB 只存元数据。
 *  上传走 presigned PUT(浏览器直传 MinIO),下载走 API 流式代理
 *  (`GET /api/attachments/:id/raw`)。S3 object key 格式:{page_id}/{id}{ext}。
 *
 *  No FK — page hard-delete 时由 pages.ts DELETE 递归 CTE 同事务清理 attachments
 *  行,并在事务外 best-effort 删 S3 对象(DB 是事实来源,orphan 对象容忍)。
 * ───────────────────────────────────────────────────────────────── */
export const attachments = pgTable(
  'attachments',
  {
    /** nanoid(12) — 附件 id,也是 S3 object key 的第二段。 */
    id: text('id').primaryKey(),
    /** 所属页面 id。No FK,page purge 时显式清掉。 */
    pageId: text('page_id').notNull(),
    /** 上传者 user id。No FK。 */
    uploaderId: text('uploader_id').notNull(),
    /** 用户上传时的原始文件名(展示用),≤255 字符。 */
    originalFilename: text('original_filename').notNull(),
    /** S3 object key,格式 {page_id}/{id}{ext}。 */
    storageKey: text('storage_key').notNull(),
    /** MIME 类型;上传前已校验为 ALLOWED_MIME_TYPES 之一。 */
    mimeType: text('mime_type').notNull(),
    /** 文件字节数;由 HeadObject 验证写入(不信前端 size)。≤ MAX_UPLOAD_BYTES。 */
    sizeBytes: integer('size_bytes').notNull(),
    /** 'image'(image/* mime)或 'file'(application/pdf 等)。决定编辑器 /
     *  read view 渲染 image 节点还是 file 卡片。 */
    kind: text('kind', { enum: ['image', 'file'] }).notNull(),
    /** Date.now() 毫秒,上传时间。 */
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('attachments_page_idx').on(table.pageId, table.createdAt),
    index('attachments_uploader_idx').on(table.uploaderId),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  User avatars — 用户自定义头像对象(MinIO/S3)
 *
 *  一行 = 一个用户的一张自定义头像。文件字节存 MinIO/S3,DB 只存元数据。
 *  与 page attachments 独立:本表没有 pageId 维度,不挂在任何页面下。
 *  raw 端点 GET /api/user-avatars/:userId/raw(走 Hono 流式代理)从 S3 流
 *  出 bytes;S3 object key 格式:users/{userId}/{avatarId}{ext}。
 *
 *  No FK — 用户禁用/删除时不级联,由 admin 路由 DELETE user 时显式清理
 *  (同步删本表 row + best-effort deleteObject)。
 *
 *  write-time lazy cleanup:用户多次上传不切换时,finalize 路径会 INSERT
 *  后 DELETE WHERE user_id=me AND id!=new,长期收敛到每用户 ≤ 1 active row。
 *  PATCH /me 切到 preset/null 时同步清当前 ref 行的 row + S3 对象。
 * ───────────────────────────────────────────────────────────────── */
export const userAvatars = pgTable(
  'user_avatars',
  {
    /** nanoid(12),与 attachments id 风格一致,也是 S3 object key 第二段。 */
    id: text('id').primaryKey(),
    /** 用户 id。No FK — 禁用/删除用户不级联,由 app 端 DELETE 用户时清理。 */
    userId: text('user_id').notNull(),
    /** S3 bucket key,例如 users/u_xxx/abc.png。 */
    bucketKey: text('bucket_key').notNull(),
    /** MIME 类型;落库时已在白名单 image/{png,jpeg,webp,gif}。 */
    mime: text('mime').notNull(),
    /** 文件字节数;HeadObject 验证写入(不信前端 size)。 ≤ AVATAR_UPLOAD_MAX_BYTES(5MB)。 */
    sizeBytes: integer('size_bytes').notNull(),
    /** 落库图宽(像素),≤ AVATAR_TARGET_DIM(256)。前端 canvas resize 后给到后端。 */
    width: integer('width').notNull(),
    /** 落库图高(像素),≤ AVATAR_TARGET_DIM(256)。 */
    height: integer('height').notNull(),
    /** Date.now() 毫秒,上传时间。 */
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    /** 「我的最新头像」索引 — finalize 写后 cleanup 路径走这里。 */
    index('user_avatars_user_idx').on(table.userId, table.createdAt),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Page likes — 顶栏 👍
 *
 *  一行 = 一个用户对一页的一次点赞。Toggle 语义:后端先 SELECT,
 *  存在就 DELETE,不在就 INSERT;不需要单独 DELETE endpoint,前端也不需要
 *  "unliked" 标志。复合主键 (page_id, user_id) 保证幂等(同一用户
 *  对同一页面重复 INSERT 会撞 PK 报 23505,我们 SELECT-then-INSERT 避免)。
 *
 *  跟 page_labels 一样:No FK,page hard-delete 时由 pages.ts DELETE
 *  递归 CTE 显式清理(见 apps/api/src/routes/pages.ts DELETE?purge=true)。
 *
 *  索引:
 *  - 主键 (page_id, user_id):直接给"该页有多少赞 / 该用户赞过没"用
 *  - page_likes_page_idx (page_id 单独):"某页点赞数"是用 COUNT(*) 算的,
 *    group by 主键前缀就够快了,这个索引主要是和 page_labels 的命名对齐
 *    + 心智模型一致(每个 page-* join 表都建 page_id 单列索引)。
 *  - page_likes_user_idx (user_id):未来"我赞过哪些页面"用。
 * ───────────────────────────────────────────────────────────────── */
export const pageLikes = pgTable(
  'page_likes',
  {
    /** No FK — page hard-delete cleans up explicitly. */
    pageId: text('page_id').notNull(),
    /** No FK — disabled/deleted users get their rows swept by app code if needed. */
    userId: text('user_id').notNull(),
    /** Date.now() 毫秒,点赞时间。当前端不需要显示具体点赞时间时这个字段
     *  仅供 audit / 排序用。 */
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    /** Composite PK = one like per (page, user) — idempotent. */
    primaryKey({ columns: [t.pageId, t.userId] }),
    /** 单列 page_id 索引 — selectPagesWithAuthor 的 likesCount correlated
     *  subquery 走这里(避免全表扫描 COUNT(*))。跟 page_labels 的
     *  page_id 单列索引命名 + 心智模型对齐:每个 page-* join 表都建
     *  page_id 单列索引。 */
    index('page_likes_page_idx').on(t.pageId),
    /** Future: "我赞过哪些页面" — 直接走 user_id 即可。 */
    index('page_likes_user_idx').on(t.userId),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Page watched — M13 关注(👁 visibility)
 *
 *  一行 = 一个用户对一页的关注订阅。Toggle 语义:跟 page_likes 一样,
 *  后端先 SELECT,存在就 DELETE,不在就 INSERT。复合主键 (page_id, user_id)
 *  保证幂等;前端 toggle 后端同一个 endpoint 即可,无需 DELETE 单独路径。
 *
 *  与 page_likes 的关键区别:
 *   - watched 触发 6 类通知 fanout(page_edit / renamed / moved /
 *     restored / deleted / comment_add),见 notifications 表注释。
 *   - page_deleted 不删 user_watched_pages 行:restore 后用户仍是
 *     watch 状态(避免还原后忘记重新关注)。
 *
 *  索引设计跟 page_likes 对齐:
 *   - 主键 (page_id, user_id):直接给"该页有多少人关注 / 该用户
 *     是否关注"用。
 *   - user_watched_user_idx (user_id):"我关注的页面"列表走这里,
 *     倒序按 watched_at DESC。M13 Sidebar "我的关注" section 也走
 *     这个索引。
 *
 *  No FK — page hard-delete 时由 pages.ts DELETE 递归 CTE 显式清理
 *  user_watched_pages 行(见 apps/api/src/routes/pages.ts DELETE?purge=true)。
 * ───────────────────────────────────────────────────────────────── */
export const userWatchedPages = pgTable(
  'user_watched_pages',
  {
    /** No FK — page hard-delete cleans up explicitly. */
    pageId: text('page_id').notNull(),
    /** No FK — disabled/deleted users get their rows swept by app code if needed. */
    userId: text('user_id').notNull(),
    /** Date.now() 毫秒,watch 时间。Sidebar / Dashboard 排序按 DESC 走这个字段。 */
    watchedAt: bigint('watched_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    /** Composite PK = one watch per (page, user) — idempotent. */
    primaryKey({ columns: [t.pageId, t.userId] }),
    /** "我关注了哪些页面" 走 user_id 索引;Sidebar/Dashboard 主路径。 */
    index('user_watched_user_idx').on(t.userId),
    /** 单列 page_id 索引 — "该页多少人关注" 用 COUNT(*),跟 page_likes
     *  page_id 单列索引命名 + 心智模型对齐。 */
    index('user_watched_page_idx').on(t.pageId),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Admin settings — P1-8 回收站保留期
 *
 *  key-value 表,只存全局 admin 配置。当前唯一 key:
 *    - `trash_retention_days`:回收站过期天数(数字字符串)。
 *      - `0` = 永不清理(等价 v0 行为,但仍走 lazy purge 路径;
 *        lazy 看到 0 直接 no-op,跳过 DELETE)
 *      - `30` = 默认
 *      - 大于 0 的整数 = 该天数
 *
 *  设计理由:
 *    - 单表 key-value 而不是「每个 setting 一列」,未来加 settings
 *      (登录失败锁定阈值、附件大小上限等)不用动 schema。
 *    - 不强制每行存在:`trash_retention_days` 缺失时 lib/retention.ts
 *      直接 fallback 30 天,0013 migration 也 seed 缺省值。
 *  No FK — 改 admin 不会触发 settings 行级联。
 * ───────────────────────────────────────────────────────────────── */

export const adminSettings = pgTable('admin_settings', {
  /** Setting key,e.g. 'trash_retention_days'.作为唯一主键。 */
  key: text('key').primaryKey(),
  /** 字符串值(数字也以字符串存,frontend 自行 parseInt / parseFloat)。
   *  JSON 不上 — 简单 key-value 没有嵌套需求。 */
  value: text('value').notNull(),
  /** 最后更新时间 ms。admin 改后端 PATCH 时刷新。 */
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  /** No FK — admin 删账号不级联 settings(配置是 workspace 级)。 */
  updatedBy: text('updated_by'),
})

/* ─────────────────────────────────────────────────────────────────
 *  user_recent_pages — M2 服务端「最近浏览」(cross-device 同步)
 *
 *  之前 power-wiki 用 localStorage 记最近浏览,换浏览器 / 清除缓存就丢。
 *  M2 改成服务端持久化:每用户对每页面最多一行 recent,visited_at 滚动更新。
 *
 *  关键约束:
 *   - **per-user 隔离**:PK (user_id, page_id)。其他人的浏览历史不影响。
 *   - **title 冗余存**:page 删了之后 recent 行仍有意义(「我看过 X」),
 *     不需要 LEFT JOIN pages 也能渲染历史列表;同时避开「删了 page
 *     但 recent 行留下孤儿 page_id」的体验空洞。`read` 路径仍走
 *     `SELECT ... JOIN pages` 拿最新元数据,title 兜底。
 *   - **page hard-delete 清 recent**:同 user_watched_pages 心智模型,
 *     pages.ts DELETE 递归 CTE 同事务清理;soft_delete (deletedAt)
 *     保留,restore 后 recent 历史不丢。
 *   - **TTL**:90 天前的 visited_at 由 read 路径 lazy 清理(无 cron) —
 *     跟 page_events 不一样,recent 不需要永久保留。
 *   - **No FK** —— CLAUDE.md 硬约束。page hard-delete 走显式 DELETE。
 *
 *  索引:
 *   - (user_id, visited_at DESC)复合:list 主路径 ORDER BY + LIMIT,无需
 *     全表扫。SQL `DESC` 在 PG 里需要显式声明才有专用索引方向。
 *   - (page_id)单列:page hard-delete 时 DELETE 走这里(跟 user_watched
 *     索引命名对齐)。
 * ───────────────────────────────────────────────────────────────── */
export const userRecentPages = pgTable(
  'user_recent_pages',
  {
    /** No FK — page hard-delete cleans via pages.ts DELETE. */
    pageId: text('page_id').notNull(),
    /** No FK — disabled/deleted users get their rows swept by app code. */
    userId: text('user_id').notNull(),
    /** Date.now() ms,最近一次访问时间。list 路径 ORDER BY DESC 走它,
     *  每访问一次 (PUT /recent/:id) 刷新。 */
    visitedAt: bigint('visited_at', { mode: 'number' }).notNull(),
    /** 冗余存的 page title。page 删了之后 recent row 仍有 title 可显示;
     *  也避免 join pages。list 路径优先用 page 的最新 title(LEFT JOIN),
     *  这个 title 只作为 page 缺失时的兜底。 */
    title: text('title').notNull(),
  },
  (t) => [
    /** PK: 每用户对每页面最多一行 recent(upsert 语义)。 */
    primaryKey({ columns: [t.pageId, t.userId] }),
    /** 复合索引(user_id, visited_at DESC)给 list 主路径;PG 里 DESC 要
     *  显式声明才有专用方向,否则只是 ASC 索引 + 反向扫描。 */
    index('user_recent_user_visited_idx').on(t.userId, sql`${t.visitedAt} DESC`),
    /** 单列 page_id 给 hard-delete 路径清理;命名跟 user_watched_page_idx
     *  对齐便于记忆。 */
    index('user_recent_page_idx').on(t.pageId),
  ],
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
export type AttachmentRow = typeof attachments.$inferSelect
export type NewAttachmentRow = typeof attachments.$inferInsert
export type PageLikeRow = typeof pageLikes.$inferSelect
export type NewPageLikeRow = typeof pageLikes.$inferInsert
export type UserWatchedPageRow = typeof userWatchedPages.$inferSelect
export type NewUserWatchedPageRow = typeof userWatchedPages.$inferInsert
export type UserRecentPageRow = typeof userRecentPages.$inferSelect
export type NewUserRecentPageRow = typeof userRecentPages.$inferInsert
export type AdminSettingRow = typeof adminSettings.$inferSelect
export type NewAdminSettingRow = typeof adminSettings.$inferInsert

/* ─────────────────────────────────────────────────────────────────────
 *  page_events — workspace-wide 活动流数据源(P1-3 v2)。
 *
 *  之前活动流从 `pages.updated_at` 派生,只能报「这页最近被改」,无法区分
 *  create / edit / move / restore / duplicate / publish — UI 端 verb 写死成
 *  「编辑了」是错位语义。这张表由写路径(POST /pages, PATCH, /move, /restore,
 *  /duplicate, /publish)显式插行,前端按 kind 渲染不同动词。
 *
 *  设计要点:
 *   - **无 FK**(CLAUDE.md 硬约束):actor_id 可以是已 disabled / 已删 user
 *     (前端 LEFT JOIN users 拿到 null 后兜底显示「已删除用户」)。
 *     page_id 同理 — 硬删后这张表的事件行**保留**作历史(否则审计会丢)。
 *   - **payload jsonb**:move 存 {fromSpaceId, toSpaceId} 等上下文。
 *     前端 v0 只读不写,扩展时再加 enum。
 *   - **created_at bigint (ms)**:跟其他表对齐,索引按 DESC 让活动流一次
 *     走 index scan。
 *   - **空间过滤索引 + 时间倒序索引**:`?space=<id>` 的核心 path 走
 *     (space_id, created_at DESC) 的复合索引,workspace-wide 走 created_at DESC
 *     单列索引。
 *   - **INSERT 不参与 page_versions 写入**:纯 metadata 写(label / watch toggle)
 *     不触发 PATCH / 写 version;page_events 是独立维度,显式插行跟那种
 *     「不动 page_version」是两回事。
 * ───────────────────────────────────────────────────────────────────── */
export const pageEvents = pgTable(
  'page_events',
  {
    id: text('id').primaryKey(),
    pageId: text('page_id').notNull(),
    spaceId: text('space_id').notNull(),
    kind: text('kind').notNull(),
    actorId: text('actor_id'),
    /** 可选 jsonb,前端 v0 不解析。future fields: move 存 from/to space,
     *  duplicate / publish 存 source page id。 */
    payload: jsonb('payload'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('page_events_space_created_idx').on(t.spaceId, sql`${t.createdAt} DESC`),
    index('page_events_created_idx').on(sql`${t.createdAt} DESC`),
  ],
)
export type PageEventRow = typeof pageEvents.$inferSelect
export type NewPageEventRow = typeof pageEvents.$inferInsert

/* ─────────────────────────────────────────────────────────────────────
 *  space_role_grants — Phase A 空间角色授予表(Confluence 风格)。
 *
 *  替代隐式「space_group_access 一行 = 全文读写」的二元模型,用一行
 *  (space, principal, role) 显式表达空间角色。principal 可以是单个
 *  user(外部协作者 / 直接授权)或一个 group(组授权),由 principal_kind
 *  区分。同 (space, principal) 唯一(由 uniqueIndex 保证)。
 *
 *  角色三档:'viewer' 只读 / 'editor' 读+写 / 'admin' 读+写+管理。
 *  - 'admin' 不能授予 group(由 routes/spacePermissions.ts
 *    assertNotAdminToGroup 强制 —— Confluence 也不允许组级 space admin,
 *    否则审计语义模糊「谁代表组执行了?」)。
 *  - 共享空间始终有兜底:全局 admin 视为 super admin(由
 *    lib/permissions.effectiveSpaceRole 短路返回 'admin')。
 *  - 个人空间兜底:ensurePersonalSpace 在创建时插入 role='admin' 的
 *    group grant 绑定 pg-<ownerId> 组,owner 是该空间的唯一 admin。
 *
 *  向后兼容(Phase A.5):legacy space_group_access 行由
 *  lib/permissions.migrateLegacyGroupGrant 在通过新权限端点为某 group
 *  写 grant 时**就地迁入**本表(role='editor',同事务),并 DELETE 掉
 *  对应 legacy 行(主 INSERT 用 onConflictDoUpdate 保证用户选的角色
 *  优先,helper 用 onConflictDoNothing 不覆盖)。新写入一律走本表;
 *  老 system 仍可能写 legacy(保留 adminSpaces 三个 @deprecated 端点
 *  作 rollback 安全网,命中会 console.warn)—— 由后续全量 migration job
 *  收尾(DROP legacy 表 + 唯一索引)。
 *
 *  代码路径仍读 legacy:lib/permissions.effectiveSpaceRole UNION ALL
 *  legacy 行(视为 'editor',最宽松,保留旧行为),loadGrantsForSpace
 *  用 NOT EXISTS 互补去重(UI 列表不重复显示同一 group 的 legacy +
 *  新表两行)。功能正确,行重复占位由全量收尾统一处理。
 *
 *  无 FK(CLAUDE.md 硬约束):principal_id 是 user_groups.id 或 users.id,
 *  deleted/disabled 用户的行保留,前端 LEFT JOIN 兜底 null。级联清理
 *  在 adminGroups / adminUsers / adminSpaces DELETE 显式 sweep
 *  (同事务内 DELETE FROM space_role_grants WHERE ...)。
 *
 *  索引:
 *  - (space_id) — 空间设置页拉该空间所有 grants 的热路径
 *  - (principal_kind, principal_id) — 解析一个用户的有效角色(对
 *    当前用户的所有空间),permission SQL 核心 join
 *  - UNIQUE (space_id, principal_kind, principal_id) — 幂等 UPSERT
 * ───────────────────────────────────────────────────────────────────── */
export const spaceRoleGrants = pgTable(
  'space_role_grants',
  {
    /** nanoid(10) — 跟其他表 ID 同套(id.ts generatePageId 字母表)。 */
    id: text('id').primaryKey(),
    /** spaces.id。无 FK —— adminSpaces DELETE 同事务 sweep。 */
    spaceId: text('space_id').notNull(),
    /** 'user' = 单个用户直接授予(可用于未入任何组的外部协作者);
     *  'group' = 整组授予(与 legacy space_group_access 同构语义)。 */
    principalKind: text('principal_kind', { enum: ['user', 'group'] }).notNull(),
    /** principal_id:
     *  - principal_kind='user'  → users.id
     *  - principal_kind='group' → user_groups.id
     *  No FK。disabled / deleted 主体的行保留(由 admin 端 sweep)。 */
    principalId: text('principal_id').notNull(),
    /** 'viewer' | 'editor' | 'admin'。CHECK 约束在迁移里限定合法值。
     *  admin 路由拒绝对 group 写 'admin'(assertNotAdminToGroup)。 */
    role: text('role', { enum: ['viewer', 'editor', 'admin'] }).notNull(),
    /** 授予人 user id。null = 系统操作(ensurePersonalSpace /
     *  bootstrap 等)。No FK —— 授予人被 disable / delete 后行保留,
     *  audit 列能看到「当时谁给的」。 */
    grantedBy: text('granted_by'),
    /** Date.now() 毫秒。 */
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('space_role_grants_space_idx').on(t.spaceId),
    index('space_role_grants_principal_idx').on(t.principalKind, t.principalId),
    uniqueIndex('space_role_grants_space_principal_uq').on(
      t.spaceId,
      t.principalKind,
      t.principalId,
    ),
  ],
)
export type SpaceRoleGrantRow = typeof spaceRoleGrants.$inferSelect
export type NewSpaceRoleGrantRow = typeof spaceRoleGrants.$inferInsert

/**
 * Phase B — 页面级限制表(Confluence 风格)。
 *
 * 一行 = 「某 page 的某类型限制下,某 principal 被显式列入 allow-list」。
 * 没有行 = 没有 page-level 限制(默认按 space 角色走)。
 *
 * 反 default-deny 语义:某 page 出现 kind='view' 行 = 限制生效,除了
 * 列表里的 principal,其他人都不能读(本表行都是 allow;非列表主体一律
 * 拒绝)。edit 不继承父链(只约束本页);view 继承父链(BFS 累计 allow-list,
 * 任一祖先限制生效 → 子页必须满足)。
 *
 * 角色作者本人 + global admin 始终 full(在 permissions.ts 的 canReadPage /
 * canEditPage 短路,不走 allow-list 校验)。
 *
 * No FK(CLAUDE.md 硬约束):cleanup 由 adminPages / pages DELETE
 * (purge) 在事务内显式 sweep(参见 `pages.ts:DELETE /:id?purge=true`)。
 *
 * kind 字段:CHECK 限定 'view' | 'edit'。CHECK 在迁移里写(不靠 drizzle)。
 */
export const pageRestrictions = pgTable(
  'page_restrictions',
  {
    /** nanoid(10) —— 同其他表 ID 字母表。 */
    id: text('id').primaryKey(),
    /** pages.id。No FK —— adminPages DELETE ?purge=true 在同 tx 内
     *  DELETE FROM page_restrictions WHERE page_id = ? cascade。 */
    spaceId: text('space_id').notNull(),
    pageId: text('page_id').notNull(),
    /** 'view' = 限制谁能看;'edit' = 限制谁能改。CHECK 在迁移里。 */
    kind: text('kind', { enum: ['view', 'edit'] }).notNull(),
    /** 'user' = 单个用户;'group' = 整组。同 space_role_grants.principal_kind
     *  同构语义。CHECK 在迁移里。 */
    principalKind: text('principal_kind', { enum: ['user', 'group'] }).notNull(),
    /** principal_id:
     *  - principal_kind='user'  → users.id
     *  - principal_kind='group' → user_groups.id
     *  No FK。disabled / deleted 主体的行保留。 */
    principalId: text('principal_id').notNull(),
    /** 授予人 user id。null = 系统 bootstrap / 迁移。 */
    grantedBy: text('granted_by'),
    /** Date.now() 毫秒。 */
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('page_restrictions_page_idx').on(t.pageId),
    index('page_restrictions_principal_idx').on(t.kind, t.principalKind, t.principalId),
    uniqueIndex('page_restrictions_page_kind_principal_uq').on(
      t.pageId,
      t.kind,
      t.principalKind,
      t.principalId,
    ),
  ],
)
export type PageRestrictionRow = typeof pageRestrictions.$inferSelect
export type NewPageRestrictionRow = typeof pageRestrictions.$inferInsert

/**
 * Phase C — 权限变更审计日志(append-only)。
 *
 * 一行 = 一次「会改变可见性 / 访问性」的事件。包括:
 *   权限变更 8 个:
 *     - space_grant_set / space_grant_add / space_grant_remove:空间角色变更
 *     - page_restriction_set / page_restriction_add / page_restriction_remove:页面限制变更
 *     - page_share_create / page_share_revoke:公开链接生命周期
 *   资源生命周期 3 个(2026-07 起合并到同一张表):
 *     - space_deleted:空间被 admin DELETE(目标:shared space;personal 拒绝)
 *     - group_deleted:用户组被 admin DELETE(pg-* 系统组不删)
 *     - user_anonymized:用户被 admin 匿名化(改 name/email/status,保留
 *       authorship/comments/audit 行,sentinel 化)
 *
 * 严格 append-only:无 UPDATE、无 DELETE 入口;只有 INSERT。audit 行
 * 不参与任何业务判断,只是给 admin 一个「谁在什么时候改了什么」的查询面。
 *
 * payload 存 `{ before, after }` 形态的 diff,JSONB 灵活放各类结构:
 *   - space_grant_set: { before: grants, after: grants }
 *   - page_restriction_set: { before: {view,edit}, after: {view,edit} }
 *   - *_add: { after: 单行 }
 *   - remove 同款反方向
 *   - space_deleted: { before: { id, name, kind } }
 *   - group_deleted: { before: { id, name, memberCount } }
 *   - user_anonymized: { before: { name, email }, after: { name, email, status } }
 *
 * target_kind ∈ {space, page, page_share, group, user};CHECK 在 migration
 * 里限定(0027 + 0029_extend_audit_kinds)。
 *
 * No FK:audit 永远不被级联 —— 即使被改的 user/group/space/page 被
 * 删了,审计行保留(audit 本身就是"那时的快照")。这跟
 * page_restrictions.grantedBy 同款语义。
 */
export const permissionAudit = pgTable(
  'permission_audit',
  {
    id: text('id').primaryKey(),
    /** 事件类型;CHECK 在 migration 里限定。 */
    kind: text('kind').notNull(),
    /** 操作人 user id。无 FK —— 操作人 disable / delete 后 audit 行保留。 */
    actorId: text('actor_id').notNull(),
    /** 'space' = 空间角色授予 / 空间删除;'page' = 页面限制;'page_share' = 公开链接(Phase D);
     *  'group' = 用户组删除;'user' = 用户匿名化。 */
    targetKind: text('target_kind', { enum: ['space', 'page', 'page_share', 'group', 'user'] }).notNull(),
    /** target_kind 对应表的 id:spaces.id / pages.id。 */
    targetId: text('target_id').notNull(),
    /** Date.now() 毫秒。 */
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** `{ before, after }` diff 结构(JSON)。null = 极端情况保留(列兼容)。 */
    payload: jsonb('payload'),
  },
  (t) => [
    index('permission_audit_target_idx').on(
      t.targetKind,
      t.targetId,
      sql`${t.createdAt} DESC`,
    ),
    index('permission_audit_actor_idx').on(t.actorId, sql`${t.createdAt} DESC`),
    index('permission_audit_created_idx').on(sql`${t.createdAt} DESC`),
  ],
)
export type PermissionAuditRow = typeof permissionAudit.$inferSelect
export type NewPermissionAuditRow = typeof permissionAudit.$inferInsert

/* ─── Phase D — 公开链接分享 ────────────────────────────────────────────
 *
 * 一行 = 一个公开链接(anonymous 读权限)。pageId 是 pages.id;tokenHash
 * 是 sha256(明文 token) hex。**明文 token 不入库** —— 只在 POST 创建时
 * 一次性返给调用方,丢失即失效(create 新的 / revoke 旧的)。
 *
 * 字段语义:
 *   - tokenHash: sha256 hex,64 字符,unique(快速精确查表 + 防重)。
 *   - expiresAt: 可选过期时间,毫秒。null = 永不过期。GET 路由在校验时
 *     用 `expires_at IS NULL OR expires_at > now`。
 *   - revokedAt / revokedBy: 撤销时填。revokedAt 非 null = 已撤销,
 *     GET 路由拒绝。审计行通过 permission_audit(targetKind='page_share')
 *     留痕。
 *   - lastAccessedAt: GET /public 命中时 fire-and-forget 更新(异步,
 *     不阻塞首屏)。
 *
 * 设计要点:
 *   - No FK(CLAUDE.md):page 被 purge 时由 route handler 在事务内显式
 *     sweep page_public_shares(verify_phase_d §cascade 覆盖)。actor 也
 *     No FK,删除的 user 在 audit 行里仍可追溯。
 *   - 唯一索引在 tokenHash 上 — 因为 GET /public/pages/:token 是按
 *     token 精确查,其他列都不参与查询路径,只保留 pageId 索引方便
 *     「某 page 哪些 share 在跑」查询。
 *   - 一页可以同时有多个 share(多 token,各独立过期 / 撤销);UI 在
 *     ShareDialog 列全。
 */
export const pagePublicShares = pgTable(
  'page_public_shares',
  {
    id: text('id').primaryKey(),
    /** pages.id;无 FK —— purge 时由 route 显式 sweep。 */
    pageId: text('page_id').notNull(),
    /** sha256 hex(64 字符)。明文 token 永不入库,只在 POST 创建时返一次。 */
    tokenHash: text('token_hash').notNull().unique(),
    /** 创建人 users.id;无 FK —— 删除后 audit 行仍可追溯。 */
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** 可选过期;null = 永不过期。 */
    expiresAt: bigint('expires_at', { mode: 'number' }),
    /** 非 null = 已撤销;GET /public 拒绝。 */
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    /** 撤销人 users.id;无 FK。 */
    revokedBy: text('revoked_by'),
    /** GET /public 命中时异步更新;UI 不展示,纯运营位。 */
    lastAccessedAt: bigint('last_accessed_at', { mode: 'number' }),
  },
  (t) => [
    index('page_public_shares_page_idx').on(t.pageId),
    index('page_public_shares_expires_idx').on(t.expiresAt),
  ],
)
export type PagePublicShareRow = typeof pagePublicShares.$inferSelect
export type NewPagePublicShareRow = typeof pagePublicShares.$inferInsert
