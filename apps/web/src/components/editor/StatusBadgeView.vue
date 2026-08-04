<script setup lang="ts">
/**
 * StatusBadge NodeView —— 状态徽章胶囊 + 双击编辑弹窗。
 *
 * 编辑走弹窗而不是节点内 contenteditable:inline atom 内嵌可编辑区是
 * Tiptap 老坑(光标在节点边界跳、Backspace 语义混乱)。弹窗形态跟
 * DateInlineView 的 DateTimePicker popover 完全一致,用户已经熟悉。
 *
 * 弹窗里两件事都能做:改文案 + 换配色 —— 状态徽章天然会变
 * (「进行中」→「已完成」),只能删了重插的话这个功能没法用。
 */
import { nextTick, ref } from 'vue'
import { NodeViewWrapper } from '@tiptap/vue-3'
import type { EditorNodeViewProps } from '@/editor/nodeViewProps'
import { STATUS_PRESETS, type StatusColor } from '@/editor/statusExtension'

const props = defineProps<EditorNodeViewProps<{ text?: string; color?: StatusColor }>>()

const editing = ref(false)
const popoverPos = ref<{ x: number; y: number } | null>(null)
const draftText = ref('')
const draftColor = ref<StatusColor>('gray')
const inputRef = ref<HTMLInputElement | null>(null)

function openEditor(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  draftText.value = props.node.attrs.text ?? ''
  draftColor.value = props.node.attrs.color ?? 'gray'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  popoverPos.value = { x: rect.left, y: rect.bottom + 4 }
  editing.value = true
  void nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

function closeEditor() {
  editing.value = false
  popoverPos.value = null
}

function commit() {
  // 空文案会渲染成一个看不见的空胶囊(用户以为删掉了但节点还在),
  // 回退到原文案而不是存空串。
  const text = draftText.value.trim()
  props.updateAttributes({ text: text || props.node.attrs.text || '', color: draftColor.value })
  closeEditor()
}

/** 点色板直接落盘 —— 换配色是最高频操作,不该再点一次「确定」。
 *  文案改动仍要 Enter / 「确定」,避免每敲一个字符都写一次 attrs。 */
function pickColor(c: StatusColor) {
  draftColor.value = c
  props.updateAttributes({ color: c })
}
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="status-badge"
    :data-status-color="props.node.attrs.color ?? 'gray'"
    contenteditable="false"
  >
    <span class="sb-text" @dblclick="openEditor" @mousedown.stop>{{ props.node.attrs.text }}</span>
    <div
      v-if="editing && popoverPos"
      class="sb-popover"
      :style="{ top: popoverPos.y + 'px', left: popoverPos.x + 'px' }"
      @mousedown.stop
    >
      <input
        ref="inputRef"
        v-model="draftText"
        class="sb-input"
        type="text"
        maxlength="24"
        placeholder="状态文字"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="closeEditor"
      />
      <div class="sb-swatches">
        <button
          v-for="p in STATUS_PRESETS"
          :key="p.color"
          type="button"
          class="sb-swatch"
          :class="{ active: draftColor === p.color }"
          :data-status-color="p.color"
          :title="p.label"
          @click="pickColor(p.color)"
        />
      </div>
      <div class="sb-actions">
        <button type="button" class="btn ghost" @click="closeEditor">取消</button>
        <button type="button" class="btn primary" @click="commit">确定</button>
      </div>
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.sb-text {
  cursor: pointer;
  user-select: none;
}
.sb-popover {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  min-width: 200px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
}
.sb-input {
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.sb-input:focus {
  border-color: var(--accent);
}
.sb-swatches {
  display: flex;
  gap: 6px;
}
.sb-swatch {
  width: 26px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.sb-swatch.active {
  border-color: var(--text-1);
  box-shadow: 0 0 0 1px var(--text-1);
}
.sb-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.sb-actions .btn {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
</style>
