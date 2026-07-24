/**
 * Shared domain types — 前后端共享。
 *
 * Stage 0 之前这些类型在 `apps/web/src/types/page.ts`,随着后端接入,
 * 后端 API 也会需要这些类型,所以抽到 `packages/shared` 让两边都引用。
 *
 * 重要规则:本文件**只放纯类型**(interface / type alias),不放任何运行时代码。
 * 运行时校验(zod)放 `schemas.ts`,跟类型推导绑定。
 */

/**
 * Tiptap 文档 JSON 的弱类型。
 *
 * Tiptap 的 `getJSON()` 返回完整 ProseMirror 节点树,字段多、嵌套深,
 * 而且版本演进时常有变更。这里故意用 `Record<string, unknown>` 保持松散,
 * 真正需要结构时用 `@tiptap/core` 的 `JSONContent` 类型(在 apps/web 内消费)。
 */
export type TiptapJSON = Record<string, unknown>

/** 单个 wiki 页面节点。 */
export interface PageNode {
  id: string
  /** 父页面 id,null = 顶级 */
  parentId: string | null
  /** 所属 Space id(Stage 4 起所有页面必须归属一个 space) */
  spaceId: string
  title: string
  /** Tiptap 文档 JSON,用于回填到编辑器 */
  contentJSON: TiptapJSON
  /** Tiptap 渲染出的 HTML,ReadView 直接用(已 sanitize) */
  contentHTML: string
  /** 可选 emoji / icon,目前未使用但保留字段 */
  icon?: string
  /** 同级排序(数字越小越靠前) */
  order: number
  /** Date.now() 时间戳 */
  createdAt: number
  updatedAt: number
  /** Stage 4 起是真实 user.id;旧 seed 页面可能是 'me'(向前兼容) */
  authorId: string
  /** 创建者姓名,通过 JOIN users 表填充;authorId='me' 或用户不存在时为 null */
  authorName: string | null
  /** 创建者头像色,同上 */
  authorColor: string | null
  /** M11 头像 DTO 透传。authorId='me' / 用户已 disabled 时为 null。 */
  authorAvatarKind?: 'preset' | 'custom' | null
  /** M11 头像 DTO 透传。 */
  authorAvatarRef?: string | null
  /**
   * 最后编辑者 user id(每次 PATCH / move / restore 同步更新)。
   * `0012 migration` 已 backfill 成 author_id,所以存量行不会为 null;
   * 新页可能在第一次 PATCH 之前为 null —— UI 路径 fallback 到 authorId。
   * 无 FK,disabled / deleted users 的行保留原值。
   */
  updatedBy: string | null
  /** 最后编辑者姓名,LEFT JOIN users 表填充;updated_by 为空或用户已删时为 null */
  updatedByName: string | null
  /** 最后编辑者头像色,同上 */
  updatedByColor: string | null
  /** M11 头像 DTO 透传。updatedBy 为空 / 用户已 disabled 时为 null。 */
  updatedByAvatarKind?: 'preset' | 'custom' | null
  /** M11 头像 DTO 透传。 */
  updatedByAvatarRef?: string | null
  /**
   * Stage 8: page labels (Notion-style, global lowercase). Always present
   *  on list/get responses — backend LEFT JOIN aggregates distinct labels.
   *  Default [] when the page has no labels.
   */
  labels?: string[]
  /**
   * Stage 5 软删除:非 null = 已被移到回收站。
   * 默认 SELECT 不返回此字段,只有 trash.list 端点会包含。
   * 恢复后回到 null。
   */
  deletedAt?: number | null
  /** Stage 5:谁把页移到回收站。purge 时记录审计。 */
  deletedBy?: string | null
  /**
   * 服务端 EXISTS 子查询计算的结果:`(SELECT 1 FROM pages c WHERE c.parent_id = p.id
   * AND c.deleted_at IS NULL) IS NOT NULL`。Sidebar 用这个判断是否显示 caret —
   * **不**用 children 数组(懒加载模式下 children 数组在用户展开前是空的,会
   * 让无子节点显示 caret 误导用户)。乐观插入的页(还没拿到 server 响应)
   * 此字段可能为 undefined,PageTree 一律当 leaf 处理。
   */
  hasChildren?: boolean
  /** 页面点赞总数 —— page_likes 表 COUNT(*) GROUP BY page_id 算出。
   *  Optional:种子页 / 老 cache 没填时为 undefined,前端 ReadView fallback 0 渲染。 */
  likesCount?: number
  /** 当前用户是否已赞 —— EXISTS(page_likes WHERE page_id=? AND user_id=me)。
   *  Optional:同上,前端用这个判断 👍 按钮的 primary 态。 */
  likedByMe?: boolean
  /** 点赞者 sample(前 5 人,按 created_at 升序) —— 给 ReadView 头像组用。
   *  user 已 disabled 时 name/color 为 null。Optional:未走 selectPagesWithAuthor
   *  的 fallback 路径给 []。 */
  likedBySample?: Array<{
    id: string
    name: string | null
    color: string | null
    /** M11 头像 DTO 透传 —— 点赞者头像组用真实头像 */
    avatarKind?: 'preset' | 'custom' | null
    /** M11 头像 DTO 透传 */
    avatarRef?: string | null
  }>
  /**
   * M13 👁 visibility — 当前用户是否关注此页。EXISTS(user_watched_pages
   *  WHERE page_id=? AND user_id=me)。Optional:种子页 / 老 cache 没填时
   *  为 undefined,UI fallback 到 false。schema 同步 PageNodeSchema。 */
  watchedByMe?: boolean
  /** M13 👁 该页被关注总数 —— user_watched_pages 表 COUNT(*) GROUP BY page_id。
   *  Joined rows 一定有这个字段(0 / 数字),未走 join 的 fallback 路径给 0。
   *  Optional:同 likedByMe。 */
  watchersCount?: number
  /**
   * M2 case 3:首次发布时间(Date.now() ms),null/undefined = 从未发布。
   *
   * 读者列表路径(`selectPagesWithAuthor` + viewerUserId)会自动过滤
   * `firstPublishedAt IS NULL OR authorId = viewer` —— 非作者根本看不
   * 见未发布页面。Optional:fallback 路径 / 老 cache 没填时为 undefined。
   * Dashboard「我创建的」section 用这个字段给作者的草稿页加「未发布」chip。
   */
  firstPublishedAt?: number | null
  /**
   * Phase B 页面级 view 限制标记 —— 服务端 EXISTS 子查询
   * `(SELECT 1 FROM page_restrictions WHERE page_id=? AND kind='view')`。
   * 与 PageNodeSchema 同构。注意:这不是「我能读吗」的判断,只是「此页
   * 是否配置了限制」的元信息。Optional:fallback 路径 / 老 cache 没填时
   * 为 undefined,UI fallback 到 false。 */
  hasViewRestriction?: boolean
  /** Phase B 页面级 edit 限制标记 —— 与 hasViewRestriction 同构。 */
  hasEditRestriction?: boolean
  /**
   * 当前用户在该 page 所属空间的 effective role(viewer/editor/admin),
   * 由服务端 `getEffectiveSpaceRolesForUser` 注入。null = 无访问权
   * (在 list 路径上不会出现,只在 fallback 路径或老 cache 可能为 null)。
   * UI 用这个字段 gate 「编辑」/「创建子页」/「新建」等写操作按钮,
   * 把后端 404 提前到按钮不可见阶段;不依赖再次访问 server。
   * Optional:老 cache / seed 数据可能缺失,fallback null 等同于无权限。 */
  viewerRole?: 'viewer' | 'editor' | 'admin' | null
}

