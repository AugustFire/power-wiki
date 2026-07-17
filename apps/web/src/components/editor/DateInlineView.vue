<script setup lang="ts">
/**
 * DateInline NodeView —— 只渲染固定日期。
 *
 * 节点可编辑:点击节点弹 DateTimePicker 让用户改日期。
 * 图标(.di-icon 前缀)交给 CSS ::before 统一处理,跟 read view 一致。
 *
 * 历史:本节点曾有 mode='now'(每 60s 重算 "今天"),已删除 —— 见
 * `dateInlineExtension.ts` 顶部注释。NodeView 不再持有 timer / mode prop。
 */
import { computed, ref } from 'vue'
import { NodeViewWrapper } from '@tiptap/vue-3'
import { formatYmd } from '@/lib/dateFormat'
import type { EditorNodeViewProps } from '@/editor/nodeViewProps'
import DateTimePicker from './DateTimePicker.vue'

const props = defineProps<EditorNodeViewProps<{ iso?: string }>>()

const iso = computed<string>(() => props.node.attrs.iso || '')

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

function onEditorUpdate(payload: { date: Date }) {
  props.updateAttributes({
    iso: payload.date.toISOString(),
  })
  closeEditor()
  const pos = props.getPos?.()
  if (typeof pos === 'number' && props.editor) {
    props.editor.commands.setTextSelection(pos + 1)
  }
}

// ─── 显示文案格式化(共享函数) ────────────────────
const displayText = computed<string>(() => formatYmd(iso.value))
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="date-inline"
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