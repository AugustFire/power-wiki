/**
 * 运行时常量(纯值,无 zod 依赖)— 独立导出避免 web 端 import 整个 barrel 时
 * 顺带拉进 zod runtime。
 *
 * 用法:
 *   import { PERSIST_KEYS } from '@power-wiki/shared/keys'
 */

export const PERSIST_KEYS = {
  PAGES: 'power-wiki:pages',
  USER: 'power-wiki:user',
  TREE_EXPANDED: 'power-wiki:tree-expanded',
  /** 当前选中的 space id — 刷新后保留上下文 */
  ACTIVE_SPACE: 'power-wiki:active-space',
} as const

export type PersistKey = (typeof PERSIST_KEYS)[keyof typeof PERSIST_KEYS]
