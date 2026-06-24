<script setup lang="ts">
import { computed, ref } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  node: { attrs: { language?: string | null } }
  editor: AnyEditor
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
}>()

const language = computed(() => {
  const l = props.node.attrs.language
  if (!l || l === 'plaintext' || l === 'plain') return ''
  return l
})

const copied = ref(false)
let copyTimer: number | null = null

async function copy(event: MouseEvent) {
  const btn = event.currentTarget as HTMLElement
  const wrapper = btn?.closest('.code-block') as HTMLElement | null
  if (!wrapper) return
  const code = wrapper.querySelector('code')
  const text = code?.textContent || ''
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch (err) {
    console.warn('[CodeBlockView] copy failed', err)
  }
}
</script>

<template>
  <NodeViewWrapper class="code-block">
    <div class="code-block-header">
      <span class="code-block-lang">{{ language || '纯文本' }}</span>
      <button
        type="button"
        class="code-block-copy"
        :class="{ copied }"
        @mousedown.stop
        @click="copy"
        :aria-label="copied ? '已复制' : '复制代码'"
        :title="copied ? '已复制' : '复制代码'"
      >
        <span class="material-symbols-outlined copy-icon" style="font-size:14px">
          {{ copied ? 'check' : 'content_copy' }}
        </span>
        <span>{{ copied ? '已复制' : '复制' }}</span>
      </button>
    </div>
    <pre><NodeViewContent as="code" :class="node.attrs.language ? `language-${node.attrs.language}` : null" /></pre>
  </NodeViewWrapper>
</template>

<style scoped>
.code-block {
  margin: 16px 0;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-code);
  border: 1px solid var(--border);
}
.code-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  user-select: none;
}
.code-block-lang {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #9CA3AF;
  font-family: var(--font-mono);
}
.code-block-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: #9CA3AF;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s, color 0.15s;
  font-family: inherit;
}
.code-block-copy:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #E5E7EB;
}
.code-block-copy.copied {
  color: #C3E88D;
}
.code-block :deep(pre) {
  margin: 0;
  padding: 16px;
  background: transparent;
  color: #B3BAC5;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  border-radius: 0;
}
.code-block :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
}
</style>