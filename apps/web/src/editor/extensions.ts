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
import TextAlign from '@tiptap/extension-text-align'
import { common, createLowlight } from 'lowlight'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CodeBlockView from '@/components/editor/CodeBlockView.vue'
import { HeadingAnchor } from './headingAnchor'
import { Callout } from './calloutExtension'
import { Toggle } from './toggleExtension'
import { PageRef } from './pageRefExtension'
import { DateInline } from './dateInlineExtension'
import { Mention } from './mentionExtension'
import { ImageAttachment } from './imageAttachmentExtension'

/**
 * 仅拦截 Cmd/Ctrl+S(浏览器"保存网页"对话框)。
 *
 * 早期的 NoKeyboardShortcuts plugin 会吞掉所有 Mod-* 组合键,把 Tiptap
 * StarterKit / TaskList / CodeBlock 等扩展自带的格式化快捷键也一并禁掉。
 * 经评估,这些快捷键是编辑器效率的核心,不应该禁用。现在只保留对
 * Cmd/Ctrl+S 的拦截 — 否则用户在编辑中按 Cmd+S 会被浏览器抢去触发
 * "保存网页"对话框,体验割裂。
 *
 * 其余快捷键(Cmd+B/I/U/E/Z/Y、Alt+1/2/3、Cmd+Shift+7/8/9 等)全部
 * 走 Tiptap 默认 keymap。
 *
 * 实现原理:用 priority: 1000 的 ProseMirror Plugin,在所有 StarterKit keymap
 * 之前 handleKeyDown 返回 true 吞掉事件。
 */
const BlockBrowserSave = Extension.create({
  name: 'blockBrowserSave',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockBrowserSave'),
        priority: 1000,
        props: {
          handleKeyDown(_view, event) {
            const mod = event.metaKey || event.ctrlKey
            if (!mod) return false
            if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
              event.preventDefault()
              return true
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
 * 当前约束:
 * - BlockBrowserSave 拦截 Cmd/Ctrl+S 防浏览器保存对话框
 * - Markdown 输入规则开启(`## ` → h2、`**bold**` → bold、`- ` → ul 等)
 * - IME 中文拼音期间,Tiptap 通过 `view.composing` 字段自动跳过 inputRules
 *   (见 @tiptap/core/src/InputRule.ts:97-104),无需自己写 composition 插件
 */
const extensions = [
  BlockBrowserSave,
  HeadingAnchor,
  StarterKit.configure({
    heading: false, // 用下面 HeadingAnchor 替换 StarterKit 内置 heading
    codeBlock: false, // 关闭内置 codeBlock,用低光高亮的版本替换
    // StarterKit 2.27 的 Markdown 输入规则默认开启(`## `→h2、`**bold**`→bold 等)。
    // Tiptap 通过 view.composing 字段跳过 IME composition 期间,
    // 中文打字不会被 inputRules 误判(见 @tiptap/core/src/InputRule.ts:97-104)。
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell.extend({
    // 给 td 加 backgroundColor / textAlign / verticalAlign 三个属性,
    // 让 setCellAttribute 命令能改背景、对齐。Tiptap 通过 style 序列化。
    // 同时把 colwidth 写出到 HTML,让编辑时的列宽在发布/读取后保留
    // (Tiptap 自带的 colwidth 只有 parseHTML、没有 renderHTML,导致重设的列宽
    //  保存到 contentHTML 后丢失,read 视图总是回到默认 min-width)
    addAttributes() {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(this.parent?.() as any),
        colwidth: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            const attr = el.getAttribute('colwidth') || el.getAttribute('data-colwidth')
            return attr ? attr.split(',').map((w) => parseInt(w, 10)) : null
          },
          renderHTML: (attrs: Record<string, unknown>) => {
            const w = attrs.colwidth as number[] | null | undefined
            if (!w || w.length === 0) return {}
            return { colwidth: w.join(','), 'data-colwidth': w.join(',') }
          },
        },
        backgroundColor: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            if (!attrs.backgroundColor) return {}
            return { style: `background-color: ${attrs.backgroundColor}` }
          },
        },
        textAlign: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textAlign || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            if (!attrs.textAlign) return {}
            return { style: `text-align: ${attrs.textAlign}` }
          },
        },
        verticalAlign: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.verticalAlign || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            if (!attrs.verticalAlign) return {}
            return { style: `vertical-align: ${attrs.verticalAlign}` }
          },
        },
      }
    },
  }),
  TableHeader.extend({
    // 表头同样支持上述属性 + colwidth
    addAttributes() {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(this.parent?.() as any),
        colwidth: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            const attr = el.getAttribute('colwidth') || el.getAttribute('data-colwidth')
            return attr ? attr.split(',').map((w) => parseInt(w, 10)) : null
          },
          renderHTML: (attrs: Record<string, unknown>) => {
            const w = attrs.colwidth as number[] | null | undefined
            if (!w || w.length === 0) return {}
            return { colwidth: w.join(','), 'data-colwidth': w.join(',') }
          },
        },
        backgroundColor: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            if (!attrs.backgroundColor) return {}
            return { style: `background-color: ${attrs.backgroundColor}` }
          },
        },
        textAlign: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.textAlign || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            if (!attrs.textAlign) return {}
            return { style: `text-align: ${attrs.textAlign}` }
          },
        },
      }
    },
  }),
  CodeBlockLowlight.extend({
    addNodeView() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return VueNodeViewRenderer(CodeBlockView as any)
    },
  }).configure({
    lowlight: createLowlight(common),
    // lowlight 不识别 'plaintext'(highlight.js 的约定),默认 null 让无语言时代码块不挂 language class
    defaultLanguage: null,
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
  // 文字对齐:作用于段落 + 标题。表格单元格用 setCellAttribute('textAlign', ...),
  // 不需要这个扩展。
  TextAlign.configure({
    types: ['heading', 'paragraph'],
    alignments: ['left', 'center', 'right'],
  }),
  // 提示框:4 种 variant(信息/成功/警告/危险),支持 wrapIn / toggle / 改 variant
  Callout,
  // 折叠块:details/summary 容器,点击 summary 切换 open/close
  Toggle,
  // 页面引用:块级卡片,Notion 风格,点击跳转到对应页面
  PageRef,
  // 行内日期/时间:in-text 节点,now 模式每分钟重算,fixed 模式显示固定日期
  DateInline,
  // @mention:inline atom,@ 触 Suggestion,在当前 page 的 space 访问组里挑人
  Mention,
  // 页面级附件:image/* 渲染成图片,application/pdf 渲染成文件卡片。
  // 上传走 presigned PUT(见 editor/uploadAndInsert.ts),src 恒为
  // /api/attachments/{id}/raw(sanitize.ts img src 白名单只放行这个模式)。
  ImageAttachment,
]

export default extensions
