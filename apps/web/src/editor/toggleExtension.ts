/**
 * Toggle 节点扩展(Notion / 飞书风格的折叠块)
 *
 * 渲染结构:
 *   <details class="toggle" [open]>
 *     <summary>{title}</summary>
 *     <div class="toggle-content">{children}</div>
 *   </details>
 *
 * 设计决策:
 * - title 是 attr(不进 schema content) — summary 文字不进 content,避免在
 *   内容区被重复渲染;ProseMirror 的 DOMParser 解析 <summary> 时因不在 schema
 *   自动跳过、里面的文本被 addAttributes 的 parseHTML 取走。
 * - content: 'block+'  — 内部允许任何块(段落、列表、引用、代码块、嵌套 toggle)
 * - isolating: true    — 选区不会从 toggle 内溢出到外层
 * - defining: true     — 块边界稳定,ProseMirror 不会因孤行调整而拆开
 * - open 通过 <details open> 的 boolean 属性序列化
 *
 * 编辑器内 ToggleView 用 <input> 编辑 title,onInput 写回 attr;
 * Enter 跳到 content 首块,Escape 失焦。
 *
 * 命令:
 *   - setToggle():          把当前块包成 toggle(默认 open=true, title='')
 *   - toggleOpenToggle():   切换 open/close 状态
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
      title: {
        default: '',
        parseHTML: (el: HTMLElement) =>
          el.querySelector('summary')?.textContent?.trim() ?? '',
        // title 由 renderHTML 手动写到 <summary>,这里不参与 attr 输出
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'details.toggle',
        // 只把 <div class="toggle-content"> 里的 children 解析为 content,
        // 跳过 <summary>{title}</summary> — summary 文本已在 addAttributes.title.parseHTML
        // 里取走,如果不限制 contentElement,summary 的文字会被 ProseMirror 当作
        // 顶级 inline 包成段落塞进 content,造成"标题在正文里重复"
        contentElement: (el: HTMLElement) => {
          const content = el.querySelector<HTMLElement>(':scope > div.toggle-content')
          return content ?? el
        },
      },
    ]
  },

  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(ToggleView as any)
  },

  renderHTML({ HTMLAttributes, node }) {
    const title = (node.attrs.title as string) || ''
    return [
      'details',
      mergeAttributes(HTMLAttributes, { class: 'toggle' }),
      ['summary', {}, title],
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
