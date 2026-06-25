<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import LinkPopover from './LinkPopover.vue'
import ColorPopover from './ColorPopover.vue'
import EmojiPicker from './EmojiPicker.vue'
import DateTimePicker from './DateTimePicker.vue'
import { CALLOUT_VARIANTS, CALLOUT_ICON_MAP } from '@/editor/calloutExtension'
import { BG_COLOR_PALETTE } from '@/lib/colorPalettes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  editor: AnyEditor
}>()

interface Btn {
  id: string
  icon: string
  title: string
  shortcut?: string
  isActive?: () => boolean
  run: () => void
  disabled?: () => boolean
}

const formatBtns = computed<Btn[]>(() => {
  if (!props.editor) return []
  const e = props.editor
  return [
    {
      id: 'bold', icon: 'format_bold', title: '加粗', shortcut: 'Ctrl+B',
      isActive: () => e.isActive('bold'),
      run: () => e.chain().focus().toggleBold().run(),
    },
    {
      id: 'italic', icon: 'format_italic', title: '斜体', shortcut: 'Ctrl+I',
      isActive: () => e.isActive('italic'),
      run: () => e.chain().focus().toggleItalic().run(),
    },
    {
      id: 'strike', icon: 'format_strikethrough', title: '删除线',
      isActive: () => e.isActive('strike'),
      run: () => e.chain().focus().toggleStrike().run(),
    },
    {
      id: 'inlineCode', icon: 'code', title: '行内代码',
      isActive: () => e.isActive('code'),
      run: () => e.chain().focus().toggleCode().run(),
    },
  ]
})

const listBtns = computed<Btn[]>(() => {
  if (!props.editor) return []
  const e = props.editor
  return [
    {
      id: 'ul', icon: 'format_list_bulleted', title: '无序列表',
      isActive: () => e.isActive('bulletList'),
      run: () => e.chain().focus().toggleBulletList().run(),
    },
    {
      id: 'ol', icon: 'format_list_numbered', title: '有序列表',
      isActive: () => e.isActive('orderedList'),
      run: () => e.chain().focus().toggleOrderedList().run(),
    },
    {
      id: 'task', icon: 'checklist', title: '任务列表',
      isActive: () => e.isActive('taskList'),
      run: () => e.chain().focus().toggleTaskList().run(),
    },
  ]
})

const insertBtns = computed<Btn[]>(() => {
  if (!props.editor) return []
  const e = props.editor
  return [
    {
      id: 'table', icon: 'table_chart', title: '插入表格',
      run: () => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      id: 'hr', icon: 'horizontal_rule', title: '分隔线',
      run: () => e.chain().focus().setHorizontalRule().run(),
    },
    {
      id: 'codeblock', icon: 'data_object', title: '代码块',
      isActive: () => e.isActive('codeBlock'),
      run: () => e.chain().focus().toggleCodeBlock().run(),
    },
    {
      id: 'callout', icon: 'lightbulb', title: '提示框',
      isActive: () => e.isActive('callout'),
      run: () => e.chain().focus().toggleCallout('info').run(),
    },
  ]
})

// ─── 文字对齐 ────────────────────────────────────────────────
const alignBtns = computed<Btn[]>(() => {
  if (!props.editor) return []
  const e = props.editor
  const isAligned = (a: 'left' | 'center' | 'right') =>
    e.isActive({ textAlign: a }) ||
    // 没设过对齐时,默认是 left;如果当前 active 的是 left,高亮左对齐
    (!e.isActive({ textAlign: 'center' }) &&
      !e.isActive({ textAlign: 'right' }) &&
      a === 'left')
  return [
    {
      id: 'alignLeft', icon: 'format_align_left', title: '左对齐',
      isActive: () => isAligned('left'),
      run: () => e.chain().focus().setTextAlign('left').run(),
    },
    {
      id: 'alignCenter', icon: 'format_align_center', title: '居中',
      isActive: () => isAligned('center'),
      run: () => e.chain().focus().setTextAlign('center').run(),
    },
    {
      id: 'alignRight', icon: 'format_align_right', title: '右对齐',
      isActive: () => isAligned('right'),
      run: () => e.chain().focus().setTextAlign('right').run(),
    },
  ]
})

// ─── 缩进 / 反缩进 ─────────────────────────────────────────
// 智能 indent:列表项用 sinkListItem;其他块包进 blockquote 形成引用嵌套。
// outdent:列表项用 liftListItem;引用块 lift;其他 no-op。
//
// 注意:此按钮的点击行为 ≠ Tiptap 默认 Tab keymap(段落里 Tab 默认插入空格,
// 列表里才是 sink)。所以 toolbar 上不挂 shortcut 标签,避免误导用户。
function runIndent() {
  const e = props.editor
  if (!e) return
  if (e.isActive('listItem') || e.isActive('taskItem')) {
    e.chain().focus().sinkListItem('listItem').run()
    return
  }
  // 段落/标题/引用等都 wrap 进 blockquote,符合"缩进 → 引用"的中文排版直觉
  e.chain().focus().wrapIn('blockquote').run()
}

