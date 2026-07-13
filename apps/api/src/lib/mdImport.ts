/**
 * Markdown → Tiptap JSON + HTML 转换 utility。
 *
 * ## 选型理由:为啥用 prosemirror-markdown 而不装 tiptap-markdown + happy-dom
 *  - tiptap-markdown 需要一个真实 Editor 实例(读 editor.schema + storage.markdown),
 *    Node 端没有 DOM,得装 happy-dom / jsdom 多一个 ~10MB 依赖。
 *  - prosemirror-markdown 是它的底层,只 export `defaultMarkdownParser` / `defaultMarkdownSerializer` /
 *    `MarkdownParser` / `MarkdownSerializer` 等纯函数,无 DOM 要求。
 *  - Prosemirror node 的 `toJSON()` 跟 Tiptap contentJSON schema 兼容(都是 ProseMirror
 *    schema 序列化),`pages.contentJson` 字段直接吃。
 *  - 5 个 Tiptap 自定义节点(callout / toggle / pageRef / mention / imageAttachment)
 *    不会出现用户在标准 MD 文件里 → 不需要扩展。toggling / 复杂格式会被 prosemirror
 *    解析成 blockquote / paragraph(已经能 cover)。
 *
 * ## 两层"输出"必须对齐 Tiptap 的 schema
 *  prosemirror-markdown 用的 prosemirror-schema-basic + prosemirror-schema-list
 *  节点名是 **snake_case**(bullet_list / list_item / code_block / ordered_list),
 *  而前端 Tiptap StarterKit 是 **camelCase**(bulletList / listItem / codeBlock)。
 *  - contentJSON:经过 `toCamelCaseNodeTypes` 映射后,Tiptap EditView 才能正常
 *    setContent / 反序列化(否则节点全是 unknown,渲染降级为纯文本)。
 *  - contentHTML:ReadView 直接走 `sanitizeAndHardenLinks(contentHTML)`(不走
 *    Tiptap,只用 HTML 字符串),所以必须由 `nodeToHTML` 同步产出 **HTML** —
 *    不能用 `defaultMarkdownSerializer.serialize(node)`,那个返回的是原始 MD
 *    文本(它是 Markdown→Markdown 序列化器,不是 HTML)。
 *
 * ## GFM 表格(prosemirror-markdown 默认不解析)
 *  markdown-it 默认不开 GFM table 解析,prosemirror-markdown 默认 schema 也
 *  没有 table / tableRow / tableHeader / tableCell 节点。所以表格整段降级为
 *  paragraph + 管道字符 — 看起来像纯文本,信息全在但没法浏览。
 *
 *  解决方案:解析前**手工**扫描 GFM 表格块(行 | ... | + 分隔 | --- | + 数据行),
 *  把每张表替换成一个 inline 标记 `__TABLE_<idx>__`,然后:
 *    1. 用 prosemirror-markdown 解析 masked 文本(无表,无副作用)。
 *    2. 走一遍 doc.content,把"placeholder paragraph"替换成 table 节点。
 *    3. 走一遍 contentHTML,把 `<p>__TABLE_<idx>__</p>` 替换成 `<table>...</table>`。
 *  单元格内的 inline 内容(粗体/斜体/code/link)走 `tokenizer.parseInline`
 *  解析,直接构造成 Tiptap paragraph + text + marks。
 *
 *  没引 markdown-it-multimd-table 插件,也没引 happy-dom —— 仍然纯字符串处理。
 *  已知限制:不支持嵌套表格、表格里再嵌列表 / blockquote / code block(单元格里
 *  只能有 inline + paragraph)。用户在标准 MD 里写表格通常就是表格 + inline,
 *  这个限制可以接受。
 *
 * ## 图片处理
 *  - prosemirror-markdown 默认解析 `![alt](src)` 为 `{ type: 'image', attrs: { src, alt, title } }`,
 *    Tiptap 没有 Image 扩展(CLAUDE.md 硬约束),即使 JSON 化后会渲染空白。
 *  - 解决方案:解析前用 `stripImageSyntaxInText` 文本级清洗,把图片替换成 alt 文字,
 *    prosemirror 永远看不到 image 节点,不需要 schema 适配。
 *  - 后续 v2 可走"提取本地图片 → 上传 MinIO → 替换成 imageAttachment 节点"路径。
 *
 * ## 标题提取
 *  - extractH1 返回首个 `# {title}` 行,trim 后 1-100 字符。
 *  - 忽略 frontmatter(以 `---` 起首的 YAML 块)— v1 不解析 frontmatter。
 */
