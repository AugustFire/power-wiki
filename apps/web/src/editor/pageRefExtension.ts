/**
 * Page Reference 节点(Notion 风格的页面引用块)
 *
 * 块级、不可进入编辑的原子节点。插入时快照目标页面的标题到 title attr,
 * 这样 read view 不需要查 store 也能正确显示。
 *
 * 渲染结构:
 *   <a class="page-ref-card" data-page-id="xxx" href="#/p/xxx">
 *     <span class="material-symbols-outlined page-ref-icon">description</span>
 *     <span class="page-ref-title">页面标题</span>
 *   </a>
 *
 * 设计决策:
 * - atom: true   — cursor 不能进入,删除即整块移除
 * - selectable / draggable — 可选中、可用 DragHandle 拖拽
 * - 不需要 NodeView:renderHTML 输出就是最终视觉,editor 与 read view 一致
 * - href 走 `#/p/xxx`,复用现有 hash 路由 — read view 上点击直接跳转
 */
import { Node, mergeAttributes } from '@tiptap/core'

export const PageRef = Node.create({
  name: 'pageRef',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-page-id'),
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.pageId) return {}
          return { 'data-page-id': attrs.pageId as string }
        },
      },
      title: {
        default: '',
        parseHTML: (el: HTMLElement) => {
          const t = el.querySelector('.page-ref-title')
          return t?.textContent ?? ''
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          // 标题走 content(下面 renderHTML 的 span.page-ref-title),不在 attr 序列化
          return {}
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'a.page-ref-card' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const pageId = (node.attrs.pageId as string) || ''
    const title = (node.attrs.title as string) || '未命名页面'
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        class: 'page-ref-card',
        href: `#/p/${pageId}`,
      }),
      ['span', { class: 'material-symbols-outlined page-ref-icon' }, 'description'],
      ['span', { class: 'page-ref-title' }, title],
    ]
  },

  addCommands() {
    return {
      setPageRef:
        (pageId: string, title: string) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { pageId, title },
          }),
    }
  },
})

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    pageRef: {
      setPageRef: (pageId: string, title: string) => ReturnType
    }
  }
}