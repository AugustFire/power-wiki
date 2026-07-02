/**
 * Markdown export serializer.
 *
 * 单例隐藏 Tiptap editor,把 Tiptap JSON 文档转成 Markdown 字符串。
 * 用 `tiptap-markdown` 这个社区包(0.8.10,Tiptap 2.x 兼容)——
 * 0.9.0 升了 Tiptap 3 peer dep,不兼容本项目。
 *
 * ## 为啥要个隐藏 editor
 * `tiptap-markdown` 的 `MarkdownSerializer` 实例需要在
 * `editor.storage.markdown` 上挂载。它读 `editor.schema` + `extensionManager`
 * 拿每个节点的 serializer。所以必须有 Editor 实例,光有 schema 不够。
 *
 * ## 为啥要 detached DOM
 * 真实 `Editor` 需要挂到一个 element。我们 createElement('div') 但不挂到
 * document,所以 ProseMirror View 会"挂着"但不可见。UI 类扩展
 * (Placeholder / BubbleMenu / DragHandle) 在不可见的 view 上静默。
 *
 * ## 为啥不用 editor.commands.setContent(json)
 * `Markdown` 扩展**重写了** setContent 命令(强制把 content 当 markdown
 * 文本解析),传 JSON 进去会先 JSON.stringify 出 "[object Object]" 然后
 * 解析成垃圾 markdown。绕过的办法是手动 dispatch 一个 ProseMirror
 * transaction 把 doc 整个替换掉,然后调 getMarkdown()。
 *
 * ## 5 个自定义 serializer
 * - callout → `> [!NOTE]` / `[!TIP]` / `[!WARNING]` / `[!CAUTION]`(GitHub 风格,
 *   标准格式 `[!TYPE]` 无空格;variant 映射:info→NOTE, success→TIP,
 *   warning→WARNING, danger→CAUTION)
 * - toggle → 原生 HTML `<details><summary>...{children}</details>` 透传
 * - pageRef → `[Title](#/p/{pageId})`
 * - dateInline → ISO 日期 YYYY-MM-DD
 * - mention → `@{label}`
 * headingAnchor / codeBlock 不写 — 节点名继承 heading / codeBlock,命中
 * tiptap-markdown 内置默认 serializer。
 */
import { Editor } from '@tiptap/core'
import { Markdown, type MarkdownNodeSpec } from 'tiptap-markdown'
import baseExtensions from '@/editor/extensions'
import { Callout } from '@/editor/calloutExtension'
import { Toggle } from '@/editor/toggleExtension'
import { PageRef } from '@/editor/pageRefExtension'
import { DateInline } from '@/editor/dateInlineExtension'
import { Mention } from '@/editor/mentionExtension'

type SerializeFn = MarkdownNodeSpec['serialize']

const CALLOUT_TOKENS = {
  // 映射到 GitHub 标准 admonition:NOTE / TIP / WARNING / CAUTION。
  // 我们的 4 种变体 → GitHub 的 4 个最接近的:
  //   info(蓝中性)   → NOTE
  //   success(绿色)   → TIP(成功提示)
  //   warning(黄色)   → WARNING
  //   danger(红色)   → CAUTION
  // 标准格式是 `> [!NOTE]`(无空格),GitHub / GitLab / Obsidian / VSCode / Notion
  // 都能识别为 admonition。我们自己的 INFO / DANGER GitHub 不认。
  info: 'NOTE',
  success: 'TIP',
  warning: 'WARNING',
  danger: 'CAUTION',
} as const

const calloutSerialize: SerializeFn = (state, node) => {
  const variant = (node.attrs.variant as keyof typeof CALLOUT_TOKENS) || 'info'
  const token = CALLOUT_TOKENS[variant] ?? 'NOTE'
  // GitHub 格式: `> [!NOTE]` — 中括号 + 感叹号要紧贴,无空格
  state.write('> [!' + token + ']\n')
  state.wrapBlock('> ', null, node, () => {
    state.renderContent(node)
  })
  state.closeBlock(node)
}

const toggleSerialize: SerializeFn = (state, node) => {
  const open = node.attrs.open ? ' open' : ''
  const title = String(node.attrs.title ?? '').replace(/[<>]/g, '')
  state.write('<details' + open + '>\n<summary>' + title + '</summary>\n\n')
  state.renderContent(node)
  state.write('\n\n</details>\n')
  state.closeBlock(node)
}

const pageRefSerialize: SerializeFn = (state, node) => {
  const title = String(node.attrs.title ?? 'Untitled').replace(/[\[\]]/g, '')
  const pageId = String(node.attrs.pageId ?? '')
  state.write('[' + title + '](#/p/' + pageId + ')')
}

const dateInlineSerialize: SerializeFn = (state, node) => {
  const iso = String(node.attrs.iso ?? new Date().toISOString())
  state.write(iso.slice(0, 10))
}

const mentionSerialize: SerializeFn = (state, node) => {
  const label = String(node.attrs.label ?? node.attrs.userId ?? '')
  state.write('@' + label)
}

// 包装 5 个 custom 扩展,addStorage() 注入 markdown.serialize。
// Tiptap 的 extend() 返回新 class,共享 schema name,tiptap-markdown 通过
// extension.name 匹配。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CalloutWithMd = Callout.extend({ addStorage: () => ({ markdown: { serialize: calloutSerialize as any } }) })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ToggleWithMd = Toggle.extend({ addStorage: () => ({ markdown: { serialize: toggleSerialize as any } }) })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PageRefWithMd = PageRef.extend({ addStorage: () => ({ markdown: { serialize: pageRefSerialize as any } }) })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DateInlineWithMd = DateInline.extend({ addStorage: () => ({ markdown: { serialize: dateInlineSerialize as any } }) })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MentionWithMd = Mention.extend({ addStorage: () => ({ markdown: { serialize: mentionSerialize as any } }) })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exportExtensions: any[] = baseExtensions.map((ext: any) => {
  switch (ext.name) {
    case 'callout':
      return CalloutWithMd
    case 'toggle':
      return ToggleWithMd
    case 'pageRef':
      return PageRefWithMd
    case 'dateInline':
      return DateInlineWithMd
    case 'mention':
      return MentionWithMd
    default:
      return ext
  }
})

let _editor: Editor | null = null

function getExportEditor(): Editor {
  if (_editor && !_editor.isDestroyed) return _editor
  _editor = new Editor({
    element: document.createElement('div'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensions: [...exportExtensions, Markdown as any],
    editable: false,
  })
  return _editor
}

export function jsonToMarkdown(contentJSON: unknown): string {
  const ed = getExportEditor()
  const json = (contentJSON ?? { type: 'doc', content: [] }) as Record<string, unknown>
  try {
    const newDoc = ed.schema.nodeFromJSON(json)
    const tr = ed.state.tr.replaceWith(0, ed.state.doc.content.size, newDoc.content)
    ed.view.dispatch(tr)
  } catch (err) {
    console.error('[markdownSerializer] failed to parse contentJSON', err)
    return ''
  }
  return ed.storage.markdown.getMarkdown()
}

export function destroyExportEditor() {
  _editor?.destroy()
  _editor = null
}