import {
  defaultMarkdownParser,
  schema as markdownSchema,
} from 'prosemirror-markdown'
import type { Node as PMNode, Mark } from 'prosemirror-model'
import type Token from 'markdown-it/lib/token.mjs'
import type { TiptapJSON } from '@power-wiki/shared'

export interface ParsedMarkdown {
  /** 落 pages.contentJson 字段,EditView 直接 setContent。节点名已映射 camelCase。 */
  tiptapJSON: TiptapJSON
  /** 落 pages.contentHtml 字段,ReadView SSR / sanitizeAndHardenLinks 后渲染。 */
  contentHTML: string
  /** 首个 H1 标题(去掉 `# ` 前缀 + trim);无则 null */
  h1Title: string | null
}

/**
 * Extract the first H1 (`# ...`) from raw Markdown text. Skips a leading
 * YAML frontmatter block (`---\n...\n---\n...`). Returns null if no H1
 * is found, the title is empty, or the title exceeds 100 chars.
 */
export function extractH1(text: string): string | null {
  // Strip leading frontmatter (if any) so `title:` inside YAML isn't mistaken.
  const stripped = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const match = stripped.match(/^#\s+(.+?)\s*$/m)
  if (!match) return null
  const title = match[1]!.trim()
  if (!title) return null
  if (title.length > 100) return title.slice(0, 100)
  return title
}

/**
 * Preprocess Markdown text to remove all inline image references.
 *  - `![alt](url)`         → `*[alt]*`  (alt 保留为斜体文本,url 丢弃)
 *  - `![alt](url "title")` → `*[alt]*`  (title 也丢弃,v1 不存)
 *  - `![](url)`            → 空字符串
 *  - 行内图片(text![alt](url)text)→ 前后文字保留,中间变 *alt*
 *
 * 在 parse **前**做这个清洗,prosemirror 就不会产出 `image` 节点 —
 * 不需要 schema 感知,也不需要操作 ProseMirror 事务。同时保留了 alt
 * 文字作为可读内容,符合"图片丢失但 alt 留着"的常用 import 行为。
 */
function stripImageSyntaxInText(text: string): string {
  // 匹配 ![alt](url ["title"]) — alt 允许为空(无 alt 也吃),url 必须非空白
  return text.replace(/!\[([^\]]*)\]\(\s*\S+?(?:\s+["'][^"']*["'])?\s*\)/g, (_m, alt: string) => {
    const a = (alt ?? '').trim()
    return a ? `*${a}*` : ''
  })
}

/* ─── GFM 表格提取 ──────────────────────────────────────────────────── */

type Align = 'left' | 'center' | 'right' | null

interface ExtractedTable {
  /** 第一行表头 + 第三行起数据行(不含分隔行) */
  rows: string[][]
  /** 与列数对齐的 alignments(从分隔行解析),无对齐时为 null */
  alignments: Align[]
}

const TABLE_PLACEHOLDER = (idx: number) => `[PW-TABLE:${idx}]`
const TABLE_PLACEHOLDER_RE = /^\[PW-TABLE:(\d+)\]$/

/** 一行是否看起来像 GFM 表格行:首尾是 `|`,中间至少还有一个 `|`。 */
function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

/**
 * 一行是否像 GFM 分隔行:每段都是 `[-:]+`,可选 `:` 起首/结尾表示对齐。
 * 例:`| :--- | :---: | ---: |` → [left, center, right]。
 */
function isSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)
}

