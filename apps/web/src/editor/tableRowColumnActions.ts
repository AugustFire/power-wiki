/**
 * 表格行 / 列 hot zone + 动作 popover
 *
 * 每个表格在视觉上挂 5 类 widget(都是 ProseMirror Decoration.widget,挂
 * 在 PM 装饰树里、不进 doc.toJSON,跟 DOMObserver 互不打架 —— 直接
 * appendChild 会触发 reconfigure 锁死编辑器,见第一版踩坑记录):
 *
 * 1. `.table-add-row` — 底边「+ 添加行」,addRowAfter 一键加行(沿用原
 *    tableHoverControls.ts 的实现,不动)
 * 2. `.table-add-col` — 右边「+ 添加列」,addColumnAfter 一键加列(同上)
 * 3. `.table-row-hotzone` × N 行 — 行左侧 6px 竖条,默认 hidden,行被
 *    hover 时浮现(JS 追踪),点击触发整行 CellSelection + 行 popover
 * 4. `.table-col-hotzone` × N 列 — 首行顶部 6px 横条,默认 hidden,列被
 *    hover 时浮现,点击触发整列 CellSelection + 列 popover
 * 5. `.table-action-popover` × 1 表 — 行/列 popover 容器,默认 hidden,
 *    is-open 时按 type 渲染 5 个动作按钮(insert × 2 / delete / move × 2)
 *
 * 移动行/列: Tiptap 2.27 不内置 moveRow / moveColumn,包一层底层
 * prosemirror-tables 的 moveTableRow / moveTableColumn,通过 addCommands
 * 暴露成 chain()-able 命令。
 *
 * popover open 状态存到 plugin `state` 字段:`{popover: null | {type, tablePos, index}}`,
 * 通过 tr.setMeta(pluginKey, ...) 写入。view.update 检测到 popover state
 * 变化时同步 DOM:渲染按钮 + 设置 is-open class + 计算位置 + 派发
 * CellSelection.rowSelection/colSelection 给整行/列加 .selectedCell 高亮
 * (复用 components.css:2361-2366 已有的样式)。
 *
 * 关闭 popover:点 popover 内按钮 → 派发命令后 setMeta(popover: null);
 * 点 popover 外 / 按 Esc → document-level mousedown / keydown 监听命中
 * 后 setMeta + 退到 TextSelection 清掉 CellSelection。
 *
 * 注意:widget DOM 实际会落到 <tbody> 里、与 <tr> 同级(HTML 严格说只允
 * 许 <tr> 在 <tbody>,但浏览器对 position:absolute 的 <div> 容错,layout
 * 不受影响 —— 这是 PM Decoration.widget 装饰的标准落地位置)。
 */
import { Extension } from '@tiptap/core'
import type { CommandProps } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view'
import {
  CellSelection,
  TableMap,
  findTable,
  selectedRect,
  addRow,
  addColumn,
  moveTableRow as moveTableRowCmd,
  moveTableColumn as moveTableColumnCmd,
} from 'prosemirror-tables'

const pluginKey = new PluginKey<PopoverState>('tableRowColumnActions')

// Tiptap 通过模块声明合并给 Commands 接口添加新命令,Partial<RawCommands>
// 才能包含我们的 moveTableRowUp/Down/Left/Right。
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableRowColumnActions: {
      moveTableRowUp: () => ReturnType
      moveTableRowDown: () => ReturnType
      moveTableColumnLeft: () => ReturnType
      moveTableColumnRight: () => ReturnType
      addRowToEnd: () => ReturnType
      addColumnToEnd: () => ReturnType
    }
  }
}

interface PopoverState {
  popover: null | { type: 'row' | 'col'; tablePos: number; index: number }
}

// ── widget DOM 构造 ────────────────────────────────────────────────────

function makeAddRowButton(
  onClick: () => void,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'table-add-row'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'table-add-btn'
  btn.title = '在表格末尾添加一行'
  btn.setAttribute('aria-label', '在表格末尾添加一行')
  const icon = document.createElement('span')
  icon.className = 'material-symbols-outlined'
  icon.textContent = 'add'
  btn.appendChild(icon)
  wrap.appendChild(btn)
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return wrap
}

