/**
 * Shared zod schemas — 前后端共享的运行时校验。
 *
 * 设计原则:schemas 是**事实来源**,TypeScript 类型用 `z.infer<typeof X>` 推导出来
 * 在 `types.ts` 手动维护的版本是「导出版本」(给后端读 / 给前端组件 props 用)。
 *
 * 字段命名:snake_case 列名 / camelCase TS 字段 — Postgres 是 snake_case,
 * Drizzle 的列定义里会有 `name: 'parent_id'` 这种映射,导出到 TS 还是 camelCase。
 */

import { z } from 'zod'
import type { TreeNode } from './types'
import { MAX_UPLOAD_BYTES_DEFAULT } from './constants'

/* ---------- 基础原子类型 ---------- */

/** nanoid(10) 生成的页面 id */
export const PageIdSchema = z.string().min(1).max(64)

/** 页面标题:1-200 字符,trim 后非空 */
export const PageTitleSchema = z
  .string()
  .trim()
  .min(1, '标题不能为空')
  .max(200, '标题最多 200 字符')

/** Tiptap JSON 文档的弱类型 schema — 实际结构不校验(版本演进太快) */
export const TiptapJSONSchema = z.record(z.string(), z.unknown())

/** HTML 字符串,长度上限按"单页 1MB"给,够用就行 */
export const HtmlSchema = z.string().max(1_000_000)

/* ---------- 实体 schema ---------- */

/** 单个 Page 的完整 schema(对应 API 返回的页面) */
export const PageNodeSchema = z.object({
  id: PageIdSchema,
  parentId: PageIdSchema.nullable(),
  spaceId: PageIdSchema,
  title: PageTitleSchema,
  contentJSON: TiptapJSONSchema,
  contentHTML: HtmlSchema,
  order: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  authorId: z.string().min(1),
  /** Denormalized author display fields — backend LEFT JOIN users. Null when
   *  authorId='me' (legacy seed) or refers to a now-deleted user. */
  authorName: z.string().nullable(),
  authorColor: z.string().nullable(),
  starred: z.boolean().optional(),
  /** Material Symbols ligature name (e.g. `menu_book`, `edit_note`,
   *  `arrow_back_ios_new`). Capped at 40 to match `SpaceSchema.icon` —
   *  the previous `max(8)` silently broke Material Symbols names like
   *  `arrow_back_ios_new` (16 chars). */
  icon: z.string().max(40).optional(),
  /** Stage 8: page labels (Notion-style, global lowercase). Always present
   *  on list/get responses — backend LEFT JOIN aggregates distinct labels.
   *  Default [] when the page has no labels. */
  labels: z.array(z.string().min(1).max(32)).default([]),
  /** Stage 5 软删除字段:默认 SELECT 不会返回(trash.list 才会)。
   *  Optional + nullable,因为常规响应不带这两个字段。 */
  deletedAt: z.number().int().positive().nullable().optional(),
  deletedBy: z.string().min(1).nullable().optional(),
  /**
   * 服务端 EXISTS 子查询(参考 apps/api/src/routes/pages.ts 的 selectPagesWithAuthor)
   * 计算是否有未删除的子页面。Sidebar 用它判断是否显示 caret — 用 children 数组
   * 会因为懒加载而对 leaf 节点显示错误 caret。乐观插入的页可能是 undefined,
   * PageTree 一律当 leaf。Optional 不写回 seed / 旧 cache。
   */
  hasChildren: z.boolean().optional(),
  /** 页面点赞总数 —— 由 page_likes 表 COUNT(*) GROUP BY page_id 出。
   *  Optional:种子页 / 老 cache 没填时为 undefined,前端 fallback 0。 */
  likesCount: z.number().int().nonnegative().optional(),
  /** 当前用户是否已赞 —— EXISTS(page_likes WHERE page_id=? AND user_id=me)。
   *  Optional 同上;前端 ReadView 用它判断 👍 按钮的 primary 态。 */
  likedByMe: z.boolean().optional(),
  /** 点赞者 sample —— 后端取前 5 个赞的用户(按 created_at 升序),带
   *  id/name/color 用于头像组渲染。user 已 disabled 时 name/color 为 null。
   *  Optional:未走 selectPagesWithAuthor 的 fallback 路径给 []。 */
  likedBySample: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().nullable(),
        color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/).nullable(),
      }),
    )
    .optional(),
})