function parseSeparator(line: string): Align[] {
  // 去掉首尾 | 再按 | 切
  const inner = line.replace(/^\s*\||\|\s*$/g, '')
  const cells = inner.split('|')
  return cells.map((cell) => {
    const c = cell.trim()
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** 切一行表格的单元格(去首尾 `|`,按 `|` split,逐个 trim)。 */
function parseTableRow(line: string): string[] {
  const inner = line.replace(/^\s*\||\|\s*$/g, '')
  return inner.split('|').map((c) => c.trim())
}

/**
 * 扫描 MD 文本,把每段 GFM 表格(表头 + 分隔 + 数据行)替换成
 * `__TABLE_<idx>__` 占位符。返回 masked 文本 + 提取出来的表格列表。
 *
 * 注意:分隔行必须在表头**紧接的下一行**(GFM 严格定义);数据行必须以
 * `|` 起首 / 结尾,空行终止表格块。判定空行 / 非 `|` 行作为表格边界。
 */
function extractTables(text: string): { masked: string; tables: ExtractedTable[] } {
  const lines = text.split('\n')
  const tables: ExtractedTable[] = []
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (
      isTableLine(lines[i]!) &&
      i + 1 < lines.length &&
      isSeparatorLine(lines[i + 1]!)
    ) {
      const header = parseTableRow(lines[i]!)
      const alignments = parseSeparator(lines[i + 1]!)
      const rows: string[][] = [header]
      let j = i + 2
      while (j < lines.length && isTableLine(lines[j]!)) {
        rows.push(parseTableRow(lines[j]!))
        j++
      }
      tables.push({ rows, alignments })
      out.push(TABLE_PLACEHOLDER(tables.length - 1))
      i = j
    } else {
      out.push(lines[i]!)
      i++
    }
  }
  return { masked: out.join('\n'), tables }
}

/* ─── markdown-it inline token → PM 段落 ─────────────────────────────── */

/**
 * 走 markdown-it 的 inline token list,构造一个 Tiptap paragraph 节点
 * (Tiptap `tableCell` / `tableHeader` 节点内容里只允许 paragraph+,不可
 * 直接放 text/text+marks)。
 *
 * 支持的 mark(够 cover 测试 MD 里的场景):strong / em / code / link /
 * strikethrough / hard_break。
 */
function inlineTokensToParagraph(tokens: Token[]): TiptapJSON {
  const content: TiptapJSON[] = []
  let activeMarks: Mark[] = []
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        content.push({
          type: 'text',
          text: tok.content,
          marks: activeMarks.map((m) => ({ type: m.type.name, attrs: m.attrs })),
        })
        break
      }
      case 'softbreak':
      case 'hardbreak':
        // 表格单元格内通常不期待换行 — 把换行转成空格,保持 inline 单行语义
        if (content.length > 0) {
          const last = content[content.length - 1] as { type: string; text?: string }
          if (last && last.type === 'text' && typeof last.text === 'string') {
            last.text += ' '
          }
        }
        break
      case 'strong_open':
      case 'em_open':
      case 'code_inline':
      case 's_open':
      case 'link_open':
        activeMarks.push({
          type: tok.type === 'code_inline'
            ? 'code'
            : tok.type === 's_open'
              ? 'strikethrough'
              : tok.type === 'link_open'
                ? 'link'
                : (tok.type.replace('_open', '') as 'strong' | 'em'),
          attrs: tok.type === 'link_open'
            ? { href: tok.attrGet('href') ?? '' }
            : {},
        } as unknown as Mark)
        break
      case 'strong_close':
      case 'em_close':
      case 's_close':
      case 'link_close':
        activeMarks.pop()
        break
      default:
        // 未知 token — 跳过
        break
    }
  }
  return { type: 'paragraph', content }
}

/**
 * 走 markdown-it 的 inline token list,产出 HTML(用于 contentHTML)。
 * Tiptap ReadView 拿 contentHTML 直接 v-html,所以 inline 渲染要齐全。
 */
