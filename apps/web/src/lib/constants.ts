/**
 * 项目共享常量
 */

/** 空页面的初始 Tiptap JSON(函数式,每次返回全新副本,避免共享引用) */
export function emptyDoc(): Record<string, unknown> {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** 空页面的初始 HTML */
export const EMPTY_HTML = '<p></p>'

/** 默认页面标题 */
export const DEFAULT_TITLE = '无标题页面'

/**
 * 规范化页面标题:trim 之后如果为空,回退到 DEFAULT_TITLE。
 */
export function normalizeTitle(title: string | undefined | null): string {
  const t = (title ?? '').trim()
  return t || DEFAULT_TITLE
}