function makeAddColButton(
  onClick: () => void,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'table-add-col'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'table-add-btn'
  btn.title = '在表格末尾添加一列'
  btn.setAttribute('aria-label', '在表格末尾添加一列')
  const icon = document.createElement('span')
  icon.className = 'material-symbols-outlined'
  icon.textContent = 'add'
  btn.appendChild(icon)
  wrap.appendChild(btn)
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return wrap
}

function makeRowHotzone(
  rowIndex: number,
  tablePos: number,
  onActivate: () => void,
): HTMLElement {
  const div = document.createElement('div')
  div.className = 'table-row-hotzone'
  div.dataset.rowIdx = String(rowIndex)
  div.dataset.tablePos = String(tablePos)
  div.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onActivate()
  })
  return div
}

function makeColHotzone(
  colIndex: number,
  tablePos: number,
  onActivate: () => void,
): HTMLElement {
  const div = document.createElement('div')
  div.className = 'table-col-hotzone'
  div.dataset.colIdx = String(colIndex)
  div.dataset.tablePos = String(tablePos)
  div.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onActivate()
  })
  return div
}

function makeActionPopover(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'table-action-popover'
  return div
}

// ── 行 / 列首尾 cell 位置 ─────────────────────────────────────────────

function rowCellPosRange(
  tablePos: number,
  tableNode: import('@tiptap/pm/model').Node,
  rowIndex: number,
): { first: number; last: number } | null {
  const map = TableMap.get(tableNode)
  if (rowIndex < 0 || rowIndex >= map.height) return null
  // 行内首个 cell 的位置:TableMap.positionAt(rowIndex, 0, tableNode) 返回
  // 相对 tableStart 的位置,加上 tablePos + 1(进到 table 第一个 token 之后)。
  const firstRel = map.positionAt(rowIndex, 0, tableNode)
  const lastRel = map.positionAt(rowIndex, map.width - 1, tableNode)
  return {
    first: tablePos + 1 + firstRel,
    last: tablePos + 1 + lastRel,
  }
}

function colCellPosRange(
  tablePos: number,
  tableNode: import('@tiptap/pm/model').Node,
  colIndex: number,
): { first: number; last: number } | null {
  const map = TableMap.get(tableNode)
  if (colIndex < 0 || colIndex >= map.width) return null
  const firstRel = map.positionAt(0, colIndex, tableNode)
  const lastRel = map.positionAt(map.height - 1, colIndex, tableNode)
  return {
    first: tablePos + 1 + firstRel,
    last: tablePos + 1 + lastRel,
  }
}

// ── popover 激活 / 关闭 ────────────────────────────────────────────────

function activatePopover(
  view: EditorView,
  tablePos: number,
  type: 'row' | 'col',
  index: number,
) {
  const state = view.state
  const table = state.doc.nodeAt(tablePos)
  if (!table) return
  const range =
    type === 'row'
      ? rowCellPosRange(tablePos, table, index)
      : colCellPosRange(tablePos, table, index)
  if (!range) return
  const $first = state.doc.resolve(range.first)
  const $last = state.doc.resolve(range.last)
  const sel =
    type === 'row'
      ? CellSelection.rowSelection($first, $last)
      : CellSelection.colSelection($first, $last)
  const tr = state.tr
    .setSelection(sel)
    .setMeta(pluginKey, { popover: { type, tablePos, index } })
  view.dispatch(tr)
}

function closePopover(
  view: EditorView,
) {
  const state = view.state
  const cur = pluginKey.getState(state)
  if (!cur?.popover) return
  // 退到 TextSelection:从 CellSelection 拿 anchor cell 的位置;若没有就
  // 退到 current from
  const sel = state.selection
  let fallbackPos = sel.from
  if (sel instanceof CellSelection) {
    const $anchor = sel.$anchorCell || sel.$from
    fallbackPos = $anchor.pos
  }
  const tr = state.tr
    .setSelection(TextSelection.create(state.doc, fallbackPos))
    .setMeta(pluginKey, { popover: null })
  view.dispatch(tr)
}