function runOutdent() {
  const e = props.editor
  if (!e) return
  if (e.isActive('listItem') || e.isActive('taskItem')) {
    e.chain().focus().liftListItem('listItem').run()
    return
  }
  if (e.isActive('blockquote')) {
    e.chain().focus().lift().run()
  }
}

const indentBtns = computed<Btn[]>(() => {
  if (!props.editor) return []
  return [
    {
      id: 'outdent', icon: 'format_indent_decrease', title: '减少缩进',
      run: () => runOutdent(),
    },
    {
      id: 'indent', icon: 'format_indent_increase', title: '增加缩进',
      run: () => runIndent(),
    },
  ]
})

// ─── 提示框变体下拉(信息/成功/警告/危险) ──────────────────────
const currentCalloutVariant = computed(() => {
  const e = props.editor
  if (!e || !e.isActive('callout')) return null
  return e.getAttributes('callout').variant as 'info' | 'success' | 'warning' | 'danger' | null
})

const calloutMenuOpen = ref(false)
const calloutMenuWrap = ref<HTMLElement | null>(null)

function toggleCalloutMenu() {
  calloutMenuOpen.value = !calloutMenuOpen.value
}

function runCalloutAction(action: string) {
  const e = props.editor
  if (!e) return
  if (action === 'unset') {
    e.chain().focus().unsetCallout().run()
  } else {
    e.chain().focus().setCalloutVariant(action as 'info' | 'success' | 'warning' | 'danger').run()
  }
  calloutMenuOpen.value = false
}

// ─── 表格内控件(仅在光标处于表格内显示) ──────────────────
const isInTable = computed(() => {
  const e = props.editor
  if (!e) return false
  return e.isActive('table')
})

const tableMenuOpen = ref(false)
const tableMenuWrap = ref<HTMLElement | null>(null)

// 表格下拉的项类型 — 多了 kind 区分:action 直接执行,picker 打开子面板,separator 分组线
type TableMenuItem =
  | { kind: 'action'; id: string; label: string; icon: string; danger?: boolean; isActive?: () => boolean }
  | { kind: 'separator' }
  | { kind: 'picker'; id: 'cellColor'; label: string; icon: string }

// 当前光标单元格的 backgroundColor / textAlign(用于高亮 active)
function currentCellBg(): string | null {
  const e = props.editor
  if (!e) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((e.getAttributes('tableCell' as any).backgroundColor as string | null) ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e.getAttributes('tableHeader' as any).backgroundColor as string | null) ||
    null)
}

function currentTextAlign(): string | null {
  const e = props.editor
  if (!e) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((e.getAttributes('tableCell' as any).textAlign as string | null) ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e.getAttributes('tableHeader' as any).textAlign as string | null) ||
    null)
}

const tableMenuOptions: TableMenuItem[] = [
  // ── 行/列增删 ──
  { kind: 'action', id: 'addRowBefore', label: '上方插入行', icon: 'vertical_align_top' },
  { kind: 'action', id: 'addRowAfter', label: '下方插入行', icon: 'vertical_align_bottom' },
  { kind: 'action', id: 'addColBefore', label: '左侧插入列', icon: 'align_horizontal_left' },
  { kind: 'action', id: 'addColAfter', label: '右侧插入列', icon: 'align_horizontal_right' },
  { kind: 'separator' },
  // ── 合并/拆分 ──
  { kind: 'action', id: 'mergeCells', label: '合并单元格', icon: 'merge_type' },
  { kind: 'action', id: 'splitCell', label: '拆分单元格', icon: 'call_split' },
  { kind: 'separator' },
  // ── 表头切换 ──
  {
    kind: 'action',
    id: 'toggleHeaderRow',
    label: '切换表头行',
    icon: 'view_headline',
    isActive: () => !!props.editor?.isActive('tableHeader'),
  },
  { kind: 'separator' },
  // ── 单元格对齐 ──
  {
    kind: 'action',
    id: 'alignLeft',
    label: '左对齐',
    icon: 'format_align_left',
    isActive: () => currentTextAlign() === 'left',
  },
  {
    kind: 'action',
    id: 'alignCenter',
    label: '居中',
    icon: 'format_align_center',
    isActive: () => currentTextAlign() === 'center',
  },
  {
    kind: 'action',
    id: 'alignRight',
    label: '右对齐',
    icon: 'format_align_right',
    isActive: () => currentTextAlign() === 'right',
  },
  { kind: 'separator' },
  // ── 单元格背景色 ──
  { kind: 'picker', id: 'cellColor', label: '单元格背景', icon: 'format_color_fill' },
  { kind: 'separator' },
  // ── 删除 ──
  { kind: 'action', id: 'deleteRow', label: '删除当前行', icon: 'horizontal_rule', danger: true },
  { kind: 'action', id: 'deleteCol', label: '删除当前列', icon: 'vertical_distribute', danger: true },
  { kind: 'action', id: 'deleteTable', label: '删除整个表格', icon: 'delete_sweep', danger: true },
]

function toggleTableMenu() {
  tableMenuOpen.value = !tableMenuOpen.value
  cellColorOpen.value = false
}

