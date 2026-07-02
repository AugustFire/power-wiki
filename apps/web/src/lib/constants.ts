/**
 * 项目共享常量 — `emptyDoc` / `EMPTY_HTML` 是 Tiptap-only 故放这里;
 * `DEFAULT_TITLE` 必须跟后端 INSERT 默认值对齐(否则 PageTitleSchema
 * `min(1)` 会拒收后端兜底的空字符串),所以走 `@power-wiki/shared`。
 */
import { DEFAULT_TITLE } from '@power-wiki/shared'

/** 空页面的初始 Tiptap JSON(函数式,每次返回全新副本,避免共享引用) */
export function emptyDoc(): Record<string, unknown> {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** 空页面的初始 HTML */
export const EMPTY_HTML = '<p></p>'

/** 默认页面标题(从 `@power-wiki/shared` re-export,后端也在用同一份) */
export { DEFAULT_TITLE }

/**
 * 规范化页面标题:trim 之后如果为空,回退到 DEFAULT_TITLE。
 */
export function normalizeTitle(title: string | undefined | null): string {
  const t = (title ?? '').trim()
  return t || DEFAULT_TITLE
}