/** 树形结构上的节点(Sidebar / PageTree 渲染用),与 PageNode 解耦避免暴露 contentJSON 等大字段。 */
export interface TreeNode {
  id: string
  title: string
  parentId: string | null
  order: number
  /**
   * Pre-computed count of **non-trashed** descendants. Populated once when
   * the tree is built in `pagesStore.getTree()` via a post-order walk —
   * lets `PageTree` skip an O(N) BFS per row on every render and the
   * delete-confirmation flow skip a second BFS right before the request.
   */
  liveDescendantCount: number
  children: TreeNode[]
}

/**
 * 单用户 MVP 的 user shape。`power-wiki:user` localStorage key 持久化这个对象。
 * 后端接入后会改名为 Session 之类。
 */
export interface User {
  id: string
  email: string
  name: string
  /** 'admin' | 'user' — admin 可进 /manager 后台 */
  role: 'admin' | 'user'
  /** 'active' | 'disabled' | 'must_reset_password' | 'anonymized'(M16)
   *  - active: 正常使用
   *  - disabled: admin 临时禁用,enable 可恢复
   *  - must_reset_password: 首次登录必须改密码
   *  - anonymized: admin 永久匿名化(不可逆),identity 已 scrub;
   *    与 shared/schemas.ts UserSchema.status 同步 */
  status: 'active' | 'disabled' | 'must_reset_password' | 'anonymized'
  /** 头像 / 标识色,Atlas 设计 token 兼容的色值 */
  color: string
  /** M11 头像形态:null = initials+color;preset = 静态预制;custom = MinIO 用户头像
   *  Optional 是为老用户 / 老 cache 兼容(UserSchema 同样 .nullable().optional()); */
  avatarKind?: 'preset' | 'custom' | null
  /** M11 头像引用:preset 存 slug,custom 存 user_avatars.id */
  avatarRef?: string | null
  createdAt: number
  updatedAt: number
  lastLoginAt: number | null
}