function runTableAction(id: string) {
  const e = props.editor
  if (!e) return
  const cmds: Record<string, () => void> = {
    addRowBefore: () => e.chain().focus().addRowBefore().run(),
    addRowAfter: () => e.chain().focus().addRowAfter().run(),
    addColBefore: () => e.chain().focus().addColumnBefore().run(),
    addColAfter: () => e.chain().focus().addColumnAfter().run(),
    deleteRow: () => e.chain().focus().deleteRow().run(),
    deleteCol: () => e.chain().focus().deleteColumn().run(),
    deleteTable: () => e.chain().focus().deleteTable().run(),
    mergeCells: () => e.chain().focus().mergeCells().run(),
    splitCell: () => e.chain().focus().splitCell().run(),
    toggleHeaderRow: () => e.chain().focus().toggleHeaderRow().run(),
    alignLeft: () => e.chain().focus().setCellAttribute('textAlign', 'left').run(),
    alignCenter: () => e.chain().focus().setCellAttribute('textAlign', 'center').run(),
    alignRight: () => e.chain().focus().setCellAttribute('textAlign', 'right').run(),
  }
  cmds[id]?.()
  tableMenuOpen.value = false
}

// ─── 单元格背景色 popover ────────────────────────
const cellColorOpen = ref(false)

// 单元格背景色 — 跟文字高亮共用 BG_COLOR_PALETTE,保证视觉一致。
// (以前这里维护独立的 8 色 hex,跟 highlight 漂移;现在统一来源)
const CELL_COLORS = BG_COLOR_PALETTE

function applyCellColor(value: string | null) {
  const e = props.editor
  if (!e) return
  e.chain().focus().setCellAttribute('backgroundColor', value).run()
  cellColorOpen.value = false
}

function clearCellColor() {
  applyCellColor(null)
}

// ─── 日期(独立 popover) ──────────────────────────────────
const dateWrap = ref<HTMLElement | null>(null)
const datePickerOpen = ref(false)
const datePopoverOpen = ref(false)

function toggleDateDropdown() {
  datePickerOpen.value = !datePickerOpen.value
  datePopoverOpen.value = false
}

function isOnDateInline(): boolean {
  const e = props.editor
  if (!e) return false
  return e.isActive('dateInline')
}

function insertDateNow() {
  const e = props.editor
  if (!e) return
  e.chain().focus().insertDate({ mode: 'now' }).run()
  closeAllDate()
}

function insertDateTodayOnly() {
  const e = props.editor
  if (!e) return
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  e.chain().focus().insertDate({ mode: 'fixed', date: d }).run()
  closeAllDate()
}

function openDatePopover() {
  datePopoverOpen.value = true
  // 主菜单关掉,只剩 picker
  datePickerOpen.value = false
}

function onDateInsert(payload: { mode: 'now' | 'fixed'; date: Date }) {
  const e = props.editor
  if (!e) return
  e.chain()
    .focus()
    .insertDate({ mode: payload.mode, date: payload.date })
    .run()
  closeAllDate()
}

function onDateCancel() {
  datePopoverOpen.value = false
}

function closeAllDate() {
  datePickerOpen.value = false
  datePopoverOpen.value = false
}

const historyBtns = computed<Btn[]>(() => {
  if (!props.editor) return []
  const e = props.editor
  return [
    {
      id: 'undo', icon: 'undo', title: '撤销', shortcut: 'Ctrl+Z',
      disabled: () => !e.can().chain().focus().undo().run(),
      run: () => e.chain().focus().undo().run(),
    },
    {
      id: 'redo', icon: 'redo', title: '重做', shortcut: 'Ctrl+Y',
      disabled: () => !e.can().chain().focus().redo().run(),
      run: () => e.chain().focus().redo().run(),
    },
  ]
})

// ─── 链接 ──────────────────────────────────────────────────
function isOnLink(): boolean {
  const e = props.editor
  if (!e) return false
  return e.isActive('link')
}

function hasSelection(): boolean {
  const e = props.editor
  if (!e) return false
  const { from, to } = e.state.selection
  return from !== to
}

const linkBtn = computed<Btn>(() => {
  const e = props.editor
  const enabled = isOnLink() || hasSelection()
  return {
    id: 'link',
    icon: 'link',
    title: enabled ? '链接' : '链接 (请先选中文本)',
    isActive: () => !!e?.isActive('link'),
    disabled: () => !enabled,
    run: () => openLinkPopover(),
  }
})

const linkPopoverOpen = ref(false)
const linkWrap = ref<HTMLElement | null>(null)

function openLinkPopover() {
  linkPopoverOpen.value = true
}

function closeLinkPopover() {
  linkPopoverOpen.value = false
}

// ─── 颜色按钮(文字色 + 高亮) ──────────────────────────────────
function currentTextColor(): string | null {
  const e = props.editor
  if (!e) return null
  return (e.getAttributes('textStyle').color as string | undefined) ?? null
}

function currentHighlightColor(): string | null {
  const e = props.editor
  if (!e) return null
  return (e.getAttributes('highlight').color as string | undefined) ?? null
}

function textColorSwatch(): string {
  return currentTextColor() ?? 'transparent'
}

