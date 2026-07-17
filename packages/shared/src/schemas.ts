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
import {
  MAX_UPLOAD_BYTES_DEFAULT,
  AVATAR_ALLOWED_MIME,
  AVATAR_TARGET_DIM,
} from './constants'

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
  /** 最后编辑者(PATCH / move / restore 同步写入);存量行 0012 已 backfill。
   *  UI 派生逻辑(updatedByName 优先 → authorName 兜底)在 ReadView 端,
   *  详见 pages.ts:`selectPagesWithAuthor` 的 editor_users 左连。 */
  updatedBy: z.string().min(1).nullable(),
  updatedByName: z.string().nullable(),
  updatedByColor: z.string().nullable(),
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
  /**
   * M13 👁 visibility — 当前用户是否关注此页。EXISTS(user_watched_pages
   * WHERE page_id=? AND user_id=me)。Join 路径是 selectPagesWithAuthor,
   * 没传 viewerUserId 时返回 false。Fallback 路径给 false。
   * Optional:种子页 / 老 cache 没填时为 undefined,UI fallback 到 false。 */
  watchedByMe: z.boolean().optional(),
  /** M13 👁 该页被关注总数 —— 由 user_watched_pages 表 COUNT(*) GROUP BY
   *  page_id 出。Joined rows 一定有(0 / 数字),未走 join 的 fallback 路径
   *  在 rowToPageNode 里 fallback 成 0。 */
  watchersCount: z.number().int().nonnegative().optional(),
  /**
   * M2 case 3:首次发布时间(Date.now() ms),null/undefined = 从未发布。
   *
   * 读者列表路径(`selectPagesWithAuthor` + viewerUserId)会自动过滤
   * `firstPublishedAt IS NULL OR authorId = viewer` —— 非作者根本看不
   * 见未发布页面,所以 client 端拿到的 PageNode 这个字段**几乎永远**
   * 不为 null。Undefined 仅在 fallback 路径或老 cache 没填时出现,UI
   * fallback 成「未发布」。Dashboard 「我创建的」section 会渲染该
   * 字段让作者区分已发布 vs 草稿(给个「未发布」chip),Sidebar 默认不
   * 显示该字段(列表里只剩已发布的 row,没必要重复)。 */
  firstPublishedAt: z.number().int().positive().nullable().optional(),
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
  /**
   * 头像形态三态:NULL = 用 initials+color 渲染;'preset' = 静态预制
   * (前端通过 GET /api/avatars/presets 运行时扫 apps/web/public/avatars/
   * 动态发现 slug,不写死);'custom' = 用户自定义上传(MinIO)。
   * Optional 是为老用户 / 老 cache 兼容;新数据统一两字段同步返回。
   */
  avatarKind: z.enum(['preset', 'custom']).nullable().optional(),
  /**
   * 头像引用:preset 存 slug(后端 z.string 校验格式,不限 enum —— 文件
   * 不存在时前端 <img @error> 兜底回 initials);custom 存 user_avatars.id。
   * 与 avatarKind 同 NULL/同非 NULL(状态机一致性)。
   */
  avatarRef: z.string().min(1).max(64).nullable().optional(),
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

/* ---------- User avatar API schemas ---------- */

/** PATCH /api/users/me 与 /api/admin/users/:id 的 avatar 子对象 —— 三态互斥。
 *  提到 UpdateUserInputSchema 之前,否则后者在 module 顶层引用时会撞 TDZ
 *  (const 无 hoisting)。以下 union 三态(M11 v2 后 preset ref 放宽):
 *   - { kind: 'preset', ref }:ref 是 slug,后端 z.string() 校验格式(不限
 *     enum)。预设图清单由 GET /api/avatars/presets 运行时扫盘提供,放新
 *     PNG 进 apps/web/public/avatars/ 即自动可用
 *   - { kind: 'custom', ref }:ref 是 user_avatars.id,后端 finalize 路径已经写行
 *   - { kind: null, ref: null }:清除,回到 initials+color 兜底 */
export const AvatarSelectInputSchema = z.union([
  z.object({ kind: z.literal('preset'), ref: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('custom'), ref: z.string().min(1).max(64) }),
  z.object({ kind: z.null(), ref: z.null() }),
])

/* ---------- Admin API 输入 schema ---------- */

/** POST /api/admin/users */
export const CreateUserInputSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(64),
  role: z.enum(['admin', 'user']).optional(),
})

