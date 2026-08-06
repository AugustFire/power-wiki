/**
 * 服务端 Tiptap / ProseMirror Schema 镜像 —— 给 y-prosemirror 在
 * 「JSON ↔ Y.Doc」两条方向做 codegen / decode 用。
 *
 * 为什么需要:
 *   apps/web 用 Tiptap extensions 构建的 schema 是「事实来源」,但 server
 *   side 只跟 Y.Doc 字节打交道,Yjs 是 schema-agnostic;一旦要把
 *   `pages.contentJson`(Tiptap 产出的 ProseMirror JSON)灌进 Y.Doc 做冷启动
 *   hydration,或者把 Y.Doc 重新 mirror 回 pages.contentJson,就必须有一份
 *   服务端 schema 知道每个 node / mark 的名字 + attrs + content 模型。
 *
 * 设计目标:
 *   - 覆盖 client extensions.ts 里所有 node / mark + 表头 / 表行 / 表单元格 attrs。
 *   - 提供 toDOM —— 镜像到 HTML 时走 prosemirror-model DOMSerializer。
 *   - 不实现 parseHTML —— server 端永远不解析 HTML(只读 contentJson → Y,或
 *     Y → contentJson → HTML;HTML 是末端的渲染输出,不参与 schema 决策)。
 *
 * 关键约束(沿用项目硬约束):
 *   - 不引 a11y(内部 R&D 工具,schema 是 codegen 用的,不需要 ARIA)。
 *   - attrs 名 / 默认值必须跟客户端 addAttributes() 严格对齐,否则
 *     prosemirrorJSONToYDoc 在 client → server 方向迁移时丢字段;
 *     yDocToProsemirrorJSON 反向迁移时字段顺序漂移。
 *   - 不在服务端引入 Tiptap Extension 体系(那是 client 层的抽象),只
 *     用 prosemirror-model Schema 直接构造 —— 体积小,无 Vue 依赖。
 *
 * 服务端不引 DOM types:parseDOM/getAttrs 回调的 element 用 `unknown`
 * 收口,内部 narrow 到 `{ getAttribute(name: string): string | null;
 * querySelector(sel: string): unknown; style: { color?: string;
 * textAlign?: string } }`。这层 duck-type 足够覆盖 schema 决策所需
 * 的 4-5 个属性,不需要把 @types/web 拉进 api。
 */
import { Schema, type NodeSpec, type MarkSpec, type DOMOutputSpec } from '@tiptap/pm/model'

/** 服务端 DOM 抽象 —— duck-type 替代 HTMLElement,只在 schema 层用。 */
interface DomLike {
  getAttribute(name: string): string | null
  querySelector(sel: string): DomLike | null
  style: {
    color?: string
    textAlign?: string
  }
  nodeName?: string
  textContent?: string | null
}
const asDom = (el: unknown): DomLike => el as DomLike