function highlightSwatch(): string {
  return currentHighlightColor() ?? 'transparent'
}

const colorPopoverMode = ref<'text' | 'highlight' | null>(null)
const colorWrap = ref<HTMLElement | null>(null)

function openColorPopover(mode: 'text' | 'highlight') {
  colorPopoverMode.value = mode
  linkPopoverOpen.value = false
}

function closeColorPopover() {
  colorPopoverMode.value = null
}

// ─── 表情选择器 ───────────────────────────────────────────
const emojiOpen = ref(false)
const emojiWrap = ref<HTMLElement | null>(null)

function toggleEmoji() {
  emojiOpen.value = !emojiOpen.value
}

function closeEmoji() {
  emojiOpen.value = false
}

// ─── 块类型下拉 ───────────────────────────────────────────────
interface BlockTypeOpt {
  id: 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'code'
  label: string
  icon: string
  isActive: () => boolean
}

const blockTypeOptions = computed<BlockTypeOpt[]>(() => {
  const e = props.editor
  if (!e) return []
  return [
    { id: 'p', label: '正文', icon: 'notes', isActive: () => e.isActive('paragraph') },
    { id: 'h1', label: '一级标题', icon: 'format_h1', isActive: () => e.isActive('heading', { level: 1 }) },
    { id: 'h2', label: '二级标题', icon: 'format_h2', isActive: () => e.isActive('heading', { level: 2 }) },
    { id: 'h3', label: '三级标题', icon: 'format_h3', isActive: () => e.isActive('heading', { level: 3 }) },
    { id: 'quote', label: '引用', icon: 'format_quote', isActive: () => e.isActive('blockquote') },
    { id: 'code', label: '代码块', icon: 'code', isActive: () => e.isActive('codeBlock') },
  ]
})

const blockTypeLabel = computed(() => {
  const opt = blockTypeOptions.value.find((o) => o.isActive())
  return opt?.label ?? '正文'
})

function setBlockType(type: BlockTypeOpt['id']) {
  const e = props.editor
  if (!e) return

  const { state } = e
  const { from, to } = state.selection

  // 收集选区里所有顶层文本块(跳过 listItem / taskItem 这种嵌套节点)
  const blocks: { pos: number; node: NonNullable<ReturnType<typeof state.doc.nodeAt>> }[] = []
  state.doc.nodesBetween(from, to, (node: { isTextblock: boolean; type: { name: string }; nodeSize: number; attrs: Record<string, unknown> }, pos: number) => {
    if (!node.isTextblock) return
    if (node.type.name === 'listItem' || node.type.name === 'taskItem') return
    blocks.push({ pos, node: node as NonNullable<ReturnType<typeof state.doc.nodeAt>> })
  })
  if (blocks.length === 0) return

  // toggle off:选区里所有块都是目标类型时,切回正文
  const allMatch = blocks.every(({ node }) => matchesBlockType(node, type))
  if (allMatch && type !== 'p') {
    liftAndConvertBlocks(blocks, 'paragraph')
    return
  }

  if (type === 'p') {
    liftAndConvertBlocks(blocks, 'paragraph')
    return
  }
  if (type === 'h1' || type === 'h2' || type === 'h3') {
    const level = type === 'h1' ? 1 : type === 'h2' ? 2 : 3
    // lift + 改 heading level 必须在同一 transaction,否则 lift 后 pos 失效
    liftAndConvertBlocks(blocks, 'heading', (tr, node, pos) => {
      if (node.type.name === 'heading') {
        // heading→heading 用 setNodeMarkup 保留子内容,NodeViewContent 不会被重置
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, level })
      } else {
        // 其他 → setBlockType 创建新 heading 节点
        tr.setBlockType(pos, pos + node.nodeSize, tr.doc.type.schema.nodes.heading, { level })
      }
    })
    return
  }
  if (type === 'quote') {
    // 检查所有块是否都已在外层 blockquote 里(用于 toggle-off)
    const allInQuote = blocks.every(({ pos }) => isPosInsideBlockquote(e.state, pos))
    if (allInQuote) {
      liftAndConvertBlocks(blocks, 'paragraph')
    } else {
      wrapBlocks(blocks, 'blockquote')
    }
    return
  }
  if (type === 'code') {
    liftAndConvertBlocks(blocks, 'codeBlock')
    return
  }
}

