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
  /** 用户手动收藏的页面,Sidebar 会高亮显示 */
  starred?: boolean
  /**
   * Stage 5 软删除:非 null = 已被移到回收站。
   * 默认 SELECT 不返回此字段,只有 trash.list 端点会包含。
   * 恢复后回到 null。
   */
  deletedAt?: number | null
  /** Stage 5:谁把页移到回收站。purge 时记录审计。 */
  deletedBy?: string | null
}

/** 树形结构上的节点(Sidebar / PageTree 渲染用),与 PageNode 解耦避免暴露 contentJSON 等大字段。 */
export interface TreeNode {
  id: string
  title: string
  parentId: string | null
  order: number
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
  createdAt: number
  updatedAt: number
  /** 当前用户在该 space 下的角色/权限:
   *  - 'admin': admin 用户可访问所有 space,这个字段对 admin 而言无意义
   *  - 'member': 通过用户组授权可访问
   *  - undefined: 无访问权(API 不会返回这种 space) */
  accessVia?: 'member'
  /** 当前用户所属可访问该 space 的组 id 列表 */
  accessGroupIds?: string[]
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
