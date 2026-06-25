<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import type { PageNode } from '@/types/page'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  editor: AnyEditor
}>()

interface SlashItem {
  id: string
  label: string
  description: string
  icon: string
  /** builtin: 选中后立即执行 run() */
  /** needsPicker: 选中后弹 picker(在 SlashMenu 内部渲染),run() 负责 hideMenu + 启 picker */
  kind?: 'builtin' | 'needsPicker'
  run: (editor: AnyEditor) => void
}

// 注意:严格不包含图片/链接选项(用户硬约束)
const items: SlashItem[] = [
  {
    id: 'h1',
    label: '一级标题',
    description: '大号标题',
    icon: 'format_h1',
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    label: '二级标题',
    description: '中等标题',
    icon: 'format_h2',
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    label: '三级标题',
    description: '小号标题',
    icon: 'format_h3',
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'ul',
    label: '无序列表',
    description: '• 圆点列表',
    icon: 'format_list_bulleted',
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ol',
    label: '有序列表',
    description: '1. 编号列表',
    icon: 'format_list_numbered',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task',
    label: '任务列表',
    description: '☑ 复选框列表',
    icon: 'checklist',
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'table',
    label: '表格',
    description: '3×3 网格,首行表头',
    icon: 'table',
    run: (e) =>
      e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'code',
    label: '代码块',
    description: '等宽字体块',
    icon: 'code',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'quote',
    label: '引用块',
    description: '左侧蓝条引用',
    icon: 'format_quote',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'divider',
    label: '分隔线',
    description: '水平线',
    icon: 'horizontal_rule',
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'callout',
    label: '提示框',
    description: '带颜色侧条的信息块',
    icon: 'lightbulb',
    run: (e) => e.chain().focus().toggleCallout('info').run(),
  },
  {
    id: 'toggle',
    label: '折叠块',
    description: '可点击展开/收起的内容',
    icon: 'expand_more',
    run: (e) => e.chain().focus().setToggle().run(),
  },
  {
    id: 'pageRef',
    label: '页面引用',
    description: '插入一个可跳转的页面卡片',
    icon: 'description',
    kind: 'needsPicker',
    run: () => {
      // needsPicker 不在 run 里执行 insert;由 onSelectIndex 后续 openPagePicker
    },
  },
]

const open = ref(false)
const pos = ref({ x: 0, y: 0 })
const filterText = ref('')
const activeIndex = ref(0)

const filtered = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (it) => it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q)
  )
})

// 过滤结果变化时,把高亮重置到第一项
watch(filtered, () => {
  activeIndex.value = 0
  nextTick(scrollActiveIntoView)
})

function getCursorXY(): { x: number; y: number } {
  if (!props.editor) return { x: 0, y: 0 }
  const { from } = props.editor.state.selection
  const coords = props.editor.view.coordsAtPos(from)
  // 估算菜单高度(每个项约 44px,12 项 ≈ 528px)
  const menuH = 540
  const menuW = 240
  const vw = window.innerWidth
  const vh = window.innerHeight
  // 默认在光标下方;若超出视口底则放到上方
  let y = coords.bottom + 4
  if (y + menuH > vh) y = coords.top - menuH - 4
  // 若还超出,则贴底
  if (y < 0) y = vh - menuH
  // 横向裁剪
  let x = coords.left
  if (x + menuW > vw) x = vw - menuW - 8
  if (x < 8) x = 8
  return { x, y }
}

function showMenu() {
  if (!props.editor) return
  const p = getCursorXY()
  pos.value = p
  filterText.value = ''
  activeIndex.value = 0
  open.value = true
}

function hideMenu() {
  open.value = false
  filterText.value = ''
  activeIndex.value = 0
  closePagePicker()
}

// 检测编辑器文本中最后一个 "/" 触发菜单
function checkForSlash() {
  if (!props.editor) return
  const { state } = props.editor
  const { $from } = state.selection
  // 当前 paragraph 的文本
  const text = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n')
  // 查找行尾最近的 "/"
  const slashIdx = text.lastIndexOf('/')
  if (slashIdx < 0) {
    hideMenu()
    return
  }
  // "/" 之前必须是空白或行首(避免误判)
  if (slashIdx > 0 && !/\s/.test(text[slashIdx - 1])) {
    hideMenu()
    return
  }
  // 提取 "/" 之后的查询词
  const next = text.slice(slashIdx + 1)
  if (filterText.value !== next) {
    filterText.value = next
  }
  if (!open.value) showMenu()
}