// 把块从外层 blockquote 里 lift 出来,然后在同一个 transaction 里把它们转成目标类型
// (用 Tiptap 自带的 lift 命令,内部用 $pos.blockRange() 正确处理位置;
//  tr.lift(from, to) 直接传数字会触发 internal ProseMirror 错误)
function liftAndConvertBlocks(
  blocks: { pos: number; node: NonNullable<ReturnType<ReturnType<typeof props.editor>['state']['doc']['nodeAt']>> }[],
  targetTypeName: 'paragraph' | 'heading' | 'codeBlock',
  perBlockConvert?: (tr: AnyEditor['state']['tr'], node: NonNullable<ReturnType<ReturnType<typeof props.editor>['state']['doc']['nodeAt']>>, pos: number) => void,
) {
  const e = props.editor
  if (!e) return
  e.chain().focus().command(({ tr, state }: { tr: AnyEditor['state']['tr']; state: AnyEditor['state'] }) => {
    const targetType = state.schema.nodes[targetTypeName]
    if (!targetType) return false
    const blockquoteType = state.schema.nodes.blockquote

    // 步骤 1:lift 每个块从外层 blockquote
    // 用 $pos.blockRange() 拿到正确的 NodeRange,然后 tr.lift(range, target)
    // 不用 from/to 数字 — ProseMirror 内部需要 NodeRange 对象
    for (let i = blocks.length - 1; i >= 0; i--) {
      const { pos } = blocks[i]
      const $pos = state.doc.resolve(pos)
      const $end = state.doc.resolve(pos + blocks[i].node.nodeSize)
      // blockRange 的第二个参数是谓词函数(node) => boolean,不是 spec 对象
      const range = $pos.blockRange($end, (node: { type: { name: string } }) => node.type === blockquoteType)
      if (range) {
        // 找一个有效的 lift target:lift 到 blockquote 之上
        const liftTgt = (() => {
          for (let d = range.depth; d > 0; d--) {
            if (range.$from.node(d - 1).type === blockquoteType) {
              return d - 1
            }
          }
          return null
        })()
        if (liftTgt !== null) {
          tr.lift(range, liftTgt)
        }
      }
    }

    // 步骤 2:lift 后块位置变了(往上移动),需要重新找块位置再转换类型
    // 用原始 pos 作 hint,在 tr.doc 里找对应的 textblock
    for (let i = 0; i < blocks.length; i++) {
      const { pos } = blocks[i]
      // lift 不会改变块的内容位置(块本身还在原 pos,只是少了外层 blockquote)
      const cur = tr.doc.nodeAt(pos)
      if (!cur || !cur.isTextblock) continue
      if (perBlockConvert) {
        perBlockConvert(tr, cur, pos)
      } else {
        tr.setBlockType(pos, pos + cur.nodeSize, targetType)
      }
    }
    return true
  }).run()
}

// 检查 pos 所在的块是否被外层 blockquote 包裹
function isPosInsideBlockquote(state: { doc: { resolve: (pos: number) => { depth: number; node: (d: number) => { type: { name: string } } } } }, pos: number): boolean {
  const $pos = state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'blockquote') return true
  }
  return false
}

// 把一组块整体包进 container(blockquote)
function wrapBlocks(
  blocks: { pos: number; node: NonNullable<ReturnType<ReturnType<typeof props.editor>['state']['doc']['nodeAt']>> }[],
  typeName: 'blockquote',
) {
  const e = props.editor
  if (!e) return
  // 直接 chain wrapIn,不预先 setTextSelection(逐块 chain 会自己设选区)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { pos, node } = blocks[i]
    const endPos = pos + node.nodeSize
    // 必须 focus():点工具栏按钮时编辑器没焦点,wrapIn 在 unfocused 状态下不会应用
    e.chain().focus().setTextSelection({ from: pos, to: endPos }).wrapIn(typeName).run()
  }
}

function matchesBlockType(node: { type: { name: string }; attrs: { level?: number } }, type: BlockTypeOpt['id']): boolean {
  switch (type) {
    case 'p': return node.type.name === 'paragraph'
    case 'h1': return node.type.name === 'heading' && node.attrs.level === 1
    case 'h2': return node.type.name === 'heading' && node.attrs.level === 2
    case 'h3': return node.type.name === 'heading' && node.attrs.level === 3
    case 'quote': return node.type.name === 'blockquote'
    case 'code': return node.type.name === 'codeBlock'
  }
}

function blockTypeToNodeType(type: BlockTypeOpt['id'], schema: AnyEditor['schema']) {
  switch (type) {
    case 'p': return schema.nodes.paragraph
    case 'h1':
    case 'h2':
    case 'h3': return schema.nodes.heading
    case 'quote': return schema.nodes.blockquote
    case 'code': return schema.nodes.codeBlock
  }
}

const blockTypeOpen = ref(false)
const blockTypeWrap = ref<HTMLElement | null>(null)

function toggleBlockType() {
  blockTypeOpen.value = !blockTypeOpen.value
}

function onSelectBlockType(type: BlockTypeOpt['id']) {
  setBlockType(type)
  blockTypeOpen.value = false
}

function onDocMouseDown(e: MouseEvent) {
  const target = e.target as Node
  if (blockTypeOpen.value && blockTypeWrap.value && !blockTypeWrap.value.contains(target)) {
    blockTypeOpen.value = false
  }
  if (linkPopoverOpen.value && linkWrap.value && !linkWrap.value.contains(target)) {
    linkPopoverOpen.value = false
  }
  if (colorPopoverMode.value && colorWrap.value && !colorWrap.value.contains(target)) {
    colorPopoverMode.value = null
  }
  if (tableMenuOpen.value && tableMenuWrap.value && !tableMenuWrap.value.contains(target)) {
    tableMenuOpen.value = false
  }
  if (calloutMenuOpen.value && calloutMenuWrap.value && !calloutMenuWrap.value.contains(target)) {
    calloutMenuOpen.value = false
  }
  if (emojiOpen.value && emojiWrap.value && !emojiWrap.value.contains(target)) {
    emojiOpen.value = false
  }
  if (datePickerOpen.value && dateWrap.value && !dateWrap.value.contains(target)) {
    datePickerOpen.value = false
  }
  if (datePopoverOpen.value && dateWrap.value && !dateWrap.value.contains(target)) {
    datePopoverOpen.value = false
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (emojiOpen.value && e.key === 'Escape') {
    e.preventDefault()
    emojiOpen.value = false
  }
  if (datePopoverOpen.value && e.key === 'Escape') {
    e.preventDefault()
    datePopoverOpen.value = false
    return
  }
  if (datePickerOpen.value && e.key === 'Escape') {
    e.preventDefault()
    datePickerOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onKeyDown)
})

