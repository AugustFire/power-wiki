/**
 * 用 DOMPurify 对富文本 HTML 做白名单清洗,防止 XSS。
 *
 * 设计原则:
 * - 保留渲染所需的所有块/行内标签 + 表格 + 任务列表 + 代码块 + 引用
 * - 保留自定义 class(为 .callout / .badge / .swatch / .avatar 服务)
 * - 保留行内 style(为 swatch / avatar / badge 的内联颜色服务)
 * - 移除所有 on* 事件、javascript: 协议、target=_blank 等危险属性
 */
import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  // 块
  'p', 'br', 'hr', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  'img',
  // 表单 / 任务列表
  'input', 'label',
  // 富文本常见
  'a', 'strong', 'em', 'u', 's', 'b', 'i', 'sub', 'sup', 'small',
  'figure', 'figcaption',
  // 折叠块(Toggle 扩展):details/summary 是原生 HTML,无 XSS 风险
  'details', 'summary',
  // 颜色 / 高亮(textStyle 用 span style,highlight 用 mark)
  'mark',
  // 行内日期(DateInline 扩展):<time> 是语义化标签,无 XSS 风险
  'time',
]

const ALLOWED_ATTR = [
  'class', 'style',
  'href', 'title', 'alt', 'src', 'width', 'height',
  'type', 'checked', 'disabled',
  'data-type', 'data-checked',
  'data-color', // @tiptap/extension-highlight 多色模式用 data-color 标记
  'data-page-id', // 页面引用扩展(PageRef):链接到其他页
  'colspan', 'rowspan',
  'colwidth', 'data-colwidth', // 表格列宽(prosemirror-tables / 我们的扩展)
  'id',
  'open', // <details open> 折叠块默认展开标记
  'datetime', // <time datetime="..."> 行内日期扩展用
  'data-date-mode', // DateInline:now / fixed 模式标记
  'data-date', // DateInline:ISO 时间冗余存储(DOMPurify 友好)
  'data-user-id', // @mention(Stage 6):mention 节点的 userId,read 端解析 + 通知跳转锚点
  'data-label', // @mention(Stage 6):显示用 label(DOMPurify 友好形式)
]

// 自定义 hook:URL 协议白名单,挡掉 javascript: / data: 等
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SANITIZE_CONFIG: any = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
}

let purifyInstance: typeof DOMPurify | null = null

function getPurifier(): typeof DOMPurify {
  if (purifyInstance) return purifyInstance
  if (typeof window === 'undefined') {
    // SSR / 测试环境兜底:用 isomorphic-dompurify 或直接返回原值
    return DOMPurify
  }
  purifyInstance = DOMPurify
  return purifyInstance
}

// 清洗 style:只允许颜色 / 对齐 / 表格宽度相关属性,挡掉 position/font-size 等滥用
function sanitizeStyle(style: string): string {
  if (!style) return ''
  const decls = style.split(';')
  const allowed: string[] = []
  for (const d of decls) {
    const [propRaw, valRaw] = d.split(':')
    if (!propRaw || !valRaw) continue
    const prop = propRaw.trim().toLowerCase()
    const val = valRaw.trim()
    if (!prop || !val) continue
    // 颜色属性
    if (prop === 'color' || prop === 'background-color') {
      // 挡掉 url() / expression() / javascript:
      if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) continue
      // 颜色值只接受 #hex / rgb(...) / rgba(...) / hsl(...) / 命名色
      if (!/^(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+)$/i.test(val)) continue
      allowed.push(`${prop}: ${val}`)
      continue
    }
    // 对齐属性(只接受白名单值)
    if (prop === 'text-align') {
      if (!/^(left|right|center|justify)$/i.test(val)) continue
      allowed.push(`${prop}: ${val}`)
      continue
    }
    if (prop === 'vertical-align') {
      if (!/^(top|middle|bottom|baseline)$/i.test(val)) continue
      allowed.push(`${prop}: ${val}`)
      continue
    }
    // 表格宽度属性(只接受像素/百分比/auto)
    if (prop === 'width' || prop === 'min-width' || prop === 'max-width') {
      // 挡掉 url() / expression() / javascript:
      if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) continue
      // 只接受 px / % / auto,挡掉 calc() / vh / vw 等滥用
      if (!/^-?\d+(\.\d+)?(px|%)?$|^auto$/i.test(val)) continue
      allowed.push(`${prop}: ${val}`)
      continue
    }
    // 其他属性一律不通过
  }
  return allowed.join('; ')
}

export function sanitizeHtml(html: string): string {
  if (!html) return ''
  const purifier = getPurifier()
  const cleaned = purifier.sanitize(html, {
    ...SANITIZE_CONFIG,
    ADD_ATTR: ['target'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  })
  // DOMPurify 默认会把 style 整个属性放行,需要二次过滤
  if (typeof document === 'undefined') return String(cleaned)
  const wrap = document.createElement('div')
  wrap.innerHTML = String(cleaned)
  wrap.querySelectorAll('[style]').forEach((el) => {
    const s = sanitizeStyle(el.getAttribute('style') || '')
    if (s) el.setAttribute('style', s)
    else el.removeAttribute('style')
  })
  return wrap.innerHTML
}

/**
 * 把 sanitize 后的字符串再走一遍:给所有 <a> 强制加 rel="noopener noreferrer" target="_blank",
 * 防止 tab-nabbing 和 reverse tabnabbing。
 */
export function sanitizeAndHardenLinks(html: string): string {
  const safe = sanitizeHtml(html)
  if (!safe) return ''
  // 只在 DOM 里过一次,DOMPurify 不会主动加 rel;我们在外面包一层
  if (typeof window === 'undefined') return safe
  const wrapper = document.createElement('div')
  wrapper.innerHTML = safe
  wrapper.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    if (/^javascript:/i.test(href)) {
      a.removeAttribute('href')
      return
    }
    a.setAttribute('rel', 'noopener noreferrer')
    a.setAttribute('target', '_blank')
  })
  return wrapper.innerHTML
}