// ── popover 按钮渲染 ───────────────────────────────────────────────────

function renderRowPopover(
  view: EditorView,
  editor: import('@tiptap/core').Editor,
  rowIndex: number,
  rowCount: number,
): HTMLElement[] {
  // 布局:横向 5 枚按钮,组与组之间用 .group-divider (CSS 竖线) 隔开
  //   [⊕ above] [⊕ below] │ [−] │ [↑] [↓]
  // 全 icon-only,不带文字,鼠标 hover 触发浏览器原生 tooltip(title)
  // 让 popover 像现代浮动工具条,而不是传统下拉菜单
  const groups: Array<Array<ActionSpec>> = [
    [
      { label: '在上方插入行', icon: 'vertical_align_top', run: () => editor.chain().focus().addRowBefore().run() },
      { label: '在下方插入行', icon: 'vertical_align_bottom', run: () => editor.chain().focus().addRowAfter().run() },
    ],
    [
      { label: '删除该行', icon: 'horizontal_rule', run: () => editor.chain().focus().deleteRow().run(), danger: true },
    ],
    [
      { label: '上移该行', icon: 'arrow_upward', run: () => editor.chain().moveTableRowUp().run(), disabled: rowIndex === 0 },
      { label: '下移该行', icon: 'arrow_downward', run: () => editor.chain().moveTableRowDown().run(), disabled: rowIndex >= rowCount - 1 },
    ],
  ]
  return groups.flatMap((group, gi) => {
    if (gi > 0) group.unshift({ label: '', icon: '__divider__', run: () => {} })
    return group.map((it) => makeIconButton(it, view, 'row', rowIndex))
  })
}

function renderColPopover(
  view: EditorView,
  editor: import('@tiptap/core').Editor,
  colIndex: number,
  colCount: number,
): HTMLElement[] {
  const groups: Array<Array<ActionSpec>> = [
    [
      { label: '在左侧插入列', icon: 'align_horizontal_left', run: () => editor.chain().focus().addColumnBefore().run() },
      { label: '在右侧插入列', icon: 'align_horizontal_right', run: () => editor.chain().focus().addColumnAfter().run() },
    ],
    [
      { label: '左对齐该列', icon: 'format_align_left', run: () => editor.chain().focus().setCellAttribute('textAlign', 'left').run() },
      { label: '居中对齐该列', icon: 'format_align_center', run: () => editor.chain().focus().setCellAttribute('textAlign', 'center').run() },
      { label: '右对齐该列', icon: 'format_align_right', run: () => editor.chain().focus().setCellAttribute('textAlign', 'right').run() },
    ],
    [
      { label: '删除该列', icon: 'vertical_distribute', run: () => editor.chain().focus().deleteColumn().run(), danger: true },
    ],
    [
      { label: '左移该列', icon: 'arrow_back', run: () => editor.chain().moveTableColumnLeft().run(), disabled: colIndex === 0 },
      { label: '右移该列', icon: 'arrow_forward', run: () => editor.chain().moveTableColumnRight().run(), disabled: colIndex >= colCount - 1 },
    ],
  ]
  return groups.flatMap((group, gi) => {
    if (gi > 0) group.unshift({ label: '', icon: '__divider__', run: () => {} })
    return group.map((it) => makeIconButton(it, view, 'col', colIndex))
  })
}

interface ActionSpec {
  label: string
  icon: string
  run: () => void
  danger?: boolean
  disabled?: boolean
}