function handleClick(btn: Btn) {
  if (!props.editor) return
  if (btn.disabled?.()) return
  btn.run()
}
</script>

<template>
  <div v-if="editor" class="editor-toolbar">
    <div class="tb-inner">
      <!-- 历史组:撤销 / 重做 -->
      <div class="tb-group">
        <button
          v-for="btn in historyBtns"
          :key="btn.id"
          class="tb-btn"
          :disabled="btn.disabled?.()"
          :title="btn.shortcut ? `${btn.title} (${btn.shortcut})` : btn.title"
          @click="handleClick(btn)"
        >
          <span class="material-symbols-outlined">{{ btn.icon }}</span>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 块类型下拉 -->
      <div ref="blockTypeWrap" class="tb-block-type-wrap" :class="{ open: blockTypeOpen }">
        <button
          class="tb-block-type"
          type="button"
          :aria-expanded="blockTypeOpen"
          aria-haspopup="menu"
          @click="toggleBlockType"
        >
          <span>{{ blockTypeLabel }}</span>
          <span class="material-symbols-outlined chev">expand_more</span>
        </button>
        <Transition name="popover-fade">
        <div v-if="blockTypeOpen" class="tb-block-type-menu">
          <button
            v-for="opt in blockTypeOptions"
            :key="opt.id"
            class="tb-block-type-opt"
            :class="{ active: opt.isActive() }"
            @mousedown.prevent="onSelectBlockType(opt.id)"
          >
            <span class="material-symbols-outlined">{{ opt.icon }}</span>
            <span>{{ opt.label }}</span>
          </button>
        </div>
        </Transition>
      </div>

      <div class="tb-sep"></div>

      <!-- 文本格式组 -->
      <div class="tb-group">
        <button
          v-for="btn in formatBtns"
          :key="btn.id"
          class="tb-btn"
          :class="{ active: btn.isActive?.() }"
          :title="btn.shortcut ? `${btn.title} (${btn.shortcut})` : btn.title"
          @click="handleClick(btn)"
        >
          <span class="material-symbols-outlined">{{ btn.icon }}</span>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 链接(独立:有 popover) -->
      <div ref="linkWrap" class="tb-link-wrap">
        <button
          class="tb-btn"
          :class="{ active: linkBtn.isActive?.() }"
          :disabled="linkBtn.disabled?.()"
          :title="linkBtn.title"
          @click="handleClick(linkBtn)"
        >
          <span class="material-symbols-outlined">{{ linkBtn.icon }}</span>
        </button>
        <Transition name="popover-fade">
        <LinkPopover
          v-if="linkPopoverOpen"
          :editor="editor"
          :open="linkPopoverOpen"
          @close="closeLinkPopover"
        />
        </Transition>
      </div>

      <div class="tb-sep"></div>

      <!-- 颜色组(文字色 + 高亮) -->
      <div ref="colorWrap" class="tb-color-wrap">
        <button
          class="tb-btn tb-color-btn"
          :class="{ active: currentTextColor() !== null }"
          title="文字颜色"
          @click="openColorPopover('text')"
        >
          <span class="material-symbols-outlined">format_color_text</span>
          <span
            class="tb-color-bar"
            :style="{ background: textColorSwatch() === 'transparent' ? 'var(--text-1)' : textColorSwatch() }"
          ></span>
        </button>
        <button
          class="tb-btn tb-color-btn"
          :class="{ active: currentHighlightColor() !== null }"
          title="背景颜色"
          @click="openColorPopover('highlight')"
        >
          <span class="material-symbols-outlined">format_color_fill</span>
          <span
            class="tb-color-bar"
            :style="{ background: highlightSwatch() === 'transparent' ? 'var(--bg-subtle)' : highlightSwatch() }"
          ></span>
        </button>
        <Transition name="popover-fade">
        <ColorPopover
          v-if="colorPopoverMode"
          :editor="editor"
          :mode="colorPopoverMode"
          @close="closeColorPopover"
        />
        </Transition>
      </div>

      <div class="tb-sep"></div>

      <!-- 列表组 -->
      <div class="tb-group">
        <button
          v-for="btn in listBtns"
          :key="btn.id"
          class="tb-btn"
          :class="{ active: btn.isActive?.() }"
          :title="btn.title"
          @click="handleClick(btn)"
        >
          <span class="material-symbols-outlined">{{ btn.icon }}</span>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 缩进/反缩进 -->
      <div class="tb-group">
        <button
          v-for="btn in indentBtns"
          :key="btn.id"
          class="tb-btn"
          :disabled="btn.disabled?.()"
          :title="btn.shortcut ? `${btn.title} (${btn.shortcut})` : btn.title"
          @click="handleClick(btn)"
        >
          <span class="material-symbols-outlined">{{ btn.icon }}</span>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 文字对齐 -->
      <div class="tb-group">
        <button
          v-for="btn in alignBtns"
          :key="btn.id"
          class="tb-btn"
          :class="{ active: btn.isActive?.() }"
          :title="btn.title"
          @click="handleClick(btn)"
        >
          <span class="material-symbols-outlined">{{ btn.icon }}</span>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 表格操作(仅在光标处于表格内时显示):单个下拉入口,避免挤工具栏 -->
      <div v-if="isInTable" ref="tableMenuWrap" class="tb-block-type-wrap" :class="{ open: tableMenuOpen }">
        <button
          class="tb-block-type"
          type="button"
          :aria-expanded="tableMenuOpen"
          aria-haspopup="menu"
          @click="toggleTableMenu"
        >
          <span class="material-symbols-outlined icon-lg">table_chart</span>
          <span>表格</span>
          <span class="material-symbols-outlined chev">expand_more</span>
        </button>
        <Transition name="popover-fade">
        <div v-if="tableMenuOpen" class="tb-block-type-menu tb-table-menu">
          <template v-for="(opt, idx) in tableMenuOptions" :key="idx">
            <div v-if="opt.kind === 'separator'" class="tb-block-type-sep"></div>
            <div
              v-else-if="opt.kind === 'picker' && opt.id === 'cellColor'"
              class="tb-cell-color"
              @mousedown.stop
            >
              <button
                type="button"
                class="tb-block-type-opt tb-cell-color-trigger"
                :class="{ active: !!currentCellBg() }"
                :aria-expanded="cellColorOpen"
                @mousedown.prevent="cellColorOpen = !cellColorOpen"
              >
                <span class="material-symbols-outlined">{{ opt.icon }}</span>
                <span>{{ opt.label }}</span>
                <span
                  class="tb-cell-color-bar"
                  :style="{ background: currentCellBg() || 'transparent' }"
                ></span>
                <span class="material-symbols-outlined chev" style="font-size:14px;margin-left:auto">expand_more</span>
              </button>
              <Transition name="popover-fade">
              <div v-if="cellColorOpen" class="tb-cell-color-popover">
                <div class="tb-cell-color-grid">
                  <button
                    v-for="c in CELL_COLORS"
                    :key="c.value || 'none'"
                    type="button"
                    class="tb-cell-color-swatch"
                    :class="{ active: currentCellBg() === c.value }"
                    :title="c.name"
                    @mousedown.prevent="applyCellColor(c.value)"
                  >
                    <span v-if="c.value" class="tb-cell-color-dot" :style="{ background: c.value }"></span>
                    <span v-else class="material-symbols-outlined tb-cell-color-none">format_color_reset</span>
                  </button>
                </div>
                <div class="tb-block-type-sep" style="margin: 4px 2px"></div>
                <button
                  class="tb-block-type-opt danger"
                  style="height: 26px; font-size: 12px;"
                  @mousedown.prevent="clearCellColor"
                >
                  <span class="material-symbols-outlined icon-sm">format_color_reset</span>
                  <span>清除背景</span>
                </button>
              </div>
              </Transition>
            </div>
            <button
              v-else
              class="tb-block-type-opt"
              :class="{ danger: opt.danger, active: opt.isActive?.() }"
              @mousedown.prevent="runTableAction(opt.id)"
            >
              <span class="material-symbols-outlined">{{ opt.icon }}</span>
              <span>{{ opt.label }}</span>
            </button>
          </template>
        </div>
        </Transition>
      </div>

      <div v-if="isInTable" class="tb-sep"></div>

      <!-- 插入组 -->
      <div class="tb-group">
        <button
          v-for="btn in insertBtns"
          :key="btn.id"
          class="tb-btn"
          :class="{ active: btn.isActive?.() }"
          :disabled="btn.disabled?.()"
          :title="btn.title"
          @click="handleClick(btn)"
        >
          <span class="material-symbols-outlined">{{ btn.icon }}</span>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 表情(独立 popover) -->
      <div ref="emojiWrap" class="tb-emoji-wrap" :class="{ open: emojiOpen }">
        <button
          type="button"
          class="tb-btn"
          :class="{ active: emojiOpen }"
          title="插入表情"
          aria-haspopup="menu"
          :aria-expanded="emojiOpen"
          @click="toggleEmoji"
        >
          <span class="material-symbols-outlined">add_reaction</span>
        </button>
        <Transition name="popover-fade">
        <div v-if="emojiOpen" class="tb-emoji-popover">
          <EmojiPicker :editor="editor" @close="closeEmoji" />
        </div>
        </Transition>
      </div>

      <div class="tb-sep"></div>

      <!-- 日期/时间(独立 popover:下拉 3 选 1,或弹 picker 自定义) -->
      <div ref="dateWrap" class="tb-date-wrap" :class="{ open: datePickerOpen || datePopoverOpen }">
        <button
          type="button"
          class="tb-btn"
          :class="{ active: datePickerOpen || datePopoverOpen || isOnDateInline() }"
          title="插入日期/时间"
          aria-haspopup="menu"
          :aria-expanded="datePickerOpen"
          @click.stop="toggleDateDropdown"
        >
          <span class="material-symbols-outlined">schedule</span>
        </button>
        <!-- 快速选项下拉 -->
        <Transition name="popover-fade">
        <div v-if="datePickerOpen" class="tb-date-menu tb-block-type-menu">
          <button type="button" class="tb-block-type-opt" @mousedown.stop.prevent="insertDateNow">
            <span class="material-symbols-outlined">schedule</span>
            <span>今天(自动)</span>
          </button>
          <button type="button" class="tb-block-type-opt" @mousedown.stop.prevent="insertDateTodayOnly">
            <span class="material-symbols-outlined">today</span>
            <span>今天日期</span>
          </button>
          <div class="tb-block-type-sep"></div>
          <button type="button" class="tb-block-type-opt" @mousedown.stop.prevent="openDatePopover">
            <span class="material-symbols-outlined">event</span>
            <span>指定日期…</span>
          </button>
        </div>
        </Transition>
        <!-- 完整 picker 弹层 -->
        <Transition name="popover-fade">
        <div v-if="datePopoverOpen" class="tb-date-popover" @mousedown.stop>
          <DateTimePicker @insert="onDateInsert" @cancel="onDateCancel" />
        </div>
        </Transition>
      </div>

      <div v-if="currentCalloutVariant" class="tb-sep"></div>

      <!-- 提示框变体(仅在光标处于 callout 内时显示) -->
      <div v-if="currentCalloutVariant" ref="calloutMenuWrap" class="tb-block-type-wrap" :class="{ open: calloutMenuOpen }">
        <button
          class="tb-block-type"
          type="button"
          :aria-expanded="calloutMenuOpen"
          aria-haspopup="menu"
          @click="toggleCalloutMenu"
        >
          <span class="material-symbols-outlined icon-lg">{{ CALLOUT_ICON_MAP[currentCalloutVariant] }}</span>
          <span>{{ ({ info: '信息', success: '成功', warning: '警告', danger: '危险' } as Record<string, string>)[currentCalloutVariant] }}</span>
          <span class="material-symbols-outlined chev">expand_more</span>
        </button>
        <Transition name="popover-fade">
        <div v-if="calloutMenuOpen" class="tb-block-type-menu">
          <button
            v-for="v in CALLOUT_VARIANTS"
            :key="v"
            class="tb-block-type-opt"
            :class="{ active: v === currentCalloutVariant }"
            @mousedown.prevent="runCalloutAction(v)"
          >
            <span class="material-symbols-outlined">{{ CALLOUT_ICON_MAP[v] }}</span>
            <span>{{ ({ info: '信息', success: '成功', warning: '警告', danger: '危险' } as Record<string, string>)[v] }}</span>
          </button>
          <div class="tb-block-type-sep"></div>
          <button class="tb-block-type-opt danger" @mousedown.prevent="runCalloutAction('unset')">
            <span class="material-symbols-outlined">delete_sweep</span>
            <span>移除提示框</span>
          </button>
        </div>
        </Transition>
      </div>

    </div>
  </div>