/** PATCH /api/admin/users/:id 与 PATCH /api/users/me 共用。后端在两侧都用这个
 *  schema 校验,所以 admin 路径理论上也可以 PATCH avatar 字段 —— 这不是 bug,
 *  是 feature:admin 帮人改头像走 admin 路径也无副作用(用户希望禁用此能力时
 *  在 routes/adminUsers.ts 里另加 if-defense 即可)。 */
export const UpdateUserInputSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/).optional(),
  /**
   * 头像选择 —— 三态互斥。
   *   - `{ kind: 'preset', ref: '<slug>' }`:ref 是 slug,后端 z.string()
   *     校验格式不限 enum;预设图清单运行时由 GET /api/avatars/presets
   *     扫 apps/web/public/avatars/ 提供,文件不存在时前端 <img @error> 兜底
   *   - `{ kind: 'custom', ref: '<avatarId>' }`:ref 必须在 user_avatars 表存在且属于 me
   *     (后端路线再查 DB)
   *   - `{ kind: null, ref: null }`:清除头像,回到 initials+color
   * 字段未传 = avatar 不变(等于「保持现状」)。
   * PATCH 时 avatar ≠ undefined 就走 cleanup:之前是 custom 的话清掉。 */
  avatar: AvatarSelectInputSchema.optional(),
})

/* ---------- User avatar API schemas ---------- */

/** POST /api/users/me/avatar/upload-url —— 申请 presigned PUT。 */
export const AvatarUploadUrlInputSchema = z.object({
  mime: z.enum(AVATAR_ALLOWED_MIME),
  /** 客户端上传字节数预估。后端 finalize 时 HeadObject 才是真实来源。 */
  sizeBytes: z.number().int().positive(),
})

export const AvatarUploadUrlResponseSchema = z.object({
  uploadUrl: z.string().url(),
  bucketKey: z.string().min(1),
  avatarId: z.string().min(1).max(64),
  expiresAt: z.number().int().positive(),
})

/** POST /api/users/me/avatar/finalize —— 客户端 PUT 完告知后端写行。 */
export const AvatarFinalizeInputSchema = z.object({
  avatarId: z.string().min(1).max(64),
  /** 必须以 users/{me.id}/ 开头 —— 后端 finalize 路径 hard check 防越权。 */
  bucketKey: z.string().min(1).max(256),
  mime: z.enum(AVATAR_ALLOWED_MIME),
  sizeBytes: z.number().int().positive(),
  /** 长边 ≤ AVATAR_TARGET_DIM。前端 canvas 压完报真实 dim,后端不宽容。 */
  width: z.number().int().positive().max(AVATAR_TARGET_DIM),
  height: z.number().int().positive().max(AVATAR_TARGET_DIM),
})

export const AvatarFinalizeResponseSchema = z.object({
  avatarId: z.string().min(1),
  bucketKey: z.string().min(1),
  createdAt: z.number().int().positive(),
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

/** M2: 通知 kind 白名单 —— 跟 NotificationSchema.kind 同源,服务端
 * `GET /api/notifications?kind=mention` 走这个做 400 校验,避免错的值
 * 悄悄 fallthrough 到 "全部"。Drift 风险:`apps/api/src/db/schema.ts`
 * `notifications.kind` 文本 enum 列也要保持一致 — 见该处的 JSDoc。 */
export const NotificationKindSchema = z.enum([
  'mention',
  'reply',
  'comment_on_my_page',
  'page_like',
  // M13 watch fanout(给所有 watcher,actor != user_id)
  'page_edit',
  'page_renamed',
  'page_moved',
  'page_restored',
  'page_deleted',
  'comment_add',
])

/** M2: 每个 kind 的中文显示标签 —— DashboardCard 等前端组件消费,
 * 集中放在 shared 包避免每处组件重复 Record<string, string> 跟 enum drift。
 * 顺序跟 NotificationKindSchema 一致便于审阅。 */
export const NotificationKindLabels: Record<z.infer<typeof NotificationKindSchema>, string> = {
  mention: '@ 提及',
  reply: '回复',
  comment_on_my_page: '评论我的页',
  page_like: '赞',
  page_edit: '编辑',
  page_renamed: '改名',
  page_moved: '移动',
  page_restored: '恢复',
  page_deleted: '删除',
  comment_add: '评论',
}

/** 单条通知 — 响应 DTO。
 *
 * 通知是 recipient-private:WHERE user_id=me.id 强约束,没有 admin bypass。 */
export const NotificationSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  actorId: z.string().min(1),
  actorName: z.string().nullable(),
  actorColor: z.string().nullable(),
  // M13 扩 6 类 watch fanout kind。app 层 enum,Drizzle 端 text(无 DB native enum)。
  // page 作者同时满足 watcher 时,comment_add → comment_on_my_page(author 去重)。
  kind: NotificationKindSchema,
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
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: '至少需要更新一个字段' },
  )

