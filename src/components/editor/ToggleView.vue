<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  node: { attrs: { open?: boolean } }
  editor: AnyEditor
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
}>()

const isOpen = computed(() => props.node.attrs.open !== false)

function toggle(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  // contenteditable 区域里直接改 attr 就够了,ProseMirror 会重新渲染 NodeView
  props.updateAttributes({ open: !isOpen.value })
}
</script>

<template>
  <NodeViewWrapper
    class="toggle-wrapper"
    :data-open="String(isOpen)"
  >
    <button
      type="button"
      class="toggle-summary"
      contenteditable="false"
      :aria-expanded="isOpen"
      @click="toggle"
      @mousedown.stop
    >
      <span class="toggle-chev material-symbols-outlined">
        {{ isOpen ? 'expand_more' : 'chevron_right' }}
      </span>
    </button>
    <NodeViewContent class="toggle-content" />
  </NodeViewWrapper>
</template>

<style scoped>
.toggle-wrapper {
  margin: 8px 0;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  transition: background-color 0.15s ease;
}
.toggle-wrapper:hover {
  background: var(--bg-subtle);
}

.toggle-summary {
  display: flex;
  align-items: center;
  width: 100%;
  height: 36px;
  padding: 0 8px 0 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: inherit;
  border-radius: var(--radius);
  user-select: none;
}
.toggle-summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.toggle-chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 18px;
  color: var(--text-2);
  transition: transform 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
}
.toggle-summary:hover .toggle-chev {
  color: var(--accent);
}

.toggle-content {
  padding: 4px 12px 12px 32px;
  min-height: 8px;
}

/* 关闭态:内容隐藏,但保留高度让 chevron 行可见 */
.toggle-wrapper[data-open="false"] .toggle-content {
  display: none;
}

/* 选中态视觉:ProseMirror 选中 toggle 时给 summary 一道强调色 */
.toggle-wrapper.ProseMirror-selectednode .toggle-summary {
  background: var(--accent-soft);
}
</style>