/**
 * 7 个自定义节点 + StarterKit 全套 + 表格族 + 字体 / 颜色 marks 集合。
 *
 * 每加一个客户端 node / mark,这里必须同步加对应 spec,否则 hydration
 * 会抛 "Node type X not in schema"。加 attrs 也要同步 —— 不然 server
 * 读到的 JSON 会缺字段,客户端拿到后 normalize 时报错。
 */

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: 'block+',
  },

  paragraph: {
    content: 'inline*',
    group: 'block',
    attrs: {
      textAlign: { default: null as string | null },
    },
    parseDOM: [{ tag: 'p' }],
    toDOM(node): DOMOutputSpec {
      const align = node.attrs['textAlign']
      const attrs = align ? { style: `text-align: ${align}` } : {}
      return ['p', attrs, 0]
    },
  },

  /** PM 的内联 text 节点 —— 没有 attrs,group=inline 是默认约定。 */
  text: {
    group: 'inline',
  },

  heading: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: {
      level: { default: 1 },
      textAlign: { default: null as string | null },
    },
    parseDOM: [
      { tag: 'h1', attrs: { level: 1 } },
      { tag: 'h2', attrs: { level: 2 } },
      { tag: 'h3', attrs: { level: 3 } },
      { tag: 'h4', attrs: { level: 4 } },
      { tag: 'h5', attrs: { level: 5 } },
      { tag: 'h6', attrs: { level: 6 } },
    ],
    toDOM(node): DOMOutputSpec {
      const level = Math.max(1, Math.min(6, Number(node.attrs['level']) || 1))
      const align = node.attrs['textAlign']
      const attrs = align ? { style: `text-align: ${align}` } : {}
      return [`h${level}`, attrs, 0]
    },
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    attrs: {
      cite: { default: null as string | null },
    },
    parseDOM: [{ tag: 'blockquote' }],
    toDOM(node): DOMOutputSpec {
      const cite = node.attrs['cite']
      const attrs = typeof cite === 'string' && cite.trim() ? { cite, 'data-citation-url': cite } : {}
      return ['blockquote', attrs, 0]
    },
  },

  codeBlock: {
    content: 'text*',
    group: 'block',
    code: true,
    defining: true,
    marks: '',
    attrs: {
      language: { default: null as string | null },
    },
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (el) => {
          const e = asDom(el)
          const code = e.querySelector('code')
          const lang = code?.getAttribute('class')?.match(/language-([\w-]+)/)?.[1] ?? null
          return { language: lang }
        },
      },
    ],
    toDOM(node): DOMOutputSpec {
      const lang = node.attrs['language']
      const codeAttrs = lang ? { class: `language-${lang}` } : {}
      return ['pre', ['code', codeAttrs, 0]]
    },
  },

  hardBreak: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM(): DOMOutputSpec {
      return ['br']
    },
  },

  horizontalRule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM(): DOMOutputSpec {
      return ['hr']
    },
  },

  bulletList: {
    content: 'listItem+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM(): DOMOutputSpec {
      return ['ul', 0]
    },
  },

  orderedList: {
    content: 'listItem+',
    group: 'block',
    attrs: {
      start: { default: 1 },
    },
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (el) => {
          const e = asDom(el)
          const startAttr = e.getAttribute('start')
          return { start: startAttr ? Number(startAttr) : 1 }
        },
      },
    ],
    toDOM(node): DOMOutputSpec {
      const start = Number(node.attrs['start']) || 1
      const attrs = start !== 1 ? { start: String(start) } : {}
      return ['ol', attrs, 0]
    },
  },

  listItem: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM(): DOMOutputSpec {
      return ['li', 0]
    },
  },

  taskList: {
    content: 'taskItem+',
    group: 'block',
    attrs: {
      dataType: { default: 'taskList' },
    },
    parseDOM: [{ tag: 'ul[data-type="taskList"]' }],
    toDOM(): DOMOutputSpec {
      return ['ul', { 'data-type': 'taskList' }, 0]
    },
  },

  taskItem: {
    content: 'paragraph block*',
    defining: true,
    attrs: {
      checked: { default: false },
    },
    parseDOM: [
      {
        tag: 'li[data-type="taskItem"]',
        getAttrs: (el) => ({
          checked: asDom(el).getAttribute('data-checked') === 'true',
        }),
      },
    ],
    toDOM(node): DOMOutputSpec {
      return [
        'li',
        { 'data-type': 'taskItem', 'data-checked': String(Boolean(node.attrs['checked'])) },
        0,
      ]
    },
  },

  table: {
    content: 'tableRow+',
    group: 'block',
    tableRole: 'table',
    isolating: true,
    parseDOM: [{ tag: 'table' }],
    toDOM(): DOMOutputSpec {
      return ['table', ['tbody', 0]]
    },
  },

  tableRow: {
    content: '(tableCell|tableHeader)+',
    tableRole: 'row',
    parseDOM: [{ tag: 'tr' }],
    toDOM(): DOMOutputSpec {
      return ['tr', 0]
    },
  },

  tableCell: {
    content: 'block+',
    tableRole: 'cell',
    attrs: {
      colwidth: { default: null as number[] | null },
      backgroundColor: { default: null as string | null },
      textAlign: { default: null as string | null },
      verticalAlign: { default: null as string | null },
    },
    parseDOM: [{ tag: 'td' }],
    toDOM(node): DOMOutputSpec {
      const out: Record<string, string> = {}
      const cw = node.attrs['colwidth'] as number[] | null
      if (cw && cw.length) {
        const s = cw.join(',')
        out['colwidth'] = s
        out['data-colwidth'] = s
      }
      const bg = node.attrs['backgroundColor']
      if (bg) out['style'] = `background-color: ${bg}`
      const align = node.attrs['textAlign']
      if (align) out['style'] = (out['style'] ?? '') + `; text-align: ${align}`
      const valign = node.attrs['verticalAlign']
      if (valign) out['style'] = (out['style'] ?? '') + `; vertical-align: ${valign}`
      return ['td', out, 0]
    },
  },

  tableHeader: {
    content: 'block+',
    tableRole: 'header_cell',
    attrs: {
      colwidth: { default: null as number[] | null },
      backgroundColor: { default: null as string | null },
      textAlign: { default: null as string | null },
    },
    parseDOM: [{ tag: 'th' }],
    toDOM(node): DOMOutputSpec {
      const out: Record<string, string> = {}
      const cw = node.attrs['colwidth'] as number[] | null
      if (cw && cw.length) {
        const s = cw.join(',')
        out['colwidth'] = s
        out['data-colwidth'] = s
      }
      const bg = node.attrs['backgroundColor']
      if (bg) out['style'] = `background-color: ${bg}`
      const align = node.attrs['textAlign']
      if (align) out['style'] = (out['style'] ?? '') + `; text-align: ${align}`
      return ['th', out, 0]
    },
  },

  /* ─── 7 个自定义节点 ─────────────────────────────────────────── */

  callout: {
    content: 'block+',
    group: 'block',
    defining: true,
    isolating: true,
    attrs: {
      variant: { default: 'info' },
    },
    parseDOM: [{ tag: 'div.callout' }],
    toDOM(node): DOMOutputSpec {
      const variant = String(node.attrs['variant'] ?? 'info')
      return ['div', { class: `callout ${variant}`, 'data-variant': variant }, 0]
    },
  },

  toggle: {
    content: 'block+',
    group: 'block',
    defining: true,
    isolating: true,
    attrs: {
      open: { default: true },
      title: { default: '' },
    },
    parseDOM: [{ tag: 'details.toggle' }],
    toDOM(node): DOMOutputSpec {
      const open = Boolean(node.attrs['open'])
      const title = String(node.attrs['title'] ?? '')
      const openAttrs = open ? { open: '' } : {}
      return ['details', { class: 'toggle', ...openAttrs }, ['summary', {}, title], ['div', { class: 'toggle-content' }, 0]]
    },
  },

  pageRef: {
    group: 'block',
    atom: true,
    attrs: {
      pageId: { default: null as string | null },
      title: { default: '' },
    },
    parseDOM: [{ tag: 'a.page-ref-card' }],
    toDOM(node): DOMOutputSpec {
      const pageId = String(node.attrs['pageId'] ?? '')
      return [
        'a',
        { class: 'page-ref-card', 'data-page-id': pageId, href: `#/p/${pageId}` },
        0,
      ]
    },
  },

  dateInline: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      iso: { default: '' },
    },
    parseDOM: [{ tag: 'time.date-inline' }],
    toDOM(node): DOMOutputSpec {
      const iso = String(node.attrs['iso'] ?? '')
      return ['time', { class: 'date-inline', datetime: iso, 'data-date': iso }, 0]
    },
  },

  mention: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      userId: { default: null as string | null },
      label: { default: '' },
    },
    parseDOM: [{ tag: 'span.mention-chip' }],
    toDOM(node): DOMOutputSpec {
      const userId = node.attrs['userId']
      const label = String(node.attrs['label'] ?? '')
      const attrs: Record<string, string> = { class: 'mention-chip' }
      if (userId) attrs['data-user-id'] = String(userId)
      if (label) attrs['data-label'] = label
      return ['span', attrs, `@${label}`]
    },
  },

  imageAttachment: {
    group: 'block',
    atom: true,
    attrs: {
      id: { default: null as string | null },
      kind: { default: 'image' },
      mime: { default: '' },
      originalFilename: { default: '' },
      sizeBytes: { default: 0 },
      alt: { default: '' },
      caption: { default: '' },
      align: { default: 'left' },
    },
    parseDOM: [
      { tag: 'figure.attachment-image' },
      { tag: 'figure.attachment-file' },
    ],
    toDOM(node): DOMOutputSpec {
      const attrs = node.attrs as Record<string, unknown>
      const id = attrs['id']
      const kind = String(attrs['kind'] ?? 'image')
      const align = String(attrs['align'] ?? 'left')
      const filename = String(attrs['originalFilename'] ?? '')
      const alt = String(attrs['alt'] ?? '') || filename
      const mime = String(attrs['mime'] ?? '')
      const sizeBytes = Number(attrs['sizeBytes'] ?? 0)
      const caption = String(attrs['caption'] ?? '')
      const src = id ? `/api/attachments/${id}/raw` : ''

      if (kind === 'file') {
        const cardChildren: unknown[] = [
          ['span', { class: 'material-symbols-outlined attachment-file-icon' }, 'description'],
          ['span', { class: 'attachment-file-name' }, filename || '附件'],
        ]
        if (sizeBytes) cardChildren.push(['span', { class: 'attachment-file-size' }, String(sizeBytes)])
        cardChildren.push([
          'a',
          { href: src, download: filename, class: 'attachment-file-download' },
          ['span', { class: 'material-symbols-outlined' }, 'download'],
        ])
        const children: unknown[] = [['div', { class: 'attachment-file-card' }, ...cardChildren]]
        if (caption) children.push(['figcaption', {}, caption])
        return ['figure', { class: 'attachment-file' }, ...children]
      }

      const children: unknown[] = [
        ['img', { src, alt, loading: 'lazy', decoding: 'async' }],
      ]
      if (caption) children.push(['figcaption', {}, caption])
      return ['figure', { class: `attachment-image align-${align}` }, ...children]
    },
  },

  statusBadge: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      text: { default: '' },
      color: { default: 'gray' },
    },
    parseDOM: [{ tag: 'span.status-badge' }],
    toDOM(node): DOMOutputSpec {
      const text = String(node.attrs['text'] ?? '')
      const color = String(node.attrs['color'] ?? 'gray')
      return ['span', { class: 'status-badge', 'data-status-color': color }, text]
    },
  },
}

