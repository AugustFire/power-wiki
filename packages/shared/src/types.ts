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
  likedBySample?: Array<{ id: string; name: string | null; color: string | null }>
  /**
   * M13 👁 visibility — 当前用户是否关注此页。EXISTS(user_watched_pages
   *  WHERE page_id=? AND user_id=me)。Optional:种子页 / 老 cache 没填时
   *  为 undefined,UI fallback 到 false。schema 同步 PageNodeSchema。 */
  watchedByMe?: boolean
  /** M13 👁 该页被关注总数 —— user_watched_pages 表 COUNT(*) GROUP BY page_id。
   *  Joined rows 一定有这个字段(0 / 数字),未走 join 的 fallback 路径给 0。
   *  Optional:同 likedByMe。 */
  watchersCount?: number
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
  /** 'active' | 'disabled' | 'must_reset_password'
   *  - active: 正常使用
   *  - disabled: admin 禁用,无法登录
   *  - must_reset_password: 首次登录必须改密码 */
  status: 'active' | 'disabled' | 'must_reset_password'
  /** 头像 / 标识色,Atlas 设计 token 兼容的色值 */
  color: string
  createdAt: number
  updatedAt: number
  lastLoginAt: number | null
}

/** 用户组 — admin 创建,可包含多个 user,被多个 space 引用 */
export interface UserGroup {
  id: string
  name: string
  description?: string
  createdAt: number
  /** list 路径聚合返,代表 user_group_members 行数。
   *  `:id` 路径同时还返 memberIds[];list 因为不返 ids,所以才有这个 count 字段。 */
  memberCount?: number
  /** 关联的 user.id 列表(完整 group 信息时返回) */
  memberIds?: string[]
}

/** 空间 — 顶层组织单元,页面归属一个 space,space 通过用户组授权访问 */
export interface Space {
  id: string
  name: string
  description?: string
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
  CreateCommentInput,
  UpdateCommentInput,
  MarkReadInput,
  MentionCandidatesQuery,
  // Stage 8
  PageVersion,
  AddLabelInput,
  DuplicatePageInput,
  // Page attachments (MinIO/S3)
  Attachment,
  RequestUploadInput,
  FinalizeUploadInput,
  RequestUploadResponse,
} from './schemas'
