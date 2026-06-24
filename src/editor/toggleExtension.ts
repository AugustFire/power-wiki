/**
 * Toggle 节点扩展(Notion / 飞书风格的折叠块)
 *
 * 渲染结构:
 *   <details class="toggle" [open]>
 *     <summary>▶</summary>
 *     <div class="toggle-content">{children}</div>
 *   </details>
 *
 * 设计决策:
 * - content: 'block+'      — 内部允许任何块(段落、列表、引用、代码块、甚至嵌套 toggle)
 * - isolating: true        — 选区不会从 toggle 内溢出到外层
 * - defining: true         — 块边界稳定,ProseMirror 不会因孤行调整而拆开
 * - open attr 通过 <details open> 的 boolean 属性序列化
 *
 * 命令:
 *   - setToggle():   把当前块包成 toggle(默认 open=true)
 *   - toggleOpenToggle(): 切换 open/close 状态
 *
 * NodeView 拦截 summary 点击 → toggleOpenToggle,绕开 contenteditable
 * 对 <details> 的不稳定行为。
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import ToggleView from '@/components/editor/ToggleView.vue'

export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el: HTMLElement) => el.hasAttribute('open'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.open ? { open: '' } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'details.toggle' }]
  },

  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(ToggleView as any)
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes, { class: 'toggle' }),
      // summary 用 contenteditable="false" 避免 Tiptap 把箭头当作文本编辑;
      // 真实交互由 ToggleView.vue 通过 NodeView 拦截 summary click 处理。
      ['summary', { contenteditable: 'false' }],
      ['div', { class: 'toggle-content' }, 0],
    ]
  },

  addCommands() {
    return {
      setToggle:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name, { open: true }),
      toggleOpenToggle:
        () =>
        ({ tr, state, dispatch }) => {
          const { $from } = state.selection
          for (let d = $from.depth; d > 0; d--) {
            const n = $from.node(d)
            if (n.type.name === this.name) {
              const pos = $from.before(d)
              if (dispatch) {
                tr.setNodeMarkup(pos, undefined, {
                  ...n.attrs,
                  open: !n.attrs.open,
                })
              }
              return true
            }
          }
          return false
        },
    }
  },
})

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    toggle: {
      setToggle: () => ReturnType
      toggleOpenToggle: () => ReturnType
    }
  }
}