function makeIconButton(
  item: ActionSpec,
  view: EditorView,
  type: 'row' | 'col',
  targetIndex: number,
): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  if (item.icon === '__divider__') {
    b.className = 'group-divider'
    b.disabled = true
    b.setAttribute('aria-hidden', 'true')
    return b
  }
  if (item.danger) b.className = 'danger'
  if (item.disabled) (b as HTMLButtonElement).disabled = true
  b.title = item.label
  b.setAttribute('aria-label', item.label)
  const ic = document.createElement('span')
  ic.className = 'material-symbols-outlined icon'
  ic.textContent = item.icon
  b.appendChild(ic)
  b.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (item.disabled) return
    // 1. 执行动作。editor.chain()...run() 同步派发 tr,PM 立即更新 view.state
    item.run()
    // 2. 重新激活 popover 给同一行/列 index。Confluence-style:动作后
    //    popover 不关,继续可点下一个动作(避免每个动作都得点回 handle)。
    //    - 移动 (上/下/左/右) → raw 命令带 select:true,swap 后 CellSelection
    //      自动落在「被移动的那一行/列所在的新位置」。高亮跟着 selection 走,
    //      这样用户连续点两次「下移」就会让高亮一路下移,而不是停在原地。
    //    - 插入到「后/右」→ index+1(新行/列落在原 index 的下一侧,选中新行)。
    //    - 插入到「前/左」、删除 → index 不变(保留原行/列的引用)。
    //    - 当 targetIndex ≥ 新 limit(删除了最后一行/列)→ 跳过,popover 自然关闭。
    const isMove =
      item.icon === 'arrow_upward' || item.icon === 'arrow_downward' ||
      item.icon === 'arrow_back' || item.icon === 'arrow_forward'
    let keepIdx: number
    if (isMove) {
      const sel = view.state.selection
      if (!(sel instanceof CellSelection)) return
      const movedRect = selectedRect(view.state)
      keepIdx = type === 'row' ? movedRect.top : movedRect.left
    } else {
      const table = findTable(view.state.selection.$from)
      if (!table) return
      const map = TableMap.get(table.node)
      const limit = type === 'row' ? map.height : map.width
      keepIdx =
        item.icon === 'vertical_align_bottom' || item.icon === 'align_horizontal_right'
          ? Math.min(targetIndex + 1, limit - 1)
          : Math.min(targetIndex, limit - 1)
    }
    if (keepIdx < 0) return
    const table = findTable(view.state.selection.$from)
    if (!table) return
    activatePopover(view, table.pos, type, keepIdx)
  })
  return b
}

// ── 同步 hot zone / popover DOM 位置 ──────────────────────────────────

function syncHotzonePositions(
  view: EditorView,
) {
  const wrappers = view.dom.querySelectorAll<HTMLElement>('.tableWrapper')
  for (const wrap of wrappers) {
    const wrapRect = wrap.getBoundingClientRect()
    const table = wrap.querySelector<HTMLElement>('table')
    if (!table) continue
    const tableRect = table.getBoundingClientRect()
    const addRow = wrap.querySelector<HTMLElement>('.table-add-row')
    const addCol = wrap.querySelector<HTMLElement>('.table-add-col')
    if (addRow) {
      addRow.style.left = `${tableRect.left - wrapRect.left}px`
      addRow.style.width = `${tableRect.width}px`
    }
    if (addCol) {
      addCol.style.left = `${tableRect.right - wrapRect.left}px`
      addCol.style.height = `${tableRect.height}px`
    }
    // 行 hot zone:与 tbody > tr 同列对齐(基于 rowIndex)
    const rows = wrap.querySelectorAll<HTMLElement>('tbody > tr')
    const rowHotzones = wrap.querySelectorAll<HTMLElement>('.table-row-hotzone')
    for (const hz of rowHotzones) {
      const idx = Number(hz.dataset.rowIdx)
      const row = rows[idx]
      if (!row) continue
      const rowRect = row.getBoundingClientRect()
      hz.style.top = `${rowRect.top - wrapRect.top}px`
      hz.style.height = `${rowRect.height}px`
    }
    // 列 hot zone:首行 cell 的横向位置
    const firstRow = wrap.querySelector<HTMLElement>('tbody > tr')
    const colHotzones = wrap.querySelectorAll<HTMLElement>('.table-col-hotzone')
    if (firstRow) {
      const cells = firstRow.querySelectorAll<HTMLElement>('th, td')
      for (const hz of colHotzones) {
        const idx = Number(hz.dataset.colIdx)
        const cell = cells[idx]
        if (!cell) continue
        const cellRect = cell.getBoundingClientRect()
        hz.style.left = `${cellRect.left - wrapRect.left}px`
        hz.style.width = `${cellRect.width}px`
      }
    }
  }
}