/** POST /api/pages/import 入参 — 单文件 / 单段粘贴文本导入成新页。
 *  v1 仅支持单文件;多文件场景前端拆成多次调用。
 *  - `source` 区分来源(文件 / 粘贴);影响 title fallback 链
 *  - `text` raw markdown,服务端用 prosemirror-markdown 解析
 *  - `title` 缺省时服务端从 H1 → filename → "未命名" 推导
 *  - `filename` 仅 `source='file'` 时填,用于 title fallback
 *  - 2MB 上限远低于 MAX_UPLOAD_BYTES 20MB(MD 文本平均密度 5KB/页) */
export const ImportPageInputSchema = z.object({
  source: z.enum(['paste', 'file']),
  text: z.string().min(1).max(2_000_000),
  spaceId: PageIdSchema,
  parentId: PageIdSchema.nullable().optional(),
  title: PageTitleSchema.optional(),
  filename: z.string().min(1).max(200).optional(),
})

/** POST /api/pages/import 响应 — 成功创建的页 + 跳过的(同名)信息 */
export const ImportPageResultSchema = z.object({
  created: PageNodeSchema.nullable(),
  skipped: z
    .object({
      filename: z.string(),
      reason: z.enum(['duplicate_title', 'empty', 'too_large']),
      existingId: z.string().optional(),
    })
    .nullable(),
})

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

/** POST /api/pages/:id/duplicate 入参
 *  - `withChildren`: 整棵子树递归复制,Confluence 默认行为
 *    (单页复制是 NodeList 里的 "Duplicate" → "Duplicate with subtree")。
 *    客户端可以用 `?withChildren=true` query 参数或 body 字段触发,
 *    后端统一从 query 取(API client 当前把 body 做成空 {} 也能走通)。
 *  - `?withChildren=true` 缺省 false,保持历史行为不变(单页复制,
 *    不递归子页,跟改这个 schema 之前的版本一致)。 */
export const DuplicatePageInputSchema = z
  .object({
    withChildren: z.boolean().optional(),
  })
  .optional()

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
export type ImportPageInput = z.infer<typeof ImportPageInputSchema>
export type ImportPageResult = z.infer<typeof ImportPageResultSchema>
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
/** M11 用户头像三态 union(form state 用)。 */
export type AvatarSelectInput = z.infer<typeof AvatarSelectInputSchema>
/** M11 自定义上传 presigned PUT 输入/响应。 */
export type AvatarUploadUrlInput = z.infer<typeof AvatarUploadUrlInputSchema>
export type AvatarUploadUrlResponse = z.infer<typeof AvatarUploadUrlResponseSchema>
/** M11 finalize(HeadObject 校验后写 user_avatars 行)输入/响应。 */
export type AvatarFinalizeInput = z.infer<typeof AvatarFinalizeInputSchema>
export type AvatarFinalizeResponse = z.infer<typeof AvatarFinalizeResponseSchema>
export type CreateGroupInput = z.infer<typeof CreateGroupInputSchema>
export type UpdateGroupInput = z.infer<typeof UpdateGroupInputSchema>
export type CreateSpaceInput = z.infer<typeof CreateSpaceInputSchema>
export type UpdateSpaceInput = z.infer<typeof UpdateSpaceInputSchema>
export type SetSpaceAccessInput = z.infer<typeof SetSpaceAccessInputSchema>

/* ---------- Dashboard ---------- */
export const DashboardPayloadSchema = z.object({
  mentions: z.array(NotificationSchema),
  /** Confluence 模型:个人空间 = 「私人记事本 / 草稿本」。这里展示当前用户
   * 在所有 personal 空间里的最近编辑页面(updated_at DESC, top N)。跨空间
   * 移页前在这里起草。 */
  personalSpace: z.array(PageNodeSchema),
  created: z.array(PageNodeSchema),
  watched: z.array(PageNodeSchema),
  recent: z.array(PageNodeSchema),
})
export type DashboardPayload = z.infer<typeof DashboardPayloadSchema>

/* ---------- Stage 6 type exports ---------- */
export type Comment = z.infer<typeof CommentSchema>
export type MentionCandidate = z.infer<typeof MentionCandidateSchema>
export type Notification = z.infer<typeof NotificationSchema>
export type NotificationKind = z.infer<typeof NotificationKindSchema>
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