</template>

<style scoped>
/* 统一所有工具栏 popover / menu / 下拉的入场退场动画 */
.popover-fade-enter-active,
.popover-fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.popover-fade-enter-from,
.popover-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.tb-block-type-wrap {
  position: relative;
}
.tb-block-type {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-md);
  border: none;
  background: transparent;
  color: var(--text-1);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.tb-block-type:hover { background: var(--bg-subtle); }
.tb-block-type .chev {
  font-size: 16px;
  color: var(--text-3);
  transition: transform 150ms ease;
}
.tb-block-type-wrap.open .tb-block-type .chev {
  transform: rotate(180deg);
}

.tb-block-type-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 4px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tb-block-type-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  white-space: nowrap;
}
.tb-block-type-opt:hover { background: var(--bg-subtle); color: var(--text-1); }
.tb-block-type-opt.active { background: var(--accent-soft); color: var(--accent); }
.tb-block-type-opt.danger { color: var(--danger); }
.tb-block-type-opt.danger:hover { background: var(--danger-soft); color: var(--danger); }
.tb-block-type-opt .material-symbols-outlined { font-size: 18px; }

.tb-block-type-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
  flex-shrink: 0;
}

.tb-link-wrap { position: relative; }

/* 表情 popover 容器 */
.tb-emoji-wrap { position: relative; }
.tb-emoji-popover {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 110;
}

/* 颜色按钮 — 底部带一根小色条显示当前颜色 */
.tb-color-wrap { position: relative; display: inline-flex; gap: 0; }
.tb-color-btn {
  position: relative;
  padding-bottom: 2px !important;
}
.tb-color-btn .tb-color-bar {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 2px;
  height: 2px;
  border-radius: 1px;
}
</style>

