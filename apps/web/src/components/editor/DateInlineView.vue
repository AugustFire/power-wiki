<script setup lang="ts">
/**
 * DateInline NodeView
 *
 * - mode='now':  每分钟重算显示文案("今天 14:32" / "2026/06/25 14:32")
 * - mode='fixed': 显示 attr.iso 对应的固定日期
 *
 * 节点可编辑:点击节点弹 DateTimePicker 让用户改日期/模式。
 * 图标(.di-icon 前缀)交给 CSS ::before 统一处理,跟 read view 一致。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper } from '@tiptap/vue-3'
import type { DateMode } from '@/editor/dateInlineExtension'
import { formatLiveDate } from '@/lib/dateFormat'
import type { EditorNodeViewProps } from '@/editor/nodeViewProps'
import DateTimePicker from './DateTimePicker.vue'

const props = defineProps<EditorNodeViewProps<{ mode?: DateMode; iso?: string }>>()

const mode = computed<DateMode>(() => (props.node.attrs.mode === 'fixed' ? 'fixed' : 'now'))
const iso = computed<string>(() => props.node.attrs.iso || '')

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

function startTimer() {
  if (timer) return
  timer = setInterval(() => {
    now.value = Date.now()
  }, 60_000)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

onMounted(() => {
  if (mode.value === 'now') startTimer()
})

// 节点 mode 在编辑器内可能被 updateAttributes 修改(fixed ↔ now 切换);
// 切换到 now 时启动定时器,切到 fixed 时停掉,避免显示冻结。
watch(mode, (m) => {
  if (m === 'now') startTimer()
  else stopTimer()
})

onBeforeUnmount(stopTimer)

// ─── 节点编辑:点击节点 → 弹 DateTimePicker ─────────────────
const editing = ref(false)
const popoverPos = ref<{ x: number; y: number } | null>(null)

function openEditor(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  const pos = props.getPos?.()
  if (typeof pos === 'number' && props.editor) {
    props.editor.commands.setNodeSelection(pos)
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  popoverPos.value = { x: rect.left, y: rect.bottom + 4 }
  editing.value = true
}

function closeEditor() {
  editing.value = false
  popoverPos.value = null
}

function onEditorUpdate(payload: { mode: DateMode; date: Date }) {
  props.updateAttributes({
    mode: payload.mode,
    iso: payload.date.toISOString(),
  })
  closeEditor()
  const pos = props.getPos?.()
  if (typeof pos === 'number' && props.editor) {
    props.editor.commands.setTextSelection(pos + 1)
  }
}

// ─── 显示文案格式化(共享函数) ────────────────────
const displayText = computed<string>(() =>
  formatLiveDate({ mode: mode.value, iso: iso.value }, new Date(now.value)),
)
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="date-inline"
    :class="mode"
    :data-date-mode="mode"
    :data-date="iso"
    :datetime="iso"
    contenteditable="false"
  >
    <span class="di-pill" @click="openEditor" @mousedown.stop>
      <span class="di-text">{{ displayText }}</span>
    </span>
    <div
      v-if="editing && popoverPos"
      class="di-popover"
      :style="{ top: popoverPos.y + 'px', left: popoverPos.x + 'px' }"
      @mousedown.stop
    >
      <DateTimePicker
        :initial-mode="mode"
        :initial-date="iso ? new Date(iso) : new Date()"
        @insert="onEditorUpdate"
        @cancel="closeEditor"
      />
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.di-pill {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.di-text {
  /* 视觉全部继承 .date-inline 的 ::before 图标 + pill 样式 */
  pointer-events: none;
}
.di-popover {
  position: fixed;
  z-index: 200;
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
}
</style>