function syncPopoverDom(
  view: EditorView,
  editor: import('@tiptap/core').Editor,
) {
  const state = pluginKey.getState(view.state)
  const popovers = view.dom.querySelectorAll<HTMLElement>('.table-action-popover')
  // 先清掉所有手柄的 is-active,后面再给当前打开 popover 的那个手柄加回来,
  // 让它在 popover 打开期间保持蓝色高亮(即使鼠标已移开表格)。
  view.dom
    .querySelectorAll<HTMLElement>('.table-row-hotzone.is-active, .table-col-hotzone.is-active')
    .forEach((el) => el.classList.remove('is-active'))
  for (const popover of popovers) {
    // 找出 popover 属于哪张表:向上找最近的 .tableWrapper,然后跟 popover
    // 内部 closure 里记的 tablePos 对照 —— 但 closure 不持久,这里改用
    // 当前 is-open 的 tablePos 反查:遍历所有 .tableWrapper,看 plugin
    // state 是否指向它。
    const wrap = popover.closest<HTMLElement>('.tableWrapper')
    if (!wrap) continue
    // 通过当前 doc 中对应 table 的 wrapper 找:遍历 view.state.doc 中所有
    // table,按 DOM 顺序匹配;wrapper 没有携带 tablePos,得反查 —— 简单
    // 做法:遍历所有 .tableWrapper,看是否有 popover.state.popover.tablePos
    // 等于该 wrapper 在 doc 中的位置。
    // 但我们没有直接的 docPos <-> DOM 映射。简化:遍历时,先把每个 wrapper
    // 在 doc 中的位置通过 view.dom.querySelector + state.doc.descendants
    // 配对。这里采用另一招:popover 元素上挂一个 dataset.tablePos 标记。
    const targetTablePos = Number(popover.dataset.tablePos)
    const target =
      state?.popover && state.popover.tablePos === targetTablePos
        ? state.popover
        : null
    if (!target) {
      popover.classList.remove('is-open')
      popover.innerHTML = ''
      popover.style.top = ''
      popover.style.left = ''
      popover.style.right = ''
      continue
    }
    // 渲染按钮
    const tableNode = view.state.doc.nodeAt(target.tablePos) as import('@tiptap/pm/model').Node | null
    if (!tableNode) {
      popover.classList.remove('is-open')
      popover.innerHTML = ''
      continue
    }
    const map = TableMap.get(tableNode)
    popover.innerHTML = ''
    const buttons =
      target.type === 'row'
        ? renderRowPopover(view, editor, target.index, map.height)
        : renderColPopover(view, editor, target.index, map.width)
    for (const b of buttons) popover.appendChild(b)
    // 位置:行 popover 出现在行右侧;列 popover 出现在列下方
    const wrapRect = wrap.getBoundingClientRect()
    if (target.type === 'row') {
      const row = wrap.querySelectorAll<HTMLElement>('tbody > tr')[target.index]
      if (!row) continue
      const rowRect = row.getBoundingClientRect()
      popover.style.top = `${rowRect.top - wrapRect.top + rowRect.height / 2}px`
      popover.style.left = `${rowRect.right - wrapRect.left + 8}px`
      popover.style.right = ''
    } else {
      const firstRow = wrap.querySelector<HTMLElement>('tbody > tr')
      if (!firstRow) continue
      const cells = firstRow.querySelectorAll<HTMLElement>('th, td')
      const cell = cells[target.index]
      if (!cell) continue
      const cellRect = cell.getBoundingClientRect()
      popover.style.top = `${cellRect.bottom - wrapRect.top + 8}px`
      popover.style.left = `${cellRect.left - wrapRect.left + cellRect.width / 2}px`
      popover.style.right = ''
    }
    popover.classList.add('is-open')
    // 高亮当前操作的手柄
    const activeHz = wrap.querySelectorAll<HTMLElement>(
      target.type === 'row' ? '.table-row-hotzone' : '.table-col-hotzone',
    )[target.index]
    activeHz?.classList.add('is-active')
  }
}