/* ---------- Page watched — 👁 visibility (M13) ----------
 * 与 ToggleLike 同构:watch 状态变更响应只返 watched + watchersCount
 * 两个最小字段。前端 store 已经在缓存 PageNode,只需要合并。Server 端
 * 复合主键 (page_id, user_id) 自带幂等;SELECT-then-INSERT/DELETE 顺序。
 */
export const ToggleWatchResponseSchema = z.object({
  /** 切换后当前用户的 watch 状态 —— true=已关注, false=已取消 */
  watched: z.boolean(),
  /** 该页最新的关注者总数 >= 0,变更后立即同步。
   *  并发竞态下后端 SERIALIZABLE 事务保证准确,前端不再乐观推算。 */
  watchersCount: z.number().int().nonnegative(),
})

/** GET /api/pages/:id/watchers 单条 DTO — LEFT JOIN users 拿 name/color,
 *  user 已 disabled 时为 null。`watchedAt` 用于排序 / tooltip。 */
export const WatcherSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/)
    .nullable(),
  watchedAt: z.number().int().positive(),
})

/* ---------- Stage 8 type exports ---------- */
export type PageVersion = z.infer<typeof PageVersionSchema>
export type AddLabelInput = z.infer<typeof AddLabelInputSchema>
export type ToggleLikeResponse = z.infer<typeof ToggleLikeResponseSchema>
export type ToggleWatchResponse = z.infer<typeof ToggleWatchResponseSchema>
export type Watcher = z.infer<typeof WatcherSchema>

/* ─────────────────────────────────────────────────────────────────
 *  P1-3 Activity feed (v2)
 *  workspace-wide 最近活动流。一行 = 一次 page_events 表 INSERT,由写路径
 *  显式触发(created / edited / moved / restored / duplicated / published)。
 *  每行带 actor + page + space + kind,前端按 kind 渲染不同动词。
 * ───────────────────────────────────────────────────────────────── */

export const ActivityEventSchema = z.object({
  pageId: PageIdSchema,
  pageTitle: z.string(),
  /**
   * 事件类型。前端 verb / icon 映射:
   *   - 'created'    → "创建了"
   *   - 'edited'     → "编辑了"
   *   - 'moved'      → "移动了"
   *   - 'restored'   → "恢复了"
   *   - 'duplicated' → "复制了"
   *   - 'published'  → "发布了"
   *   - 'trashed'    → "删除了" — 进 trash,page row 仍在(deleted_at 设值)
   *   - 'purged'     → "永久删除了" — 从 trash 硬删,page row 已没了
   * 后端应用层 enum(白名单),DB 列是 text;未知值会被后端兜底成 'edited'。
   */
  kind: z.enum(['created', 'edited', 'moved', 'restored', 'duplicated', 'published', 'trashed', 'purged']),
  /** ms since epoch,事件落 page_events 表的时间(等价 updatedAt 语义)。 */
  updatedAt: z.number().int().positive(),
  /** 触发事件的 user id。无 FK,disabled/deleted users 保留不动。 */
  actorId: z.string().min(1),
  actorName: z.string().nullable(),
  actorColor: z.string().nullable(),
  /** 所属空间 — 左侧 chip 用。 */
  spaceId: PageIdSchema,
  spaceName: z.string(),
  spaceColor: z.string(),
  spaceKind: z.enum(['personal', 'shared']),
})
export type ActivityEvent = z.infer<typeof ActivityEventSchema>

/* ─────────────────────────────────────────────────────────────────
 *  P1-8 Admin settings (trash retention)
 *
 *  key-value 通用表,目前只支持 `trash_retention_days`(0=永不清理,>0=天数)。
 *  详见 apps/api/src/db/migrations/0013_admin_settings.sql。
 *  0..36500 区间(0~100 年)够用 — 真实业务不可能设 100 年。
 * ───────────────────────────────────────────────────────────────── */

export const AdminSettingSchema = z.object({
  key: z.string().min(1).max(64),
  /** 永远 string,数字也以字符串存;前端 parseInt。 */
  value: z.string(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().nullable(),
})
export type AdminSetting = z.infer<typeof AdminSettingSchema>

/** PATCH /api/admin/settings/:key body。whitelist:目前只支持
 *  `trash_retention_days`,其他 key 由后端返 400 unknown_key。 */
export const UpdateAdminSettingInputSchema = z.object({
  value: z.number().int().min(0).max(36500),
})
export type UpdateAdminSettingInput = z.infer<typeof UpdateAdminSettingInputSchema>
