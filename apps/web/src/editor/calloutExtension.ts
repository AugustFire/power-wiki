/**
 * Callout 节点扩展
 *
 * 4 种状态:info / success / warning / danger
 * - 编辑器内:用 CalloutView (NodeView) 渲染,icon 由 Vue 控制,body 用 NodeViewContent
 * - 读视图 / 保存 HTML:renderHTML 输出 <div.callout><span.icon>name</span><div.callout-body>...
 *   其中 icon span 文本是 material-symbols 字体 ligature
 * - parseHTML 用 contentElement 只取 callout-body 的 children 作为 content,
 *   避免 icon span 里的 "warning" 文本被包成段落塞进 callout body
 *
 * 命令:
 *   - setCallout(variant): 用 variant 包裹当前块
 *   - toggleCallout(variant): 已是 callout 则切回 paragraph,否则 wrapIn
 *   - setCalloutVariant(variant): 改当前 callout 的 variant
 *   - unsetCallout: 把 callout 内容提到上层(拆掉 callout 容器,保留内部 children)
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CalloutView from '@/components/editor/CalloutView.vue'

export type CalloutVariant = 'info' | 'success' | 'warning' | 'danger'

const ICON_MAP: Record<CalloutVariant, string> = {
  info: 'lightbulb',
  success: 'check_circle',
  warning: 'warning',
  danger: 'error',
}

const VARIANTS: CalloutVariant[] = ['info', 'success', 'warning', 'danger']

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (variant?: CalloutVariant) => ReturnType
      toggleCallout: (variant?: CalloutVariant) => ReturnType
      setCalloutVariant: (variant: CalloutVariant) => ReturnType
      unsetCallout: () => ReturnType
    }
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      variant: {
        default: 'info' as CalloutVariant,
        parseHTML: (el: HTMLElement) => {
          const cls = el.getAttribute('class') || ''
          const fromData = el.getAttribute('data-variant') as CalloutVariant | null
          if (fromData && VARIANTS.includes(fromData)) return fromData
          const found = VARIANTS.find((v) => cls.split(/\s+/).includes(v))
          return found || 'info'
        },
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-variant': attrs.variant,
        }),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div.callout',
        // 只把 callout-body 的 children 解析为 content,
        // 跳过外层的 <span class="icon">warning</span>(material-symbols ligature 文本)
        // ProseMirror ParseRule 的字段名是 contentElement(支持 string / HTMLElement / function)
        contentElement: (el: HTMLElement) => {
          const withClass = el.querySelector<HTMLElement>(':scope > div.callout-body')
          if (withClass) return withClass
          // seed 页面用的 <div>(无 class),找含 block 内容的那个子 div
          const divs = el.querySelectorAll<HTMLElement>(':scope > div')
          for (const d of divs) {
            if (
              d.querySelector(
                'p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, .callout, .toggle, table',
              )
            ) {
              return d
            }
          }
          return el
        },
      },
    ]
  },

  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(CalloutView as any)
  },

  renderHTML({ HTMLAttributes, node }) {
    const variant = (node.attrs.variant as CalloutVariant) || 'info'
    const iconChar = ICON_MAP[variant] || 'info'
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: `callout ${variant}`,
      }),
      ['span', { class: 'material-symbols-outlined icon' }, iconChar],
      ['div', { class: 'callout-body' }, 0],
    ]
  },

  addCommands() {
    return {
      setCallout:
        (variant: CalloutVariant = 'info') =>
        ({ commands }) => {
          return commands.wrapIn(this.name, { variant })
        },
      toggleCallout:
        (variant: CalloutVariant = 'info') =>
        ({ commands }) => {
          return commands.toggleWrap(this.name, { variant })
        },
      setCalloutVariant:
        (variant: CalloutVariant) =>
        ({ tr, state, dispatch }) => {
          const { $from } = state.selection
          for (let d = $from.depth; d > 0; d--) {
            const n = $from.node(d)
            if (n.type.name === 'callout') {
              const pos = $from.before(d)
              if (dispatch) {
                tr.setNodeMarkup(pos, undefined, { ...n.attrs, variant })
              }
              return true
            }
          }
          return false
        },
      unsetCallout:
        () =>
        ({ tr, state, dispatch }) => {
          const { $from } = state.selection
          for (let d = $from.depth; d > 0; d--) {
            const n = $from.node(d)
            if (n.type.name === 'callout') {
              const pos = $from.before(d)
              const nodeSize = n.nodeSize
              if (dispatch) {
                // 单次 replaceWith 比 delete + 循环 insert 安全:
                // - 不会让 open tr 的中间 listener 看到临时状态
                // - 子节点 marks 完整保留(走同一 transaction 的 map 流程)
                const fragment = n.content
                tr = tr.replaceWith(pos, pos + nodeSize, fragment)
              }
              return true
            }
          }
          return false
        },
    }
  },
})

export const CALLOUT_VARIANTS = VARIANTS
export const CALLOUT_ICON_MAP = ICON_MAP