// Tiptap `chain()` 共享 tr 的关键陷阱:
// chain 给命令传的 `state` 是 createChainableState 包装的视图 —— 它的 `state.tr`
// 返回的是 chain 自己持有的那个 tr(在 createChain 里就 `state.tr` 一次抓了引用)。
// 链路里的每一次 `state.tr` 都返回同一个对象,任何命令往里加 step 都会被后续
// 步骤看到。
//
// 另一个陷阱:chain 的 `dispatch` 是 `() => undefined`(no-op),不会派发;真正
// 的派发发生在 chain.run() 末尾的 `view.dispatch(tr)`。所以命令里 `dispatch(tr)`
// 没用,要让 swap 可见必须保证 chain 的 tr 被正确修改。
//
// 早期版本的 bug:move 命令把 dry-run 和 actual run 都直接喂 `state`,dry-run
// 也往 chain 的 tr 加 step,actual run 再加 step,把 swap 一来一回抵消,用户看到
// "选中的位置移动" 了但内容没动。再后来加了 bridgeRawMove 把 spy 到的步骤
// replay 进 chain 的 tr,反而叠加出 4 个 step —— 在 PM 里多次 apply 同一个
// ReplaceStep(newTable) 会保留 newTable 引用,tr.docs 链不断扩,DOM 反复
// 替换 + syncPopoverDom 重渲染,堆到上限浏览器 OOM。
//
// 修复:dry-run 用 view.state(走 `view.state.tr` 创建独立的 fresh tr,跑完丢弃;
// 不会污染 chain 的 tr),actual run 才用 `state` 共享 tr,让 chain.run() 自己派发。

