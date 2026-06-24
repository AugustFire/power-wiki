/**
 * 内容文本度量工具 — 给 ReadView 字数、HomeView 摘要等共用。
 *
 * 主要目的是剥离 Tiptap + Material Symbols 注入的"非正文"内容:
 *  - <style>/<script> 标签整体
 *  - 带 material-symbols-outlined class 的 span(图标名字,例如 "format_bold")
 *  - callout-title 等结构标签(纯文本保留)
 *  - 所有 HTML 标签
 * 合并连续空白后做 normalize。
 */

const STYLE_OR_SCRIPT = /<(style|script)[^>]*>[\s\S]*?<\/\1>/gi
const MATERIAL_ICON_SPAN =
  /<span[^>]*class=["'][^"']*material-symbols-outlined[^"']*["'][^>]*>[\s\S]*?<\/span>/gi
const ALL_TAGS = /<[^>]+>/g
const WHITESPACE = /\s+/g

function strip(html: string): string {
  return html
    .replace(STYLE_OR_SCRIPT, '')
    .replace(MATERIAL_ICON_SPAN, '')
    .replace(ALL_TAGS, ' ')
    .replace(WHITESPACE, ' ')
    .trim()
}

/** 取纯文本(已剔除图标 / 标签 / 多余空白) */
export function plainText(html: string): string {
  return strip(html)
}

/** 字数:纯文本长度。HTML 里嵌入的图标 span 文字不计入。 */
export function charCount(html: string): number {
  return plainText(html).length
}

/** 摘要:前 N 字,超长截断加 … */
export function excerpt(html: string, max = 80): string {
  const text = plainText(html)
  return text.length > max ? text.slice(0, max) + '…' : text
}