const marks: Record<string, MarkSpec> = {
  bold: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM(): DOMOutputSpec {
      return ['strong', 0]
    },
  },
  italic: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM(): DOMOutputSpec {
      return ['em', 0]
    },
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }],
    toDOM(): DOMOutputSpec {
      return ['s', 0]
    },
  },
  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM(): DOMOutputSpec {
      return ['code', 0]
    },
  },
  underline: {
    parseDOM: [{ tag: 'u' }],
    toDOM(): DOMOutputSpec {
      return ['u', 0]
    },
  },
  link: {
    attrs: {
      href: { default: '' },
      target: { default: '_blank' },
      rel: { default: 'noopener noreferrer' },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (el) => ({
          href: asDom(el).getAttribute('href') ?? '',
        }),
      },
    ],
    toDOM(mark): DOMOutputSpec {
      return [
        'a',
        {
          href: String(mark.attrs['href'] ?? ''),
          rel: 'noopener noreferrer',
          target: '_blank',
        },
        0,
      ]
    },
  },
  /**
   * textStyle — Color 扩展挂在 textStyle 上(`Color.configure({ types: ['textStyle'] })`),
   * 把 inline `style="color: ..."` 写到 span 里。attrs.color = null 时不写。
   */
  textStyle: {
    attrs: {
      color: { default: null as string | null },
    },
    parseDOM: [
      {
        tag: 'span',
        getAttrs: (el) => {
          const e = asDom(el)
          return { color: e.style.color || null }
        },
      },
    ],
    toDOM(mark): DOMOutputSpec {
      const color = mark.attrs['color']
      return ['span', color ? { style: `color: ${color}` } : {}, 0]
    },
  },
  highlight: {
    attrs: {
      color: { default: null as string | null },
    },
    parseDOM: [
      {
        tag: 'mark',
        getAttrs: (el) => ({
          color: asDom(el).getAttribute('data-color') || null,
        }),
      },
    ],
    toDOM(mark): DOMOutputSpec {
      const color = mark.attrs['color']
      return ['mark', color ? { 'data-color': String(color) } : {}, 0]
    },
  },
}

export const collabSchema = new Schema({ nodes, marks })