import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import DragHandle from '@tiptap/extension-drag-handle'
import Link from '@tiptap/extension-link'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import TextStyle from '@tiptap/extension-text-style'
import { common, createLowlight } from 'lowlight'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CodeBlockView from '@/components/editor/CodeBlockView.vue'
import { HeadingAnchor } from './headingAnchor'
import { Callout } from './calloutExtension'

/**
 * 禁用 Tiptap / StarterKit 内置的所有键盘快捷键
 *
 * 用户硬约束:不绑定任何键盘事件,工具栏 tooltip 可显示 Ctrl+B 等文字
 * 但 click 之外不响应。这里用一个高优先级 ProseMirror 插件,在所有
 * StarterKit / 其它扩展注册的 keymap 之前 handleKeyDown 返回 true 吞掉事件。
 *
 * 保留:Enter / Backspace / Delete / Tab / 方向键 / Escape / 字符输入 / 退格 等
 * 都不在 blocked 集合中,走 ProseMirror 默认行为。
 *
 * 注意:必须用 Plugin + props.handleKeyDown(而非 keymap()),因为 keymap
 * 在 ProseMirror 中是按数组顺序逐个尝试,后注册的 keymap 反而优先。直接
 * 用一个高 priority 的 Plugin handleKeyDown 才能保证在所有 keymap 之前拦截。
 */
const NoKeyboardShortcuts = Extension.create({
  name: 'noKeyboardShortcuts',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('noKeyboardShortcuts'),
        priority: 1000, // 远高于 StarterKit keymap(默认 100)
        props: {
          handleKeyDown(_view, event) {
            // 只拦截修饰键组合,普通字符键都放行
            const mod = event.metaKey || event.ctrlKey
            if (!mod) return false
            // 阻止浏览器默认(如 Ctrl+S 保存页面)
            if (!event.altKey && !event.shiftKey) {
              const k = event.key.toLowerCase()
              if (k === 'b' || k === 'i' || k === 'u' || k === 'e' ||
                  k === 'z' || k === 'y' || k === 's' || k === 'a') {
                event.preventDefault()
                return true
              }
            }
            if (event.shiftKey && !event.altKey) {
              const k = event.key.toLowerCase()
              if (k === 's' || k === 'b' || k === 'z' || k === 'y' ||
                  k === '7' || k === '8' || k === '5' || k === '9' ||
                  k === '-' || k === 'enter') {
                event.preventDefault()
                return true
              }
            }
            if (event.altKey && !event.shiftKey) {
              const k = event.key.toLowerCase()
              if (k === '1' || k === '2' || k === '3' || k === 'c') {
                event.preventDefault()
                return true
              }
            }
            return false
          },
        },
      }),
    ]
  },
})

/**
 * Tiptap 扩展集合
 *
 * 硬约束:
 * - 不接 Link / Image 扩展(无 URL 输入)
 * - NoKeyboardShortcuts 显式禁掉所有内置快捷键
 * - enableInputRules: false 禁用 Markdown 输入法(如 ** → bold)
 */
const extensions = [
  NoKeyboardShortcuts,
  HeadingAnchor,
  StarterKit.configure({
    heading: false, // 用下面 HeadingAnchor 替换 StarterKit 内置 heading
    codeBlock: false, // 关闭内置 codeBlock,用低光高亮的版本替换
    // 关闭 Markdown 输入规则(## → h2、** → bold、> → blockquote 等),
    // 工具栏按钮是唯一的格式入口 — 和工具栏 UI 的预期对齐。
    enableInputRules: false,
    enablePasteRules: false,
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  CodeBlockLowlight.extend({
    addNodeView() {
      return VueNodeViewRenderer(CodeBlockView)
    },
  }).configure({
    lowlight: createLowlight(common),
    defaultLanguage: 'plaintext',
  }),
  DragHandle.configure({
    render: () => {
      const el = document.createElement('div')
      el.className = 'drag-handle'
      el.draggable = true
      el.setAttribute('aria-label', '拖动以重排')
      el.setAttribute('title', '拖动以重排')
      el.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px">drag_indicator</span>'
      return el
    },
    tippyOptions: {
      placement: 'left',
      offset: [0, 8],
      duration: 150,
      animation: 'fade',
    },
  }),
  Placeholder.configure({
    placeholder: '输入 / 唤起菜单,或直接开始书写…',
  }),
  Link.configure({
    openOnClick: false,        // 编辑器内点击链接不导航(避免光标跳走)
    autolink: true,            // 粘贴/输入的 URL 自动识别为链接
    linkOnPaste: true,         // 在选中文本上粘贴 URL 也变链接
    protocols: ['http', 'https', 'mailto', 'tel'],
    HTMLAttributes: {
      rel: 'noopener noreferrer',
      target: '_blank',
    },
  }),
  // 文字颜色:用 span style="color: ..." 渲染
  Color.configure({
    types: ['textStyle'],
  }),
  // 背景色:用 mark data-color="..." 渲染,语义上是荧光笔/高亮
  Highlight.configure({
    multicolor: true,
  }),
  // textStyle 提供 inline 样式支持(Color 扩展默认挂在 textStyle 上)
  TextStyle,
  // 提示框:4 种 variant(信息/成功/警告/危险),支持 wrapIn / toggle / 改 variant
  Callout,
]

export default extensions