function inlineTokensToHTML(tokens: Token[]): string {
  let html = ''
  let activeMarks: string[] = []
  const attrsOf = (mark: string): string => {
    if (mark === 'link') return ''
    return ''
  }
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
        html += wrapMarks(escapeHTML(tok.content), activeMarks)
        break
      case 'softbreak':
      case 'hardbreak':
        html += ' '
        break
      case 'strong_open':
        activeMarks.push('strong')
        break
      case 'em_open':
        activeMarks.push('em')
        break
      case 'code_inline':
        html += `<code>${escapeHTML(tok.content)}</code>`
        break
      case 's_open':
        activeMarks.push('s')
        break
      case 'link_open':
        activeMarks.push(`a:${tok.attrGet('href') ?? ''}`)
        break
      case 'strong_close':
      case 'em_close':
      case 's_close':
        activeMarks.pop()
        break
      case 'link_close':
        activeMarks.pop()
        break
      default:
        break
    }
  }
  return html

  function wrapMarks(text: string, marks: string[]): string {
    let out = text
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i]!
      if (m === 'strong') out = `<strong>${out}</strong>`
      else if (m === 'em') out = `<em>${out}</em>`
      else if (m === 's') out = `<s>${out}</s>`
      else if (m.startsWith('a:')) {
        const href = escapeAttr(m.slice(2))
        out = `<a href="${href}">${out}</a>`
      }
    }
    return out
  }
  // attrsOf kept for symmetry; not currently used.
  void attrsOf
}

/* ─── 表格节点构造 ──────────────────────────────────────────────────── */

/**
 * 用 `tokenizer.parseInline` 解析单元格内容 → 构造 paragraph JSON。
 * paragraph 是 Tiptap `tableCell` / `tableHeader` 的合法内容。
 */
function cellToParagraphJSON(cellText: string): TiptapJSON {
  const tokens = defaultMarkdownParser.tokenizer.parseInline(cellText, {})
  // parseInline 返回的是 [inline, ...] 一组 token;flatten 出 children
  const children: Token[] = []
  for (const tok of tokens) {
    if (tok.type === 'inline' && tok.children) {
      children.push(...tok.children)
    } else if (tok.type !== 'inline') {
      children.push(tok)
    }
  }
  return inlineTokensToParagraph(children)
}

function cellToHTML(cellText: string): string {
  const tokens = defaultMarkdownParser.tokenizer.parseInline(cellText, {})
  const children: Token[] = []
  for (const tok of tokens) {
    if (tok.type === 'inline' && tok.children) {
      children.push(...tok.children)
    } else if (tok.type !== 'inline') {
      children.push(tok)
    }
  }
  return inlineTokensToHTML(children)
}

/**
 * Tiptap 的 tableRow content 顺序:必须依次放 tableHeader (N 个,等于列数)
 * 再放 tableCell (每行 N 个)。v1 不做列对齐 attrs(对齐信息从表格 HTML 体现,
 * EditView 重新渲染时也只是按列平铺)。
 */
function buildTableJSON(t: ExtractedTable): TiptapJSON {
  const [header, ...body] = t.rows
  return {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: (header ?? []).map((cell) => ({
          type: 'tableHeader',
          attrs: {},
          content: [cellToParagraphJSON(cell)],
        })),
      },
      ...body.map((row) => ({
        type: 'tableRow',
        content: row.map((cell) => ({
          type: 'tableCell',
          attrs: {},
          content: [cellToParagraphJSON(cell)],
        })),
      })),
    ],
  }
}

