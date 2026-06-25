/**
 * DateInline 节点扩展
 *
 * Confluence 风格「插入日期」:在文本流里嵌入一个日期标记。
 *
 * 渲染:
 *   <time class="date-inline" data-date-mode="now|fixed" data-date="ISO" datetime="ISO">
 *     {已格式化的日期字符串}
 *   </time>
 *
 * 设计决策:
 * - inline + atom — 节点在文本流中作为一个整体,光标不会进入节点内部;
 *   按一次 Backspace 整块删除(和 emoji 行为一致)。
 * - 用 Vue NodeView 是因为 now 模式需要在客户端每 60s 重算一次显示文案
 *   (每次进入页面重新计算成"今天 14:30"等)。HTML 静态属性做不到。
 * - renderHTML 仍然输出 <time>,作为:
 *   ① 读视图(read view)没有 Vue 跑时的兜底
 *   ② 内容导出时的真实 DOM
 *   NodeView 挂载后会用 Vue 重写 innerText,但 DOM 结构(标签/attrs)不变。
 * - 模式:
 *   - mode='now':动态,每次进入页面/光标进入时重算显示
 *   - mode='fixed':静态,钉死一个具体日期
 * - 只保留日期,不显示时间(本期不做时间)
 *
 * 命令:
 *   - insertDate({ mode?, date? }):
 *     mode 缺省 'now',date 缺省 new Date()
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import DateInlineView from '@/components/editor/DateInlineView.vue'

export type DateMode = 'now' | 'fixed'

export interface DateAttrs {
  mode: DateMode
  iso: string
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    dateInline: {
      insertDate: (opts?: { mode?: DateMode; date?: Date }) => ReturnType
    }
  }
}

function formatForReadView(attrs: DateAttrs): string {
  if (!attrs.iso) return attrs.mode === 'now' ? '今天' : ''
  const d = new Date(attrs.iso)
  if (Number.isNaN(d.getTime())) return attrs.iso
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export const DateInline = Node.create({
  name: 'dateInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      mode: {
        default: 'now' as DateMode,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-date-mode')
          return v === 'fixed' || v === 'now' ? v : 'now'
        },
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-date-mode': attrs.mode,
        }),
      },
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
      formatForReadView(attrs),
    ]
  },

  addCommands() {
    return {
      insertDate:
        (opts: { mode?: DateMode; date?: Date } = {}) =>
        ({ commands }) => {
          const mode: DateMode = opts.mode ?? 'now'
          const date = opts.date ?? new Date()
          return commands.insertContent({
            type: this.name,
            attrs: { mode, iso: date.toISOString() },
          })
        },
    }
  },
})
