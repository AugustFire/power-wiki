/**
 * Callout 节点扩展
 *
 * 4 种状态:info / success / warning / danger
 * - 渲染结构: <div class="callout {variant}"><span class="icon">{iconChar}</span><div>{children}</div></div>
 * - 跟种子页 HTML 结构一致(.callout flex 布局:icon + content body)
 * - 种子页里的 <div class="callout-title">x</div> 解析时会被忽略(div 不在 schema),
 *   编辑保存后变成普通 paragraph;read 视图里少一个 "标题" 视觉,但内容不丢
 *
 * 命令:
 *   - setCallout(variant): 用 variant 包裹当前块(对 paragraph 来说变成 wrapIn)
 *   - toggleCallout(variant): 已是 callout 则切回 paragraph,否则 wrapIn
 *   - setCalloutVariant(variant): 改当前 callout 的 variant
 *   - unsetCallout: 把 callout 内容提到上层(拆掉 callout 容器,保留内部 children)
 */
import { Node, mergeAttributes } from '@tiptap/core'

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
    return [{ tag: 'div.callout' }]
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
                // 收集 callout 内的所有顶层子块(通常是 paragraph)
                const children: import('@tiptap/pm/model').Node[] = []
                n.content.forEach((child) => {
                  children.push(child)
                })
                // 删掉 callout 节点
                tr = tr.delete(pos, pos + nodeSize)
                // 在同一位置逐个插入子块(它们自动落到 callout 所在层)
                let insertPos = pos
                for (const child of children) {
                  tr = tr.insert(insertPos, child)
                  insertPos += child.nodeSize
                }
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