/** 树形节点(sidebar 渲染用) — 显式标注类型解决 z.lazy 递归推导 */
export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    id: PageIdSchema,
    title: PageTitleSchema,
    parentId: PageIdSchema.nullable(),
    order: z.number().int().nonnegative(),
    liveDescendantCount: z.number().int().nonnegative(),
    children: z.array(TreeNodeSchema),
  }),
)

/** 单用户 MVP 的 user 记录 */
export const UserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1).max(64),
  role: z.enum(['admin', 'user']),
  status: z.enum(['active', 'disabled', 'must_reset_password']),
  /** 颜色格式校验:只接受 #RRGGBB / #RGB */
  color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/, '颜色格式必须是 #RGB 或 #RRGGBB'),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  lastLoginAt: z.number().int().positive().nullable(),
})

/** 用户组 schema */
export const UserGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  createdAt: z.number().int().positive(),
  /** list 路径聚合返,代表 user_group_members 行数。
   *  `:id` 路径同时还返 memberIds[];list 因为不返 ids,所以才有这个 count 字段。 */
  memberCount: z.number().int().nonnegative().optional(),
  memberIds: z.array(z.string()).optional(),
})

/** Space schema */
export const SpaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/, '颜色格式必须是 #RGB 或 #RRGGBB'),
  icon: z.string().max(40).optional(),
  kind: z.enum(['personal', 'shared']).optional(),
  ownerId: z.string().min(1).optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  accessVia: z.enum(['member']).optional(),
  accessGroupIds: z.array(z.string()).optional(),
  /** 该空间下的非删除页数,由 GET /api/spaces 与 /api/admin/spaces 一并返回,
   *  避免前端为了渲染卡片再发一次 pages.list。 */
  pageCount: z.number().int().nonnegative().optional(),
  /** 该空间下有父级(parentId != null)的非删除页数。 */
  childPageCount: z.number().int().nonnegative().optional(),
  /** 该空间下任意页面的最新 updatedAt;空空间为 null(回退到 space.updatedAt 显示)。 */
  lastPageUpdatedAt: z.number().int().positive().nullable().optional(),
  /** 仅 admin 路径 + kind='personal' 时返:所有者的显示名。
   *  避免前端为每个 personal space 再发一次 users/:id。 */
  ownerName: z.string().min(1).optional(),
})

/* ---------- Auth API 输入 schema ---------- */

/** POST /api/auth/sign-in */
export const SignInInputSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(1, '请输入密码'),
})

/** POST /api/auth/reset-password */
export const ResetPasswordInputSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码至少 8 位').max(128),
})

/* ---------- Admin API 输入 schema ---------- */

/** POST /api/admin/users */
export const CreateUserInputSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(64),
  role: z.enum(['admin', 'user']).optional(),
})

/** PATCH /api/admin/users/:id */
export const UpdateUserInputSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/).optional(),
})

/** POST /api/admin/groups */
export const CreateGroupInputSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
})

/** PATCH /api/admin/groups/:id */
export const UpdateGroupInputSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
})

/** POST /api/admin/spaces */
export const CreateSpaceInputSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/).optional(),
  icon: z.string().max(40).optional(),
})

/** PATCH /api/admin/spaces/:id */
export const UpdateSpaceInputSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/).optional(),
  icon: z.string().max(40).optional(),
})

/** PUT /api/admin/spaces/:id/access — 整组替换 */
export const SetSpaceAccessInputSchema = z.object({
  groupIds: z.array(z.string()),
})

/* ---------- Comments / Notifications (Stage 6) ---------- */

/** 单条评论 — 响应 DTO。
 *
 * `mentionedUserIds` 是「该评论内 @ 提及的所有用户 id 列表」,也是触发
 * notifications 的唯一来源;前端 composer 在提交时抽一次给后端。 */
export const CommentSchema = z.object({
  id: z.string().min(1),
  pageId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  authorId: z.string().min(1),
  contentMd: z.string().min(1).max(8000),
  contentText: z.string().min(1).max(2000),
  mentionedUserIds: z.array(z.string()),
  isEdited: z.boolean(),
  editedAt: z.number().int().positive().nullable(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  /** LEFT JOIN users 填充;authorId='me' 或 user 已 disabled 时为 null */
  authorName: z.string().nullable(),
  authorColor: z.string().nullable(),
})

/** @mention 候选人(GET /api/comments/mention-candidates) —
 *  限定为 page 所在 space 的访问组成员,见 apps/api/src/lib/mentionCandidates.ts */
export const MentionCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/),
  email: z.string().email(),
})