/** 用户组 — admin 创建,可包含多个 user,被多个 space 引用 */
export interface UserGroup {
  id: string
  name: string
  /** 可选描述;DB 列可空,所以是 nullable。candidates 端点直接返 DB 行,
   *  没经过 rowToGroup 的 null → undefined 转换,所以这里要允许 null。 */
  description?: string | null
  createdAt: number
  /** list 路径聚合返,代表 user_group_members 行数。
   *  `:id` 路径同时还返 memberIds[];list 因为不返 ids,所以才有这个 count 字段。 */
  memberCount?: number
  /** 关联的 user.id 列表(完整 group 信息时返回) */
  memberIds?: string[]
}

/* ---------- M17: 人员管理 server-side filter ----------
 * 与 packages/shared/src/schemas.ts 的 AdminUsersListQuerySchema /
 * AdminUsersListResponseSchema 一一对应。*/

/** `GET /api/admin/users` 的 query 参数 */
export interface AdminUsersListQuery {
  limit?: number
  offset?: number
  q?: string
  status?: 'active' | 'disabled' | 'must_reset_password' | 'anonymized'
  role?: 'admin' | 'user'
}

/** topLoggedIn / PeopleContextPanel 用的精简 user DTO */
export interface UserSummary {
  id: string
  name: string | null
  color: string | null
  avatarKind?: 'preset' | 'custom' | null
  avatarRef?: string | null
  lastLoginAt: number | null
}

/** 人员管理页右栏统计块 —— system-wide,不受 filter 影响。 */
export interface UserSystemStats {
  totalCount: number
  adminCount: number
  activeCount: number
  mustResetCount: number
  disabledCount: number
  anonymizedCount: number
  recentlyActiveCount: number
  neverLoggedInCount: number
  topLoggedIn: UserSummary[]
}

/** `GET /api/admin/users` 的响应包装。`total` 跟 filter 走,`systemStats` 不跟。 */
export interface AdminUsersListResponse {
  items: User[]
  limit: number
  offset: number
  hasMore: boolean
  total: number
  systemStats: UserSystemStats
}

