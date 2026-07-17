/**
 * DateInline 节点扩展 —— 钉死日期(原 fixed-only 模式)
 *
 * Confluence 风格「插入日期」:在文本流里嵌入一个日期标记。
 *
 * 渲染:
 *   <time class="date-inline" datetime="ISO" data-date="ISO">
 *     {YYYY/MM/DD 格式化的日期字符串}
 *   </time>
 *
 * 设计决策:
 * - inline + atom — 节点在文本流中作为一个整体,光标不会进入节点内部;
 *   按一次 Backspace 整块删除(和 emoji 行为一致)。
 * - 用 Vue NodeView 是因为节点可点击弹出 DateTimePicker 改日期;
 *   同时 Vue render 输出方便跟父视图其它 inline 节点共享视觉。
 * - renderHTML 仍然输出 <time>,作为:
 *   ① 读视图(read view)没有 Vue 跑时的兜底
 *   ② 内容导出时的真实 DOM
 *   NodeView 挂载后会用 Vue 重写 innerText,但 DOM 结构(标签/attrs)不变。
 * - 历史背景:本扩展曾经有 `mode='now'`(动态显示"今天"),因语义错位
 *   (渲染的是阅读当下而非写入时刻)已删除。schema 里不再声明 mode attr,
 *   旧节点里的 mode 字段被 Tiptap 自动丢弃,渲染时只剩 iso → 等同固定。
 *
 * 命令:
 *   - insertDate({ date? }):
 *     date 缺省 new Date()
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { formatYmd } from '@/lib/dateFormat'
import DateInlineView from '@/components/editor/DateInlineView.vue'

export interface DateAttrs {
  iso: string
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    dateInline: {
      insertDate: (opts?: { date?: Date }) => ReturnType
    }
  }
}

export const DateInline = Node.create({
  name: 'dateInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      iso: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('datetime') || el.getAttribute('data-date') || '',
        renderHTML: (attrs: Record<string, unknown>) => {
          const iso = (attrs.iso as string) || ''
          // 冗余写到 datetime + data-date — DOMPurify 在 ALLOW_DATA_ATTR:false
          // 下只放行白名单内的 data-*,data-date 已在 sanitize ALLOWED_ATTR 里登记
          return { datetime: iso, 'data-date': iso }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'time.date-inline' }]
  },

  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(DateInlineView as any)
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as unknown as DateAttrs
    return [
      'time',
      mergeAttributes(HTMLAttributes, { class: 'date-inline' }),
      attrs.iso ? formatYmd(attrs.iso) : '',
    ]
  },

  addCommands() {
    return {
      insertDate:
        (opts: { date?: Date } = {}) =>
        ({ commands }) => {
          const date = opts.date ?? new Date()
          return commands.insertContent({
            type: this.name,
            attrs: { iso: date.toISOString() },
          })
        },
    }
  },
})