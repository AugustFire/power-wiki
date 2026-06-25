<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  node: { attrs: { open?: boolean; title?: string } }
  editor: AnyEditor
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
}>()

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
    </div>
    <NodeViewContent class="toggle-content" />
  </NodeViewWrapper>
</template>

<style scoped>
/* 容器边框/间距由 components.css 统一管,这里只留兜底 */
.toggle-wrapper {
  margin: 8px 0;
}
</style>
