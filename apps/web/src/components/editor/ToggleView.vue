<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'
import type { EditorNodeViewProps } from '@/editor/nodeViewProps'

const props = defineProps<EditorNodeViewProps<{ open?: boolean; title?: string }>>()

const isOpen = computed(() => props.node.attrs.open !== false)
const title = computed(() => props.node.attrs.title ?? '')
const titleInputRef = ref<HTMLInputElement | null>(null)

function toggle(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  props.updateAttributes({ open: !isOpen.value })
}

function onTitleInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (v !== props.node.attrs.title) {
    props.updateAttributes({ title: v })
  }
}

// Enter 把光标送到 content 首块;Escape 失焦
function onTitleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    const ed = props.editor
    const pos = props.getPos()
    if (ed && typeof pos === 'number') {
      ed.commands.focus(pos + 1)
    }
  } else if (e.key === 'Escape') {
    ;(e.target as HTMLInputElement).blur()
  }
}

/**
 * 删除整个折叠块。同 CodeBlockView.removeBlock —— Tiptap 没有标准的
 * "删掉这个块"命令,所以走 selectNode + deleteSelection 路径。
 * 折叠块的 nodeSize 取决于其内容,直接 props.node.nodeSize 拿。
 */
function removeBlock() {
  const pos = props.getPos()
  if (pos == null) return
  const e = props.editor
  if (!e) return
  const nodeSize = (props.node as { nodeSize?: number }).nodeSize ?? e.state.doc.nodeAt(pos)?.nodeSize ?? 0
  e.chain()
    .focus()
    .setNodeSelection(pos)
    .setTextSelection({ from: pos, to: pos + nodeSize })
    .deleteSelection()
    .run()
}

// 外部更新 title(如撤销重做)时,同步到 input — 仅当 input 没在聚焦,避免抢光标
watch(title, (val) => {
  const el = titleInputRef.value
  if (el && document.activeElement !== el && el.value !== val) {
    el.value = val
  }
})
</script>

<template>
  <NodeViewWrapper
    class="toggle-wrapper"
    :data-open="String(isOpen)"
  >
    <div class="toggle-summary">
      <button
        type="button"
        class="toggle-chev-btn"
        contenteditable="false"
        :aria-expanded="isOpen"
        :aria-label="isOpen ? '收起' : '展开'"
        @click="toggle"
        @mousedown.stop
      >
        <span class="toggle-chev material-symbols-outlined">
          {{ isOpen ? 'expand_more' : 'chevron_right' }}
        </span>
      </button>
      <input
        ref="titleInputRef"
        class="toggle-title-input"
        :value="title"
        type="text"
        placeholder="点击编辑标题…"
        @input="onTitleInput"
        @keydown="onTitleKeydown"
        @mousedown.stop
      />
      <button
        type="button"
        class="toggle-delete-btn"
        contenteditable="false"
        aria-label="删除折叠块"
        title="删除折叠块"
        @click="removeBlock"
        @mousedown.stop
      >
        <span class="material-symbols-outlined">delete</span>
      </button>
    </div>
    <NodeViewContent class="toggle-content" />
  </NodeViewWrapper>
</template>

<style scoped>
/* 容器边框/间距由 components.css 统一管,这里只留兜底 */
.toggle-wrapper {
  margin: 8px 0;
}
.toggle-delete-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity var(--duration-fast), background-color var(--duration-fast), color var(--duration-fast);
}
.toggle-delete-btn .material-symbols-outlined {
  font-size: 14px;
}
.toggle-wrapper:hover .toggle-delete-btn { opacity: 1; }
.toggle-delete-btn:hover {
  background: rgba(255, 86, 48, 0.12);
  color: #FF5630;
}
.toggle-delete-btn:focus-visible { opacity: 1; outline: none; }
</style>

