<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'
import { CALLOUT_ICON_MAP } from '@/editor/calloutExtension'
import type { EditorNodeViewProps } from '@/editor/nodeViewProps'

type CalloutVariant = 'info' | 'success' | 'warning' | 'danger'

const props = defineProps<EditorNodeViewProps<{ variant?: CalloutVariant }>>()

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
      <span class="material-symbols-outlined icon-md">close</span>
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
  border-radius: var(--radius-md);
  cursor: pointer;
  /* 默认半透,鼠标进入或键盘聚焦时完全显出 —
     修复 P2-3 评价里"键盘用户无法操作"的可达性问题 */
  opacity: 0.35;
  transition: opacity var(--duration-fast), background-color var(--duration-fast), color var(--duration-fast);
}
.callout:hover .callout-remove,
.callout:focus-within .callout-remove,
.callout-remove:hover,
.callout-remove:focus-visible {
  opacity: 1;
}
.callout-remove:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--text-1);
}
</style>