// 推迟一帧再检测 — input 事件触发时,ProseMirror 的 selection 状态可能还没
// 同步到刚输入的字符;rAF 后再读,保证读到的是稳定的最终态。
function checkForSlashDeferred() {
  requestAnimationFrame(checkForSlash)
}

function onSelectIndex(idx: number) {
  const item = filtered.value[idx]
  if (!item || !props.editor) return
  // 先删除斜杠(及之后的查询文本)
  const { state } = props.editor
  const { $from } = state.selection
  const text = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n')
  const slashIdx = text.lastIndexOf('/')
  if (slashIdx < 0) return
  // 删除从 (cursor - (text.length - slashIdx)) 到 cursor 的字符
  const from = $from.pos - (text.length - slashIdx)
  const to = $from.pos
  props.editor
    .chain()
    .focus()
    .deleteRange({ from, to })
    .run()

  if (item.kind === 'needsPicker' && item.id === 'pageRef') {
    // 不调用 run()(它本来也是 no-op);直接打开 picker
    openPagePicker()
    return
  }

  item.run(props.editor)
  hideMenu()
}

function onSelect(item: SlashItem) {
  const idx = filtered.value.findIndex((it) => it.id === item.id)
  if (idx >= 0) onSelectIndex(idx)
}

function scrollActiveIntoView() {
  const el = document.querySelector('.slash-menu .slash-item.active')
  if (el && 'scrollIntoView' in el) {
    (el as HTMLElement).scrollIntoView({ block: 'nearest' })
  }
}

function moveActive(delta: number) {
  const n = filtered.value.length
  if (n === 0) return
  activeIndex.value = (activeIndex.value + delta + n) % n
  nextTick(scrollActiveIntoView)
}