/** 单条通知 — 响应 DTO。
 *
 * 通知是 recipient-private:WHERE user_id=me.id 强约束,没有 admin bypass。 */
export const NotificationSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  actorId: z.string().min(1),
  actorName: z.string().nullable(),
  actorColor: z.string().nullable(),
  kind: z.enum(['mention', 'reply', 'comment_on_my_page', 'page_like']),
  pageId: z.string().min(1),
  pageTitle: z.string().nullable(),
  commentId: z.string().min(1).nullable(),
  mentionUserId: z.string().min(1).nullable(),
  isRead: z.boolean(),
  readAt: z.number().int().positive().nullable(),
  createdAt: z.number().int().positive(),
})

/** POST /api/comments 入参 */
export const CreateCommentInputSchema = z.object({
  pageId: z.string().min(1),
  /** 二级嵌套:parentId 非空 = 当前评论是某条评论的回复;
   *  后端校验 parentId 必须属于 pageId(否则 400)。v0 不支持更深嵌套。 */
  parentId: z.string().min(1).nullable().optional(),
  contentMd: z.string().min(1).max(8000),
  /** 可选:composer 在提交前抽一次 @ mention;后端**仍需** re-verify
   *  候选是否在 mention-candidates 结果集中(防止伪造)。 */
  mentionedUserIds: z.array(z.string()).max(50).optional(),
})

/** PATCH /api/comments/:id 入参 */
export const UpdateCommentInputSchema = z
  .object({
    contentMd: z.string().min(1).max(8000).optional(),
    mentionedUserIds: z.array(z.string()).max(50).optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: '至少需要更新一个字段' },
  )

/** GET /api/comments/mention-candidates?pageId=X&q=Y 入参 */
export const MentionCandidatesQuerySchema = z.object({
  pageId: z.string().min(1),
  q: z.string().max(64).optional(),
})

/** POST /api/notifications/mark-read 入参 */
export const MarkReadInputSchema = z
  .object({
    ids: z.array(z.string()).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine(
    (data) => (data.ids && data.ids.length > 0) || data.all === true,
    { message: 'ids 或 all 二选一必填' },
  )

/** GET /api/notifications/unread-count 响应 */
export const UnreadCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
})

/* ---------- Page likes — toggle 👍 ----------
 * POST /api/pages/:id/like 单端点 toggle。响应只返两个最小字段,
 * 避免刷新整页 PageNode;前端在本地 store 已经缓存的 PageNode 上直接
 * 合并这两个字段即可。PageNode 上的 likesCount / likedByMe 单独通过
 * GET / 拿到,这个端点是写后的最小回执。
 */
export const ToggleLikeResponseSchema = z.object({
  /** 切换后当前用户的 like 状态 —— true=已赞, false=已取消 */
  liked: z.boolean(),
  /** 该页最新的赞总数 >= 0,toggle 后立刻同步。
   *  并发竞态下后端 SERIALIZABLE 事务保证准确,前端不再 optimistically
   * 推算 — 一次返回就是权威值。 */
  likesCount: z.number().int().nonnegative(),
})

/* ---------- API 输入 schema(请求体) ---------- */

/** POST /api/pages 入参 */
export const CreatePageInputSchema = z.object({
  /** Optional — frontend sends its locally-generated nanoid for optimistic insert.
   * If omitted, server generates one. */
  id: PageIdSchema.optional(),
  /** Required (Stage 4+) — 页面必须归属一个 space */
  spaceId: PageIdSchema,
  parentId: PageIdSchema.nullable().optional(),
  title: PageTitleSchema.optional(),
  /** Material Symbols ligature (e.g. `menu_book`, `arrow_back_ios_new`).
   *  Capped at 40 to match `SpaceSchema.icon` — the previous `max(8)`
   *  blocked real Material Symbols names like `arrow_back_ios_new`. */
  icon: z.string().max(40).optional(),
  /** Optional — frontend 创建空白页时不会带,seed script 会带。
   * 留空等同于空文档,等下一次 PATCH 时回填。 */
  contentJSON: TiptapJSONSchema.optional(),
  contentHTML: HtmlSchema.optional(),
  /** Optional — 显式 sortOrder,seed script 用来保证导入顺序。不传则服务端追加到末尾。 */
  order: z.number().int().nonnegative().optional(),
})