/** 空间 — 顶层组织单元,页面归属一个 space,space 通过用户组授权访问 */
export interface Space {
  id: string
  name: string
  /** 可选描述;DB 列可空,rowToSpace 转 null → undefined,但 candidates 等
   *  直返 DB 行的端点可能保留 null,所以这里允许 nullable。 */
  description?: string | null
  /** Atlas 设计 token 兼容的色值,#RRGGBB */
  color: string
  /** material-symbols-outlined 名称,如 'folder', 'description' */
  icon?: string
  /**
   * 'shared' (团队空间) | 'personal' (个人空间,每用户一个,ownerId 指向 users.id).
   * 老空间都是 'shared';新建个人空间由 ensurePersonalSpace 流程产生。
   */
  kind?: 'personal' | 'shared'
  /**
   * 仅 kind='personal' 有意义,指向 users.id;团队空间永远为 undefined。
   * 显式不暴露给非 admin(见 apps/api/src/routes/spaces.ts)。
   */
  ownerId?: string
  createdAt: number
  updatedAt: number
  /** 当前用户在该 space 下的角色/权限:
   *  - 'admin': admin 用户可访问所有 space,这个字段对 admin 而言无意义
   *  - 'member': 通过用户组授权可访问
   *  - undefined: 无访问权(API 不会返回这种 space) */
  accessVia?: 'member'
  /** 当前用户所属可访问该 space 的组 id 列表 */
  accessGroupIds?: string[]
  /** 仅 admin 空间 list/get 路径返回的完整直接授权,用于权限管理与统计。 */
  accessGrants?: import('./schemas').SpaceGrants
  /** 该空间下非删除页面的总数。Space list/get 时由服务端一次聚合查询给出,
   *  减少前端 N+1 请求。原来由前端 Promise.all(spaces.map(...)) 拉全量 page
   *  列表算出来,现在改成 DTO 字段。 */
  pageCount?: number
  /** 该空间下有父级(parentId != null)的非删除页面数。 */
  childPageCount?: number
  /** 该空间下页面中最新的 updatedAt;无页面时为 null(前端回退到 space.updatedAt)。
   *  Number(ms since epoch) 或 null。 */
  lastPageUpdatedAt?: number | null
  /** 仅 admin 路径 + kind='personal' 时返:所有者的显示名。
   *  避免前端为每个 personal space 再发一次 users/:id。 */
  ownerName?: string
  /**
   * 当前用户在该 space 的 effective role(viewer/editor/admin),由服务端
   * `getEffectiveSpaceRolesForUser` 注入。null = 无访问权(API 不会返回
   * 这种情况下的 space)。UI 用这个字段 gate 「新建页面」按钮 + 展示
   * 「只读」badge,把后端 404 提前到按钮不可见阶段。
   * admin 路径下永远为 'admin'(见 apps/api/src/routes/spaces.ts)。 */
  viewerRole?: 'viewer' | 'editor' | 'admin' | null
}

/**
 * localStorage / 持久化 key 常量 — 运行时值版本在 `./keys` 子路径导出,
 * 这里**只重新导出类型**,避免 web 端 import 整个 barrel 时拉进 zod。
 *
 * 用法:
 *   - 仅类型:`import type { PersistKey } from '@power-wiki/shared'`
 *   - 运行时值:`import { PERSIST_KEYS } from '@power-wiki/shared/keys'`
 */
export type { PersistKey } from './keys'

/**
 * 重新导出分页相关类型 — 这样 `import type { Paginated, PaginatedQuery } from '@power-wiki/shared'`
 * 能直接拿到,不用再走 `schemas` 子路径(避免误带 zod 运行时)。
 *
 * 源 schema 在 `./schemas.ts`,这里是纯类型转发。
 */
export type { Paginated, PaginatedQuery } from './schemas'

/**
 * Stage 6 (评论 / @mention / 通知) — 全部走 z.infer 转发,
 * 源 schema 一处定义、单一事实来源。这样 schema 字段增减时 types 自动跟随,
 * 不会出现"两个文件不同步"。
 */
export type {
  Comment,
  MentionCandidate,
  Notification,
  NotificationKind,
  CreateCommentInput,
  UpdateCommentInput,
  MarkReadInput,
  MentionCandidatesQuery,
  // Stage 8
  PageVersion,
  AddLabelInput,
  DuplicatePageInput,
  // Markdown import (single .md → new page)
  ImportPageInput,
  ImportPageResult,
  // Page attachments (MinIO/S3)
  Attachment,
  RequestUploadInput,
  FinalizeUploadInput,
  RequestUploadResponse,
  // Dashboard (Confluence model — personal space = scratchpad)
  DashboardPayload,
  // M11 用户头像 (custom upload pipeline — MinIO)
  AvatarUploadUrlInput,
  AvatarUploadUrlResponse,
  AvatarFinalizeInput,
  AvatarFinalizeResponse,
  // Phase A — space role grants (Confluence 风格空间角色)
  SpaceRole,
  PrincipalKind,
  SpaceGroupGrant,
  SpaceUserGrant,
  SpaceGrants,
  SetSpacePermissionsInput,
  UpsertGroupGrantInput,
  UpsertUserGrantInput,
  // Phase B — page-level restrictions (Confluence 风格页面级 view/edit 限制)
  PageRestrictionKind,
  PageRestriction,
  PageRestrictions,
  SetPageRestrictionsInput,
  UpsertPageRestrictionInput,
  RestrictionCandidateUser,
  RestrictionCandidateGroup,
  RestrictionCandidates,
} from './schemas'
