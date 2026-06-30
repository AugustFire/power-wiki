<script setup lang="ts">
/**
 * Mention NodeView — Stage 6.
 *
 * VueNodeViewRenderer wraps this for the `mention` inline atom node. The
 * `.mention-chip` class is styled globally in apps/web/src/styles/components.css
 * so editor live view, saved-HTML read view, and comment text all look
 * identical. The `data-mention` attribute is intentionally absent here so the
 * CSS hits the default (real-mention) variant, not the dim fallback used by
 * CommentItem for unverified `@xxx` text.
 */
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

const props = defineProps(nodeViewProps)

const label = computed(() => (props.node.attrs.label as string) || '')
const userId = computed(() => (props.node.attrs.userId as string) || '')
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="mention-chip"
    :data-user-id="userId"
    :data-label="label"
    :data-mention="1"
    :title="userId"
    contenteditable="false"
  >@{{ label }}</NodeViewWrapper>
</template>

<style scoped>
/* Empty — global .mention-chip lives in components.css so the same rule
 * also serves ReadView's v-html content and CommentItem's wrapped text. */
</style>