/** PATCH /api/pages/:id 入参 — 所有字段可选,但至少要有一个 */
export const UpdatePageInputSchema = z
  .object({
    title: PageTitleSchema.optional(),
    contentJSON: TiptapJSONSchema.optional(),
    contentHTML: HtmlSchema.optional(),
    /** Same 40-char cap as CreatePageInput — see PageNodeSchema for rationale. */
    icon: z.string().max(40).optional(),
    starred: z.boolean().optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: '至少需要更新一个字段' },
  )

/** PATCH /api/pages/:id/move 入参 */
export const MovePageInputSchema = z.object({
  /** 新父页面 id,null = 移动到顶级 */
  newParentId: PageIdSchema.nullable(),
  /** 0-based 插入位置:在 newParentId 的子页面列表(排除自身)中,
   * 把该页插入到第 newOrder 个位置。不传 = 追加到末尾。
   * 后端会重新分配整个 sibling 列表的 sortOrder,无需客户端再批量 PATCH。 */
  newOrder: z.number().int().nonnegative().optional(),
  /**
   * 可选:跨空间移动到的目标 space id。
   * 传 newSpaceId 时,newParentId 必须为 null(移到目标空间根级),
   * 目标空间必须对当前用户 canAccess(由后端校验)。
   * admin 写 personal space 会被 personalSpaceGuard 拒为 403。
   */
  newSpaceId: PageIdSchema.optional(),
})

/** POST /api/pages/:id/publish 入参 — "发布到"草稿分享语义:
 * 在目标空间里**复制**一个全新页面(原页保留在 personal space 不动),
 * 标题自动加 "(来自 {userName} 的个人分享)" 后缀。源 page 必须是当前
 * 用户的 personal space 页(防 admin 越权代发),目标 space 必须对当前
 * 用户 canAccess。 */
export const PublishPageInputSchema = z.object({
  targetSpaceId: PageIdSchema,
})

/** POST /api/pages/:id/duplicate 入参 — 当前没有需要客户端传的字段,
 * 保留 schema 是为了和 publish / update 等路由在请求层结构对称(也方便
 * 未来扩展)。空对象 / 缺失 body 都视为合法。 */
export const DuplicatePageInputSchema = z.object({}).optional()

/** POST /api/pages/:id/snapshots 入参 — 边界 / idle 自动打 version 时
 * 携带的可选 changeNote(类似 git commit message),用户不在的边界不打
 * changeNote,所以默认 null。1-64 字符跟 AddLabelInput 对齐。 */
export const SnapPageInputSchema = z
  .object({
    changeNote: z.string().min(1).max(64).optional(),
  })
  .optional()

/* ---------- 列表分页 ---------- */

/**
 * GET list 端点的 query schema。`limit` 范围 1-200(防止无限制拉取),
 * `offset` ≥ 0。两端都 optional — 不传 = 后端走"全量"分支,保持 stores
 * 那种"一次拉所有"调用方的向后兼容。
 *
 * 走 `.partial()` 解析时同时支持两个字段缺失 / 仅缺失一个的场景。
 */
export const PaginatedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

/** 列表端点的统一响应包装。`limit`/`offset` 是实际生效值(无参 = items.length / 0)。 */
export const PaginatedListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  })

/* ---------- 类型推导(对外的 TS 类型) ---------- */

export type PageNodeFromSchema = z.infer<typeof PageNodeSchema>
export type TreeNodeFromSchema = z.infer<typeof TreeNodeSchema>
export type UserFromSchema = z.infer<typeof UserSchema>
export type UserGroupFromSchema = z.infer<typeof UserGroupSchema>
export type SpaceFromSchema = z.infer<typeof SpaceSchema>
export type PaginatedQuery = z.infer<typeof PaginatedQuerySchema>
export type Paginated<T> = { items: T[]; limit: number; offset: number; hasMore: boolean }
export type CreatePageInput = z.infer<typeof CreatePageInputSchema>
export type UpdatePageInput = z.infer<typeof UpdatePageInputSchema>
export type MovePageInput = z.infer<typeof MovePageInputSchema>
export type PublishPageInput = z.infer<typeof PublishPageInputSchema>
export type DuplicatePageInput = z.infer<typeof DuplicatePageInputSchema>
export type SnapPageInput = z.infer<typeof SnapPageInputSchema>
export type SignInInput = z.infer<typeof SignInInputSchema>
export type ResetPasswordInput = z.infer<typeof ResetPasswordInputSchema>
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>
export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>
export type CreateGroupInput = z.infer<typeof CreateGroupInputSchema>
export type UpdateGroupInput = z.infer<typeof UpdateGroupInputSchema>
export type CreateSpaceInput = z.infer<typeof CreateSpaceInputSchema>
export type UpdateSpaceInput = z.infer<typeof UpdateSpaceInputSchema>
export type SetSpaceAccessInput = z.infer<typeof SetSpaceAccessInputSchema>