function buildTableHTML(t: ExtractedTable): string {
  const [header, ...body] = t.rows
  const ths = (header ?? [])
    .map((c) => `<th>${cellToHTML(c) || '<br>'}</th>`)
    .join('')
  const trs = body
    .map((row) => `<tr>${row.map((c) => `<td>${cellToHTML(c) || '<br>'}</td>`).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`
}

/* ─── 节点名映射(snake_case → camelCase) ─────────────────────────────── */

const NODE_NAME_MAP: Record<string, string> = {
  bullet_list: 'bulletList',
  ordered_list: 'orderedList',
  list_item: 'listItem',
  code_block: 'codeBlock',
  horizontal_rule: 'horizontalRule',
  hard_break: 'hardBreak',
}

/**
 * 把 ProseMirror node 树的 toJSON() 输出里 type 字段从 snake_case 映射到
 * camelCase。递归遍历 content 数组,不改变 marks / attrs / text。
 */
function toCamelCaseNodeTypes(node: PMNode): TiptapJSON {
  const json = node.toJSON() as Record<string, unknown>
  return mapTypeDeep(json) as TiptapJSON
}

function mapTypeDeep(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(mapTypeDeep)
  const obj = node as Record<string, unknown>
  const out: Record<string, unknown> = { ...obj }
  if (typeof out['type'] === 'string' && NODE_NAME_MAP[out['type']]) {
    out['type'] = NODE_NAME_MAP[out['type']]
  }
  if ('content' in out) {
    out['content'] = mapTypeDeep(out['content'])
  }
  return out
}

/* ─── 占位符替换 ───────────────────────────────────────────────────── */

/**
 * 替换 doc.content 里的 placeholder paragraph 为 table 节点。
 * 原地修改,返回新数组(保持 PM 一致性)。
 */
function substituteTablesInJSON(
  docContent: TiptapJSON[],
  tables: ExtractedTable[],
): TiptapJSON[] {
  const out: TiptapJSON[] = []
  for (const node of docContent) {
    const placeholderIdx = matchPlaceholder(node)
    if (placeholderIdx !== null && tables[placeholderIdx]) {
      out.push(buildTableJSON(tables[placeholderIdx]!))
    } else {
      out.push(node)
    }
  }
  return out
}

/** 如果节点是单个 text 节点、内容形如 `__TABLE_<idx>__`,返 idx;否则 null。 */
function matchPlaceholder(node: TiptapJSON): number | null {
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>
  if (obj['type'] !== 'paragraph') return null
  const content = obj['content']
  if (!Array.isArray(content) || content.length !== 1) return null
  const inner = content[0] as Record<string, unknown>
  if (inner['type'] !== 'text' || typeof inner['text'] !== 'string') return null
  const m = inner['text'].match(TABLE_PLACEHOLDER_RE)
  return m ? Number(m[1]) : null
}

/**
 * 替换 contentHTML 里 `<p>__TABLE_<idx>__</p>` 块为 table HTML。
 * 占位符在 masked MD 里是单独的 paragraph,所以这里走 `<p>...</p>` 匹配。
 */
function substituteTablesInHTML(html: string, tables: ExtractedTable[]): string {
  // placeholder 是单 token text node,prosemirror-markdown 把 `[PW-TABLE:N]`
  // 这种 inline 文本包在 <p>...</p> 里。替换整个 <p>...</p> 块。
  return html.replace(/<p>\[PW-TABLE:(\d+)\]<\/p>/g, (_m, idxStr: string) => {
    const idx = Number(idxStr)
    return tables[idx] ? buildTableHTML(tables[idx]!) : ''
  })
}

/* ─── HTML 序列化器(prosemirror-markdown 输出用) ───────────────────── */

function nodeToHTML(node: PMNode): string {
  switch (node.type.name) {
    case 'doc':
      return node.content.content.map(nodeToHTML).join('')

    case 'paragraph':
      return `<p>${node.content.content.map(inlineToHTML).join('')}</p>`

    case 'heading': {
      const level = (node.attrs['level'] as number | undefined) ?? 1
      const safeLevel = Math.max(1, Math.min(6, level))
      return `<h${safeLevel}>${node.content.content.map(inlineToHTML).join('')}</h${safeLevel}>`
    }

    case 'blockquote':
      return `<blockquote>${node.content.content.map(nodeToHTML).join('')}</blockquote>`

    case 'bullet_list':
      return `<ul>${node.content.content.map(nodeToHTML).join('')}</ul>`
    case 'ordered_list': {
      const start = (node.attrs['order'] as number | undefined) ?? 1
      const startAttr = start !== 1 ? ` start="${start}"` : ''
      return `<ol${startAttr}>${node.content.content.map(nodeToHTML).join('')}</ol>`
    }
    case 'list_item':
      return `<li>${node.content.content.map(nodeToHTML).join('')}</li>`

    case 'code_block': {
      const lang = (node.attrs['params'] as string | undefined) ?? ''
      const text = node.content.content.map((c) => (c.text ?? '')).join('')
      const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : ''
      return `<pre><code${langClass}>${escapeHTML(text)}</code></pre>`
    }

    case 'horizontal_rule':
      return '<hr>'

    case 'text':
      return applyMarks(node)

    case 'hard_break':
      return '<br>'

    // image 节点在 stripImageSyntaxInText 已被清洗掉,理论上不到这里。兜底渲染 alt。
    case 'image': {
      const alt = (node.attrs['alt'] as string | undefined) ?? ''
      return alt ? `<em>${escapeHTML(alt)}</em>` : ''
    }

    default:
      return node.content.content.map(inlineToHTML).join('')
  }
}

function inlineToHTML(node: PMNode): string {
  if (node.type.name === 'text') return applyMarks(node)
  if (node.type.name === 'hard_break') return '<br>'
  return ''
}

function applyMarks(text: PMNode): string {
  let html = escapeHTML(text.text ?? '')
  const marks: readonly Mark[] = text.marks
  const order = ['link', 'code', 'em', 'strong', 'strikethrough']
  const sorted = [...marks].sort((a: Mark, b: Mark) => order.indexOf(a.type.name) - order.indexOf(b.type.name))
  for (const mark of sorted) {
    switch (mark.type.name) {
      case 'strong':
        html = `<strong>${html}</strong>`
        break
      case 'em':
        html = `<em>${html}</em>`
        break
      case 'code':
        html = `<code>${html}</code>`
        break
      case 'strikethrough':
        html = `<s>${html}</s>`
        break
      case 'link': {
        const href = (mark.attrs['href'] as string | undefined) ?? ''
        const safeHref = escapeAttr(href)
        html = `<a href="${safeHref}">${html}</a>`
        break
      }
      default:
        break
    }
  }
  return html
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/* ─── 主入口 ───────────────────────────────────────────────────────── */

/**
 * Parse raw Markdown to Tiptap-compatible JSON + HTML.
 *
 * Pipeline:
 *  1. 文本级清洗图片(`![alt](url)` → `*alt*`)
 *  2. 抽取 GFM 表格,替换为 `__TABLE_<idx>__` 占位符
 *  3. 用 prosemirror-markdown 解析 masked 文本
 *  4. JSON 走 snake_case → camelCase 映射 + 表格占位符替换成 table 节点
 *  5. HTML 走节点序列化 + 表格占位符替换成 <table> HTML
 *
 * Empty input returns an empty doc.
 */
export function parseMarkdown(text: string): ParsedMarkdown {
  const trimmed = text.trim()
  if (!trimmed) {
    const empty: TiptapJSON = { type: 'doc', content: [] }
    return { tiptapJSON: empty, contentHTML: '', h1Title: null }
  }
  const cleanedText = stripImageSyntaxInText(trimmed)
  const { masked, tables } = extractTables(cleanedText)
  const node: PMNode = defaultMarkdownParser.parse(masked, markdownSchema)
  // JSON: 走 camelCase + 表格占位符替换
  const camelJSON = toCamelCaseNodeTypes(node)
  const docContent = (camelJSON as Record<string, unknown>)['content']
  if (Array.isArray(docContent)) {
    ;(camelJSON as Record<string, unknown>)['content'] = substituteTablesInJSON(
      docContent as TiptapJSON[],
      tables,
    )
  }
  // HTML: 走节点序列化 + 表格占位符替换
  const rawHTML = nodeToHTML(node)
  const contentHTML = substituteTablesInHTML(rawHTML, tables)
  return {
    tiptapJSON: camelJSON,
    contentHTML,
    h1Title: extractH1(trimmed),
  }
}