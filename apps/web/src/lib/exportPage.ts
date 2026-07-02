/**
 * 单页导出 — HTML / Markdown / PDF。
 *
 * 数据源:`PageNode`(API 返的字段),通过 `pagesStore.getPage(id)` 拿到。
 *
 * HTML 导出:
 *   - 复用 `sanitizeAndHardenLinks`(ReadView 在用)清理 XSS
 *   - 跑一次 `highlightCodeBlocks(clone)` 让代码块语法高亮落到 HTML
 *   - 包成自包含的 <html> 文档,内联最小 prose CSS 子集
 *
 * Markdown 导出:
 *   - 优先用 `contentJSON`,null 时降级 `htmlToJson(contentHTML)`
 *   - 转交给 `jsonToMarkdown`(单例隐藏 Tiptap editor)
 *
 * PDF 导出:
 *   - 零依赖走 `window.print()`(用户选"另存为 PDF")
 *   - 临时改 `document.title` 让浏览器用页标题作默认文件名,print 后还原
 */
import type { PageNode } from '@power-wiki/shared'
import { sanitizeAndHardenLinks } from './sanitize'
import { highlightCodeBlocks } from './renderHighlight'
import { htmlToJson } from '@/editor/htmlToJson'
import { jsonToMarkdown } from './markdownSerializer'

/**
 * 跨平台安全的文件名清洗。
 * - 替换 Windows/macOS 都不允许的字符
 * - 截断 80 字符
 * - 空字符串降级 "untitled"
 */
export function sanitizeFilename(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'untitled'
  )
}

/**
 * 触发浏览器下载。
 * Blob URL 1 秒后 revoke,给浏览器留出开始下载的时间。
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/**
 * 把编辑器 NodeView 烤进 contentHTML 的 UI chrome 剥掉,只留正文结构。
 * 导出(read-only)里这些是纯视觉噪音:
 *   - 代码块:语言切换按钮、复制 / 删除按钮(.code-block-header)、行号 gutter(.code-block-gutter)
 *   - 提示框:右上角 X 按钮(.callout-remove),icon span 里的 Material Symbols ligature
 *     (standalone 文档没那个字体,会原样显成 "error" / "warning" / "check_circle" / "lightbulb")
 *   - 折叠块:.toggle-summary(展开箭头按钮 + title input + 删除按钮)整块;
 *     .toggle-content 里的 children 才是正文
 *
 * 剥完后任何残留的 .material-symbols-outlined 也兜底删了(防御性,
 * 防止以后新增 NodeView 漏掉)。
 *
 * 注意:Callout 的 icon 用 Unicode emoji 替换,保留"四种状态视觉区分"。
 *
 * Exported for unit testing — verify_export_smoke.py 的 step 11 直接调这个函数
 * 验证剥离行为,不依赖真实页面含有 code block / callout / toggle。
 */
export function stripEditorChrome(root: HTMLElement): void {
  // 1. 代码块 UI
  root.querySelectorAll('.code-block-header').forEach((el) => el.remove())
  root.querySelectorAll('.code-block-gutter').forEach((el) => el.remove())

  // 2. 提示框:X 按钮 + icon ligature 替成 emoji
  root.querySelectorAll('.callout-remove').forEach((el) => el.remove())
  const CALLOUT_EMOJI: Record<string, string> = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    danger: '⛔',
  }
  root.querySelectorAll('.callout .icon').forEach((el) => {
    const variant = el.closest('.callout')?.getAttribute('data-variant') || 'info'
    el.textContent = CALLOUT_EMOJI[variant] ?? 'ℹ️'
    el.classList.remove('material-symbols-outlined')
  })

  // 3. 折叠块:summary 整块(展开按钮 + title input + 删除按钮)都属编辑器 UI,
  //    正文在 .toggle-content 里。export 后的结构变成
  //    <details class="toggle" open><div class="toggle-content">...</div></details>
  //    — summary 没了,但 <details> 仍可点击展开/收起。
  root.querySelectorAll('.toggle-summary').forEach((el) => el.remove())

  // 4. 兜底:任何残留的 material-symbols ligature span
  root.querySelectorAll('.material-symbols-outlined').forEach((el) => el.remove())
}

/**
 * 内联最小 prose CSS(~3KB)。
 * 从 components.css 抽出"必需的视觉"子集,把所有 var(--…) 替换成字面值,
 * 让导出的 HTML 离线打开仍然可读。
 * 不内联整个 components.css(会泄露内部变量,文件 50KB)。
 */