// 键盘事件分发:菜单打开时,↑↓/Enter/Esc 在 editor keydown 阶段拦截
// picker 打开时,同样的键位驱动 picker;否则驱动 slash 列表
function onEditorKey(e: KeyboardEvent) {
  if (pickerOpen.value) {
    onPickerKey(e)
    return
  }
  if (!open.value) return
  // 仅当没按住修饰键
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveActive(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveActive(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    onSelectIndex(activeIndex.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    hideMenu()
  }
}

let detach: (() => void) | null = null

function attach() {
  if (!props.editor) return
  const el = props.editor.view.dom as HTMLElement
  const onInput = (_e: Event) => checkForSlashDeferred()
  const onKeyUp = (e: KeyboardEvent) => {
    // Escape 的 keyup 不要重新触发 slash 检测,否则刚被 keydown 关掉的菜单会立即被 keyup 重新打开
    if (e.key === 'Escape') return
    checkForSlashDeferred()
  }
  const onKey = (e: KeyboardEvent) => onEditorKey(e)
  el.addEventListener('input', onInput)
  el.addEventListener('keyup', onKeyUp)
  el.addEventListener('keydown', onKey, true) // capture:优先于 Tiptap 内部
  // 点击外部关闭
  const outside = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.slash-menu')) hideMenu()
  }
  document.addEventListener('mousedown', outside)
  detach = () => {
    el.removeEventListener('input', onInput)
    el.removeEventListener('keyup', onKeyUp)
    el.removeEventListener('keydown', onKey, true)
    document.removeEventListener('mousedown', outside)
  }
}

watch(
  () => props.editor,
  (val) => {
    if (detach) {
      detach()
      detach = null
    }
    if (val) attach()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (detach) detach()
})

// ============================================================
//  页面引用 Picker
// ============================================================
const pagesStore = usePagesStore()
const pickerOpen = ref(false)
const pickerQuery = ref('')
const pickerIndex = ref(0)
const pickerInputEl = ref<HTMLInputElement | null>(null)

const pickerResults = computed<PageNode[]>(() => {
  const q = pickerQuery.value.trim().toLowerCase()
  const all = pagesStore.pages
  const list = q
    ? all.filter((p) => p.title.toLowerCase().includes(q))
    : all.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  return list.slice(0, 20)
})

watch(pickerResults, () => {
  pickerIndex.value = 0
  nextTick(scrollPickerActiveIntoView)
})

// picker 打开后,把焦点交给搜索框,这样用户可以直接输入查询
watch(pickerOpen, async (val) => {
  if (val) {
    await nextTick()
    pickerInputEl.value?.focus()
  }
})

function openPagePicker() {
  pickerOpen.value = true
  pickerQuery.value = ''
  pickerIndex.value = 0
}

function closePagePicker() {
  pickerOpen.value = false
  pickerQuery.value = ''
  pickerIndex.value = 0
}

function onPickPage(p: PageNode) {
  if (!props.editor) return
  props.editor
    .chain()
    .focus()
    .insertContent({
      type: 'pageRef',
      attrs: { pageId: p.id, title: p.title },
    })
    .run()
  hideMenu()
}

function scrollPickerActiveIntoView() {
  const el = document.querySelector('.slash-menu .pp-item.active')
  if (el && 'scrollIntoView' in el) {
    (el as HTMLElement).scrollIntoView({ block: 'nearest' })
  }
}

function pickerMove(delta: number) {
  const n = pickerResults.value.length
  if (n === 0) return
  pickerIndex.value = (pickerIndex.value + delta + n) % n
  nextTick(scrollPickerActiveIntoView)
}

// picker 打开时拦截 editor 的键盘事件
function onPickerKey(e: KeyboardEvent) {
  if (!pickerOpen.value) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    pickerMove(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    pickerMove(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const p = pickerResults.value[pickerIndex.value]
    if (p) onPickPage(p)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    hideMenu()
  }
}
</script>

<template>
  <div
    v-if="open && filtered.length > 0"
    class="slash-menu"
    :style="{ top: pos.y + 'px', left: pos.x + 'px' }"
  >
    <!-- Picker 模式:用户在 /页面引用 后看到的页面选择器 -->
    <div v-if="pickerOpen" class="slash-picker">
      <div class="slash-title">
        <span>选择要引用的页面</span>
        <span class="slash-hint">↑↓ 选择 · Enter 插入 · Esc 取消</span>
      </div>
      <div class="pp-input-row">
        <span class="material-symbols-outlined pp-search-icon">search</span>
        <input
          ref="pickerInputEl"
          v-model="pickerQuery"
          class="pp-input"
          type="text"
          placeholder="按标题搜索…"
          @keydown.stop
        />
      </div>
      <div class="pp-list">
        <button
          v-for="(p, idx) in pickerResults"
          :key="p.id"
          class="pp-item"
          :class="{ active: idx === pickerIndex }"
          @mousedown.prevent="onPickPage(p)"
          @mousemove="pickerIndex = idx"
        >
          <span class="material-symbols-outlined pp-icon">description</span>
          <span class="pp-title">{{ p.title }}</span>
        </button>
        <div v-if="pickerResults.length === 0" class="pp-empty">没有匹配页面</div>
      </div>
    </div>

    <!-- 正常模式:slash item 列表 -->
    <template v-else>
      <div class="slash-title">
        <span>插入块</span>
        <span class="slash-hint">↑↓ 选择 · Enter 应用 · Esc 取消</span>
      </div>
      <button
        v-for="(item, idx) in filtered"
        :key="item.id"
        class="slash-item"
        :class="{ active: idx === activeIndex }"
        @mousedown.prevent="onSelect(item)"
        @mousemove="activeIndex = idx"
      >
        <span class="material-symbols-outlined icon">{{ item.icon }}</span>
        <div class="text">
          <div class="label">{{ item.label }}</div>
          <div class="desc">{{ item.description }}</div>
        </div>
      </button>
      <div v-if="filtered.length === 0" class="slash-empty">没有匹配的块</div>
    </template>
  </div>
</template>

<style scoped>
.slash-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  font-weight: 600;
  padding: 6px 10px 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2px;
}
.slash-hint {
  font-size: 10px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-3);
  opacity: 0.75;
}
.text { display: flex; flex-direction: column; min-width: 0; }
.text .label { font-weight: 500; color: var(--text-1); }
.text .desc { font-size: 12px; color: var(--text-3); }
.slash-empty {
  padding: 12px;
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
}

/* ─── Picker 子样式 ─────────────────────────────────────── */
.slash-picker {
  display: flex;
  flex-direction: column;
}
.pp-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.pp-search-icon {
  font-size: 16px;
  color: var(--text-3);
}
.pp-input {
  flex: 1;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-1);
  background: transparent;
}
.pp-input::placeholder { color: var(--text-3); }

.pp-list {
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}
.pp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: var(--text-1);
  font-size: 13px;
}
.pp-item:hover { background: var(--bg-subtle); }
.pp-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.pp-icon {
  font-size: 16px;
  color: var(--text-3);
  flex-shrink: 0;
}
.pp-item.active .pp-icon { color: var(--accent); }
.pp-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
}
</style>