export const TableRowColumnActions = Extension.create({
  name: 'tableRowColumnActions',

  addCommands() {
    return {
      moveTableRowUp:
        () =>
        ({ state, dispatch, view }: CommandProps) => {
          if (!(state.selection instanceof CellSelection)) return false
          const rect = selectedRect(state)
          const rowIndex = rect.top
          if (rowIndex <= 0) return false
          // dry-run:走 view.state,内部 `state.tr` 创建的是独立的 fresh tr,
          // 跑完丢弃,不会污染 chain 的 tr。
          const dry = moveTableRowCmd({
            from: rowIndex,
            to: rowIndex - 1,
            pos: rect.tableStart,
          })(view.state, undefined)
          if (!dry) return false
          if (!dispatch) return true
          // actual run:raw 命令内部 `state.tr` 返回 chain 的 tr,直接修改。
          // chain 的 dispatch 是 no-op,真正的派发交给 chain.run()。
          return moveTableRowCmd({
            from: rowIndex,
            to: rowIndex - 1,
            select: true,
            pos: rect.tableStart,
          })(state, dispatch)
        },

      moveTableRowDown:
        () =>
        ({ state, dispatch, view }: CommandProps) => {
          if (!(state.selection instanceof CellSelection)) return false
          const rect = selectedRect(state)
          const rowIndex = rect.top
          if (rowIndex >= rect.map.height - 1) return false
          const dry = moveTableRowCmd({
            from: rowIndex,
            to: rowIndex + 1,
            pos: rect.tableStart,
          })(view.state, undefined)
          if (!dry) return false
          if (!dispatch) return true
          return moveTableRowCmd({
            from: rowIndex,
            to: rowIndex + 1,
            select: true,
            pos: rect.tableStart,
          })(state, dispatch)
        },

      moveTableColumnLeft:
        () =>
        ({ state, dispatch, view }: CommandProps) => {
          if (!(state.selection instanceof CellSelection)) return false
          const rect = selectedRect(state)
          const colIndex = rect.left
          if (colIndex <= 0) return false
          const dry = moveTableColumnCmd({
            from: colIndex,
            to: colIndex - 1,
            pos: rect.tableStart,
          })(view.state, undefined)
          if (!dry) return false
          if (!dispatch) return true
          return moveTableColumnCmd({
            from: colIndex,
            to: colIndex - 1,
            select: true,
            pos: rect.tableStart,
          })(state, dispatch)
        },

      moveTableColumnRight:
        () =>
        ({ state, dispatch, view }: CommandProps) => {
          if (!(state.selection instanceof CellSelection)) return false
          const rect = selectedRect(state)
          const colIndex = rect.left
          if (colIndex >= rect.map.width - 1) return false
          const dry = moveTableColumnCmd({
            from: colIndex,
            to: colIndex + 1,
            pos: rect.tableStart,
          })(view.state, undefined)
          if (!dry) return false
          if (!dispatch) return true
          return moveTableColumnCmd({
            from: colIndex,
            to: colIndex + 1,
            select: true,
            pos: rect.tableStart,
          })(state, dispatch)
        },

      // 表格末尾追加行 / 列 —— 不动当前 selection,直接挂在 table 末尾。
      // 跟 addRowAfter / addColumnAfter 的区别:那俩基于当前光标所在行/列
      // 「相对追加」,而 .table-add-row / .table-add-col 这两个 widget 视觉
      // 位置在表格边缘 + 标题就写「末尾追加」,所以必须无视 selection 永远
      // 挂在 map.height / map.width 这个 index,不会因为光标停在中间行/列而
      // 出现「+加一行却加在中间」的违和感。
      addRowToEnd:
        () =>
        ({ state, dispatch }: CommandProps) => {
          const table = findTable(state.selection.$from)
          if (!table) return false
          const map = TableMap.get(table.node)
          if (!dispatch) return true
          // addRow / addColumn 的 TableRect 入参实际只读 map / tableStart /
          // table,不需要 left/top/right/bottom —— 但类型上 Rect 必须填齐。
          addRow(
            state.tr,
            { map, tableStart: table.pos, table: table.node, left: 0, top: 0, right: 0, bottom: 0 },
            map.height,
          )
          return true
        },

      addColumnToEnd:
        () =>
        ({ state, dispatch }: CommandProps) => {
          const table = findTable(state.selection.$from)
          if (!table) return false
          const map = TableMap.get(table.node)
          if (!dispatch) return true
          addColumn(
            state.tr,
            { map, tableStart: table.pos, table: table.node, left: 0, top: 0, right: 0, bottom: 0 },
            map.width,
          )
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editor = (this as any).editor as import('@tiptap/core').Editor

    function decorationsFor(
      state: import('@tiptap/pm/state').EditorState,
    ): DecorationSet {
      const decos: Decoration[] = []
      const tableType = state.schema.nodes['table']
      if (!tableType) return DecorationSet.empty
      // 收集所有 table 节点,记录 (docPos, node) 对
      const tables: { pos: number; node: import('@tiptap/pm/model').Node }[] = []
      state.doc.descendants((node, pos) => {
        if (node.type === tableType) tables.push({ pos, node })
      })
      for (const { pos: tablePos, node: tableNode } of tables) {
        const map = TableMap.get(tableNode)
        const tableInnerEnd = tablePos + tableNode.nodeSize - 1

        // 底 / 右 + 按钮 + action popover 三个 widget 共用 innerEnd 槽位
        decos.push(
          Decoration.widget(
            tableInnerEnd,
            () =>
              makeAddRowButton(() => {
                // 末尾追加,无视当前 selection:视觉上 +add-row 就在表格底
                // 边、title 也写「末尾添加一行」,不能因为光标停在中间行就追
                // 加在中间 —— 那等于跟 action popover 的「在下方插入行」
                // (addRowAfter) 重复且语义错乱。
                editor.chain().focus().addRowToEnd().run()
              }),
            { side: 1, ignoreSelection: true, stopEvent: () => true },
          ),
        )
        decos.push(
          Decoration.widget(
            tableInnerEnd,
            () =>
              makeAddColButton(() => {
                editor.chain().focus().addColumnToEnd().run()
              }),
            { side: 1, ignoreSelection: true, stopEvent: () => true },
          ),
        )
        // action popover 容器(默认隐藏),dataset 记 tablePos 给 syncPopoverDom 用
        const popover = makeActionPopover()
        popover.dataset.tablePos = String(tablePos)
        decos.push(
          Decoration.widget(
            tableInnerEnd,
            () => popover,
            { side: 1, ignoreSelection: true, stopEvent: () => true },
          ),
        )

        // col hot zone × map.width — 必须发在 tableInnerEnd(落到 <tbody> 里、
        // 与 <tr> 同级),绝对定位,left/width 由 syncHotzonePositions 用首行
        // cell rect 算。绝不能发在首行 cellAfterEnd —— <div> 作为 <tr> 的直接
        // 子节点会生成匿名 table-cell 盒子,把表头行的单元格挤乱(实测表头行
        // 布局破损,body 行正常,就是这个原因)。
        for (let c = 0; c < map.width; c++) {
          decos.push(
            Decoration.widget(
              tableInnerEnd,
              () =>
                makeColHotzone(c, tablePos, () =>
                  activatePopover(editor.view, tablePos, 'col', c),
                ),
              { side: 1, ignoreSelection: true, stopEvent: () => true },
            ),
          )
        }

        // 每行一个 row hot zone:emit 在 row 末尾之后(side:1),与 tbody>tr 同级
        let rowOffset = 1
        for (let r = 0; r < map.height; r++) {
          const rowNode = tableNode.child(r)
          const rowPos = tablePos + rowOffset
          const rowAfterEnd = rowPos + rowNode.nodeSize
          decos.push(
            Decoration.widget(
              rowAfterEnd,
              () =>
                makeRowHotzone(r, tablePos, () =>
                  activatePopover(editor.view, tablePos, 'row', r),
                ),
              { side: 1, ignoreSelection: true, stopEvent: () => true },
            ),
          )
          rowOffset += rowNode.nodeSize
        }
      }
      return DecorationSet.create(state.doc, decos)
    }

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: (): PopoverState => ({ popover: null }),
          apply(tr, prev): PopoverState {
            const next = tr.getMeta(pluginKey) as PopoverState | undefined
            return next ?? prev
          },
        },
        props: {
          decorations(state) {
            return decorationsFor(state)
          },
        },
        view(view) {
          // 手柄的浮现完全交给 CSS(.tableWrapper:hover),不再用 JS 追踪
          // tr:hover —— 老实现在鼠标离开单元格时摘 is-hovered,导致手柄够不到。
          // 这里只保留:位置同步、popover DOM 同步、popover 打开时的
          // document 级「点外部 / Esc 关闭」监听。
          let docMousedown: ((e: MouseEvent) => void) | null = null
          let docKeydown: ((e: KeyboardEvent) => void) | null = null

          const syncDocListeners = () => {
            const cur = pluginKey.getState(view.state) as PopoverState | null
            const open = cur?.popover !== null && cur?.popover !== undefined
            if (open && !docMousedown) {
              docMousedown = (e: MouseEvent) => {
                const t = e.target as HTMLElement | null
                if (!t) return
                if (
                  t.closest('.table-row-hotzone, .table-col-hotzone, .table-action-popover')
                ) {
                  return
                }
                closePopover(view)
              }
              docKeydown = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                  closePopover(view)
                }
              }
              document.addEventListener('mousedown', docMousedown, true)
              document.addEventListener('keydown', docKeydown, true)
            } else if (!open && docMousedown) {
              document.removeEventListener('mousedown', docMousedown, true)
              if (docKeydown) document.removeEventListener('keydown', docKeydown, true)
              docMousedown = null
              docKeydown = null
            }
          }

          // 初次同步
          syncHotzonePositions(view)
          syncPopoverDom(view, editor)
          syncDocListeners()

          return {
            update(updatedView) {
              syncHotzonePositions(updatedView)
              syncPopoverDom(updatedView, editor)
              syncDocListeners()
            },
            destroy() {
              if (docMousedown) document.removeEventListener('mousedown', docMousedown, true)
              if (docKeydown) document.removeEventListener('keydown', docKeydown, true)
            },
          }
        },
      }),
    ]
  },
})

export default TableRowColumnActions