const MINIMAL_PROSE_CSS = `
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6;color:#172b4d;background:#fff;max-width:780px;margin:0 auto;padding:48px 32px}
h1{font-size:32px;font-weight:700;margin:0 0 16px;line-height:1.25;color:#091e42}
h2{font-size:24px;font-weight:600;margin:32px 0 12px;line-height:1.3;color:#091e42}
h3{font-size:19px;font-weight:600;margin:24px 0 8px;line-height:1.35;color:#091e42}
h4,h5,h6{font-weight:600;margin:20px 0 8px;color:#091e42}
p{margin:0 0 12px}
ul,ol{margin:12px 0;padding-left:24px}
li{margin-bottom:4px}
strong{font-weight:600}
em{font-style:italic}
code{font-family:"JetBrains Mono",Menlo,Consolas,monospace;font-size:13px;background:#f1f3f5;padding:1px 6px;border-radius:3px;color:#c7254e}
pre{background:#f5f7fa;border:1px solid #e1e4e8;border-radius:6px;padding:14px 16px;overflow-x:auto;line-height:1.5;margin:12px 0}
pre code{background:transparent;padding:0;color:#172b4d;font-size:13px}
blockquote{margin:12px 0;padding:8px 16px;border-left:4px solid #c1c7d0;color:#5e6c84;background:#fafbfc;border-radius:0 4px 4px 0}
blockquote p:last-child{margin-bottom:0}
table{border-collapse:collapse;margin:16px 0;width:100%;font-size:14px}
th,td{border:1px solid #dfe1e6;padding:8px 12px;text-align:left;vertical-align:top}
th{background:#fafbfc;font-weight:600}
hr{border:0;border-top:1px solid #dfe1e6;margin:24px 0}
a{color:#0052cc;text-decoration:none}
a:hover{text-decoration:underline}
.callout{margin:12px 0;padding:12px 16px;border-radius:6px;border:1px solid;display:flex;gap:10px;align-items:flex-start}
.callout .icon{font-size:20px;flex-shrink:0;margin-top:1px;line-height:1}
.callout .callout-body{flex:1;min-width:0}
.callout.info{background:#e9f2ff;border-color:#4c9aff;color:#091e42}
.callout.info .icon{color:#0052cc}
.callout.success{background:#e3fcef;border-color:#00875a;color:#091e42}
.callout.success .icon{color:#00875a}
.callout.warning{background:#fff7e6;border-color:#ff991f;color:#091e42}
.callout.warning .icon{color:#ff8b00}
.callout.danger{background:#ffebe6;border-color:#de350b;color:#091e42}
.callout.danger .icon{color:#de350b}
details.toggle{border:1px solid #dfe1e6;border-radius:6px;padding:0;margin:12px 0;background:#fff}
details.toggle>summary{padding:10px 16px;cursor:pointer;font-weight:600;list-style:none;user-select:none;color:#172b4d}
details.toggle>summary::-webkit-details-marker{display:none}
details.toggle>summary::before{content:"▸";display:inline-block;margin-right:8px;transition:transform 0.15s;color:#5e6c84}
details.toggle[open]>summary::before{transform:rotate(90deg)}
.toggle-content{padding:0 16px 12px}
.page-ref-card{display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid #dfe1e6;border-radius:6px;background:#fafbfc;margin:8px 0;color:#172b4d;text-decoration:none}
.page-ref-card:hover{background:#f1f3f5;text-decoration:none}
.page-ref-icon{font-size:18px;color:#5e6c84}
.mention-chip{display:inline-block;padding:1px 6px;border-radius:3px;background:#e9f2ff;color:#0052cc;font-size:13px}
.date-inline{color:#0052cc;font-variant-numeric:tabular-nums}
ul[data-type="taskList"]{list-style:none;padding-left:0}
ul[data-type="taskList"] li{display:flex;align-items:flex-start;gap:8px;margin-bottom:4px}
ul[data-type="taskList"] li>label{flex-shrink:0;margin-top:5px}
ul[data-type="taskList"] li>div{flex:1;min-width:0}
ul[data-type="taskList"] li>div>p{margin:0}
`

function buildStandaloneHtmlDoc(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Power Wiki</title>
<style>${MINIMAL_PROSE_CSS}</style>
</head>
<body>
<article>
<h1>${escapeHtml(title)}</h1>
<div class="prose">${body}</div>
</article>
</body>
</html>`
}

export async function exportPageAsHtml(page: PageNode): Promise<void> {
  const safe = sanitizeAndHardenLinks(page.contentHTML ?? '')
  // 用 detached div 装 HTML,跑一遍 highlightCodeBlocks 让语法高亮落到 DOM。
  // 注意:不能直接 innerHTML = safe 后再 outerHTML — 这样会把 data-* 等属性丢。
  const wrapper = document.createElement('div')
  wrapper.innerHTML = safe
  highlightCodeBlocks(wrapper)
  stripEditorChrome(wrapper)
  const html = buildStandaloneHtmlDoc(page.title, wrapper.innerHTML)
  triggerDownload(
    new Blob([html], { type: 'text/html;charset=utf-8' }),
    sanitizeFilename(page.title) + '.html',
  )
}

export async function exportPageAsMarkdown(page: PageNode): Promise<void> {
  // 优先 JSON;空页面或早期 seed(无 contentJSON)用 htmlToJson 降级。
  const json = page.contentJSON ?? htmlToJson(page.contentHTML ?? '')
  const md = jsonToMarkdown(json)
  triggerDownload(
    new Blob([md], { type: 'text/markdown;charset=utf-8' }),
    sanitizeFilename(page.title) + '.md',
  )
}

export function exportPageAsPdf(page: PageNode): void {
  // 临时改 document.title,Chrome 打印对话框的"另存为 PDF"会把这个作为默认文件名。
  // setTimeout 是因为 React/Vue 同步渲染可能还来不及更新 title(我们没用框架的 title 管理,
  // 但保留 setTimeout 防止后续重构成 SPA 标题组件时出岔子)。
  // 500ms 后还原 — 留给浏览器对话框启动的时间。
  const original = document.title
  document.title = sanitizeFilename(page.title) + ' — Power Wiki'
  setTimeout(() => {
    window.print()
    setTimeout(() => {
      document.title = original
    }, 500)
  }, 50)
}
