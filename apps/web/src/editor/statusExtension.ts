/**
 * StatusBadge 节点扩展 —— Confluence 风格「状态徽章」(P1/5.2)。
 *
 * 在文本流里嵌一个小胶囊,用来标注段落 / 表格单元格 / 标题旁的进度:
 * 「进行中」「已完成」「已阻塞」「草稿」。
 *
 * 渲染:
 *   <span class="status-badge" data-status-color="blue">进行中</span>
 *
 * 设计决策:
 * - inline + atom —— 跟 dateInline / mention 一致:光标不进入节点内部,
 *   一次 Backspace 整块删除。文字改动走 NodeView 的弹窗,不走 PM 文本编辑,
 *   避免 inline atom 内嵌 contenteditable 引发的光标跳变(Tiptap 老坑)。
 * - 文案存在 `text` attr 而不是节点的 content —— atom 节点没有 content,
 *   而且 attr 形式让 renderHTML 在没有 Vue 的读视图里也能直接输出文字。
 * - `color` 只有 4 个枚举值,不开放自由色值:sanitize 白名单里
 *   `data-status-color` 是自由字符串,渲染端用 CSS 属性选择器精确匹配这 4 个,
 *   写进脏值时不会命中任何配色规则(退化成无背景的纯文本),不会污染样式。
 *
 * 命令:
 *   - insertStatus({ text, color }) —— slash 菜单的 4 个预设各调一次。
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import StatusBadgeView from '@/components/editor/StatusBadgeView.vue'

export type StatusColor = 'blue' | 'green' | 'red' | 'gray'

export interface StatusAttrs {
  text: string
  color: StatusColor
}

/** 4 个预设。slash 菜单 + NodeView 的配色切换器共用这一份,避免两处漂移。 */
export const STATUS_PRESETS: { color: StatusColor; text: string; label: string }[] = [
  { color: 'blue', text: '进行中', label: '状态 · 进行中' },
  { color: 'green', text: '已完成', label: '状态 · 已完成' },
  { color: 'red', text: '已阻塞', label: '状态 · 已阻塞' },
  { color: 'gray', text: '草稿', label: '状态 · 草稿' },
]

const VALID_COLORS = new Set<string>(STATUS_PRESETS.map((p) => p.color))

function normalizeColor(raw: unknown): StatusColor {
  return typeof raw === 'string' && VALID_COLORS.has(raw) ? (raw as StatusColor) : 'gray'
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    statusBadge: {
      insertStatus: (opts: { text: string; color: StatusColor }) => ReturnType
    }
  }
}

export const StatusBadge = Node.create({
  name: 'statusBadge',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        // 文字来自节点自身的 textContent —— 读视图 / 复制粘贴回来的 HTML
        // 里没有单独的 data-* 承载文案,直接取渲染出的文本即可。
        parseHTML: (el: HTMLElement) => el.textContent?.trim() || '',
        // 文案是 children 不是 attribute,renderHTML 里手动写进第三个数组项,
        // 这里返回 {} 避免多出一个 text="…" 属性。
        renderHTML: () => ({}),
      },
      color: {
        default: 'gray' as StatusColor,
        parseHTML: (el: HTMLElement) => normalizeColor(el.getAttribute('data-status-color')),
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-status-color': normalizeColor(attrs.color),
        }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span.status-badge' }]
  },

  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(StatusBadgeView as any)
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as unknown as StatusAttrs
    return ['span', mergeAttributes(HTMLAttributes, { class: 'status-badge' }), attrs.text || '']
  },

  addCommands() {
    return {
      insertStatus:
        (opts: { text: string; color: StatusColor }) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { text: opts.text, color: normalizeColor(opts.color) },
          }),
    }
  },
})