/* ---------- Stage 6 type exports ---------- */
export type Comment = z.infer<typeof CommentSchema>
export type MentionCandidate = z.infer<typeof MentionCandidateSchema>
export type Notification = z.infer<typeof NotificationSchema>
export type CreateCommentInput = z.infer<typeof CreateCommentInputSchema>
export type UpdateCommentInput = z.infer<typeof UpdateCommentInputSchema>
export type MentionCandidatesQuery = z.infer<typeof MentionCandidatesQuerySchema>
export type MarkReadInput = z.infer<typeof MarkReadInputSchema>

/* ---------- Stage 8: history / labels ---------- */

/** 单条 page version — Stage 8 response DTO。
 *
 *  `editedByName` / `editedByColor` 是 LEFT JOIN users 填充;
 *  editedBy 是 legacy 'me' 或 user 已 disabled 时为 null。 */
export const PageVersionSchema = z.object({
  id: z.string().min(1),
  pageId: PageIdSchema,
  versionNumber: z.number().int().positive(),
  title: PageTitleSchema,
  contentJSON: TiptapJSONSchema,
  contentHTML: HtmlSchema,
  icon: z.string().max(40).optional(),
  editedBy: z.string().min(1),
  editedByName: z.string().nullable(),
  editedByColor: z.string().nullable(),
  editedAt: z.number().int().positive(),
  changeNote: z.string().nullable().optional(),
})

/** POST /api/pages/:id/labels 入参。Server normalizes (trim + lowercase + length check). */
export const AddLabelInputSchema = z.object({
  label: z.string().min(1).max(64),
})

/* ---------- Page attachments (MinIO/S3, page-scoped) ----------
 *
 * 整个上传流程走「presigned PUT + finalize」两步:
 *   1. POST /upload-url  → 拿到 uploadUrl + attachmentId + storageKey
 *   2. 浏览器 PUT uploadUrl (直接到 MinIO,不经 API)
 *   3. POST /finalize    → 服务端 HeadObject 验证 size 后写 attachments 表
 *
 * src 字段是浏览器可直接放进 <img src> / <a href download> 的相对 URL;
 * cookie 鉴权由全局 app.use('/api/*', requireAuth) 兜底。
 */

/** 响应 DTO —— 单条 attachment。 */
export const AttachmentSchema = z.object({
  id: z.string().min(1).max(32),
  pageId: PageIdSchema,
  uploaderId: z.string().min(1),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  sizeBytes: z.number().int().nonnegative(),
  kind: z.enum(['image', 'file']),
  /** 形如 /api/attachments/{id}/raw,不带 host。 */
  src: z.string().regex(/^\/api\/attachments\/[A-Za-z0-9_-]+\/raw$/),
  createdAt: z.number().int().positive(),
})

/** POST /api/attachments/upload-url 入参。 */
export const RequestUploadInputSchema = z.object({
  pageId: PageIdSchema,
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES_DEFAULT),
})

/** POST /api/attachments/finalize 入参。
 *  storageKey 格式 {page_id}/{attachment_id}{ext};由 /upload-url 产生并回传,
 *  客户端原样带回。附件最终存储在 MinIO bucket:{storageKey}。 */
export const FinalizeUploadInputSchema = z.object({
  attachmentId: z.string().min(1).max(32),
  storageKey: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(\.[a-z0-9]+)?$/),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES_DEFAULT),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
})

/* ---------- Attachment type exports ---------- */
export type Attachment = z.infer<typeof AttachmentSchema>
export type RequestUploadInput = z.infer<typeof RequestUploadInputSchema>
export type FinalizeUploadInput = z.infer<typeof FinalizeUploadInputSchema>

/** POST /api/attachments/upload-url 响应。 */
export interface RequestUploadResponse {
  uploadUrl: string
  attachmentId: string
  storageKey: string
  /** ms since epoch,便于前端做 countdown UI。 */
  expiresAt: number
}

/* ---------- Stage 8 type exports ---------- */
export type PageVersion = z.infer<typeof PageVersionSchema>
export type AddLabelInput = z.infer<typeof AddLabelInputSchema>
export type ToggleLikeResponse = z.infer<typeof ToggleLikeResponseSchema>
