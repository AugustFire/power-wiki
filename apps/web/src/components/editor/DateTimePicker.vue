<script setup lang="ts">
/**
 * DateTimePicker(日期选择器)
 *
 * 用在三个地方:
 *  1. 工具栏「⏰ → 指定日期」下拉项
 *  2. slash 菜单「/date」选中后
 *  3. 点击已存在的 dateInline 节点(编辑)
 *
 * 交互:
 *  - 顶部 [动态 | 固定] 模式 tab
 *  - 「动态」:显示当前日期,确定 → mode='now'
 *  - 「固定」:日历选日期,确定 → mode='fixed'
 *
 * 发出事件:
 *  - @insert({ mode, date })
 *  - @cancel
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DateMode } from '@/editor/dateInlineExtension'

const props = defineProps<{
  initialMode?: DateMode
  initialDate?: Date
}>()

const emit = defineEmits<{
  insert: [{ mode: DateMode; date: Date }]
  cancel: []
}>()

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function fromYmd(s: string): Date {
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10))
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0)
}

// ─── 状态 ──────────────────────────────────────────────
const initDate = props.initialDate ?? new Date()
const initMode: DateMode = props.initialMode === 'fixed' ? 'fixed' : 'now'

const mode = ref<DateMode>(initMode)
const selectedDate = ref<Date>(new Date(initDate.getFullYear(), initDate.getMonth(), initDate.getDate()))
const viewYear = ref(selectedDate.value.getFullYear())
const viewMonth = ref(selectedDate.value.getMonth())

const dateInputRef = ref<HTMLInputElement | null>(null)

function setMode(m: DateMode) {
  mode.value = m
}

// ─── 日历网格计算 ──────────────────────────────────────
interface CalCell {
  day: number
  inMonth: boolean
  isToday: boolean
  isSelected: boolean
  date: Date
}

const calCells = computed<CalCell[]>(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1)
  const firstWeekday = (first.getDay() + 6) % 7
  const start = new Date(viewYear.value, viewMonth.value, 1 - firstWeekday)
  const cells: CalCell[] = []
  const todayYmd = ymd(new Date())
  const selYmd = ymd(selectedDate.value)
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const dYmd = ymd(d)
    cells.push({
      day: d.getDate(),
      inMonth: d.getMonth() === viewMonth.value,
      isToday: dYmd === todayYmd,
      isSelected: dYmd === selYmd,
      date: d,
    })
  }
  return cells
})

const monthLabel = computed(() => `${viewYear.value} 年 ${viewMonth.value + 1} 月`)

function prevMonth() {
  if (viewMonth.value === 0) {
    viewMonth.value = 11
    viewYear.value -= 1
  } else {
    viewMonth.value -= 1
  }
}

function nextMonth() {
  if (viewMonth.value === 11) {
    viewMonth.value = 0
    viewYear.value += 1
  } else {
    viewMonth.value += 1
  }
}

function pickCell(cell: CalCell) {
  selectedDate.value = new Date(cell.date)
  viewYear.value = selectedDate.value.getFullYear()
  viewMonth.value = selectedDate.value.getMonth()
  // 选了日期就自动切到固定模式
  mode.value = 'fixed'
}

function pickConfirm() {
  if (mode.value === 'now') {
    emit('insert', { mode: 'now', date: new Date() })
  } else {
    emit('insert', { mode: 'fixed', date: new Date(selectedDate.value) })
  }
}

function pickTodayDate() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  selectedDate.value = d
  viewYear.value = d.getFullYear()
  viewMonth.value = d.getMonth()
  mode.value = 'fixed'
}

function onCancel() {
  emit('cancel')
}

function onDateInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (!v) return
  selectedDate.value = fromYmd(v)
  viewYear.value = selectedDate.value.getFullYear()
  viewMonth.value = selectedDate.value.getMonth()
  mode.value = 'fixed'
}

// 键盘:Enter 确认;Esc 取消
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    pickConfirm()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="date-picker" @mousedown.stop>
    <!-- 模式 tab -->
    <div class="dp-mode-tabs">
      <button
        type="button"
        class="dp-mode-tab"
        :class="{ active: mode === 'now' }"
        @mousedown.prevent="setMode('now')"
      >
        <span class="material-symbols-outlined">schedule</span>
        <span>动态</span>
      </button>
      <button
        type="button"
        class="dp-mode-tab"
        :class="{ active: mode === 'fixed' }"
        @mousedown.prevent="setMode('fixed')"
      >
        <span class="material-symbols-outlined">event</span>
        <span>固定</span>
      </button>
    </div>

    <!-- 动态模式:简洁展示当前日期 -->
    <div v-if="mode === 'now'" class="dp-now">
      <div class="dp-now-label">当前日期</div>
      <div class="dp-now-value">
        {{
          new Date().toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long',
          })
        }}
      </div>
      <div class="dp-now-hint">每次打开页面/光标进入时自动更新到当天</div>
    </div>

    <!-- 固定模式:日历 -->
    <div v-else class="dp-cal-wrap">
      <div class="dp-cal-head">
        <button type="button" class="dp-nav" title="上一月" @mousedown.prevent="prevMonth">
          <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <div class="dp-month">{{ monthLabel }}</div>
        <button type="button" class="dp-nav" title="下一月" @mousedown.prevent="nextMonth">
          <span class="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      <div class="dp-weekdays">
        <div v-for="w in WEEKDAYS" :key="w" class="dp-weekday">{{ w }}</div>
      </div>
      <div class="dp-grid">
        <button
          v-for="(c, i) in calCells"
          :key="i"
          type="button"
          class="dp-cell"
          :class="{
            'is-other': !c.inMonth,
            'is-today': c.isToday,
            'is-selected': c.isSelected,
          }"
          @mousedown.prevent="pickCell(c)"
        >
          {{ c.day }}
        </button>
      </div>
      <div class="dp-quick">
        <button type="button" class="dp-quick-btn" @mousedown.prevent="pickTodayDate">
          <span class="material-symbols-outlined">today</span>
          <span>今天</span>
        </button>
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="dp-actions">
      <button type="button" class="dp-btn dp-btn-ghost" @mousedown.prevent="onCancel">取消</button>
      <button type="button" class="dp-btn dp-btn-primary" @mousedown.prevent="pickConfirm">
        确定
      </button>
    </div>

    <!-- 隐藏的 date input 提供 a11y 入口 -->
    <input
      ref="dateInputRef"
      type="date"
      class="dp-native-date"
      :value="ymd(selectedDate)"
      tabindex="-1"
      aria-hidden="true"
      @change="onDateInput"
    />
  </div>
</template>

<style scoped>
.date-picker {
  display: flex;
  flex-direction: column;
  width: 280px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 12px;
  gap: 10px;
  font-family: inherit;
  color: var(--text-1);
  user-select: none;
}

.dp-mode-tabs {
  display: flex;
  background: var(--bg-subtle);
  border-radius: var(--radius-md);
  padding: 2px;
  gap: 2px;
}
.dp-mode-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  cursor: pointer;
  font-family: inherit;
}
.dp-mode-tab:hover { color: var(--text-1); }
.dp-mode-tab.active {
  background: var(--bg);
  color: var(--accent);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.dp-mode-tab .material-symbols-outlined { font-size: 14px; }

.dp-now {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 4px;
}
.dp-now-label {
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.dp-now-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.4;
}
.dp-now-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
  margin-top: 4px;
}

.dp-cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 0 2px;
}
.dp-month {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.dp-nav {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.dp-nav:hover { background: var(--bg-subtle); color: var(--text-1); }
.dp-nav .material-symbols-outlined { font-size: 16px; }

.dp-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
  padding: 2px 0;
}
.dp-weekday { padding: 2px 0; }

.dp-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}
.dp-cell {
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-1);
  cursor: pointer;
  padding: 0;
  font-family: inherit;
}
.dp-cell:hover { background: var(--bg-subtle); }
.dp-cell.is-other { color: var(--text-3); }
.dp-cell.is-today {
  border: 1px solid var(--accent);
}
.dp-cell.is-selected {
  background: var(--accent);
  color: white;
  font-weight: 600;
}
.dp-cell.is-selected.is-today { border-color: transparent; }

.dp-quick {
  display: flex;
  justify-content: flex-start;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}
.dp-quick-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  font-family: inherit;
}
.dp-quick-btn:hover { background: var(--bg-subtle); color: var(--text-1); }
.dp-quick-btn .material-symbols-outlined { font-size: 14px; }

.dp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.dp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-1);
  cursor: pointer;
  font-family: inherit;
}
.dp-btn:hover { background: var(--bg-subtle); }
.dp-btn-primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
  font-weight: 600;
}
.dp-btn-primary:hover { background: var(--accent-hover); }
.dp-btn-ghost {
  background: transparent;
  color: var(--text-2);
}
.dp-btn-ghost:hover { background: var(--bg-subtle); color: var(--text-1); }

.dp-native-date {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
</style>

