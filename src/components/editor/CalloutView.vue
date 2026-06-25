<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'
import { CALLOUT_ICON_MAP } from '@/editor/calloutExtension'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

type CalloutVariant = 'info' | 'success' | 'warning' | 'danger'

const props = defineProps<{
  node: { attrs: { variant?: CalloutVariant } }
  editor: AnyEditor
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
}>()

const variant = computed<CalloutVariant>(() => props.node.attrs.variant || 'info')
const iconName = computed(() => CALLOUT_ICON_MAP[variant.value] || 'info')

function remove() {
  const ed = props.editor
  if (!ed) return
  ed.chain().focus().unsetCallout().run()
}
</script>

<template>
  <NodeViewWrapper class="callout" :class="variant" :data-variant="variant">
    <span class="material-symbols-outlined icon" contenteditable="false">{{ iconName }}</span>
    <NodeViewContent class="callout-body" />
    <button
      type="button"
      class="callout-remove"
      contenteditable="false"
      title="删除提示框"
      aria-label="删除提示框"
      @click="remove"
      @mousedown.stop
    >
      <span class="material-symbols-outlined" style="font-size:16px">close</span>
    </button>
  </NodeViewWrapper>
</template>

<style scoped>
.callout {
  position: relative;
}
.callout-remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background-color 0.12s, color 0.12s;
}
.callout:hover .callout-remove,
.callout-remove:focus-visible {
  opacity: 1;
}
.callout-remove:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--text-1);
}
</style>
