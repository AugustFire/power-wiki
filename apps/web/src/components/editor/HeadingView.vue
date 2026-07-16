<script setup lang="ts">
import { computed, ref } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'
import type { EditorNodeViewProps } from '@/editor/nodeViewProps'

const props = defineProps<EditorNodeViewProps<{ level?: number }>>()

const level = computed(() => props.node.attrs.level ?? 2)

function slugify(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[^\p{L}\p{N}\- ]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40)
  return cleaned || fallback
}

const headingId = computed(() => {
  const pos = props.getPos()
  // slug 可能因为 CJK 文本相同(两个 `<h2>引言</h2>`)而重复,
  // 用节点位置做兜底,保证 id 唯一。
  // 与阅读视图 headingAnchors.ts 的去重策略对齐。h- 前缀让 URL hash 与
  // #comment-xxx 区分,TocPanel scrollTo / ReadView route.hash watcher 都靠这个。
  return `h-${slugify(props.node.textContent || '', 'heading')}-${pos ?? 0}`
})

const copied = ref(false)
let copyTimer: number | null = null

async function copyLink(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  const url = `${location.origin}${location.pathname}#${headingId.value}`
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copied.value = false
    }, 1200)
  } catch (err) {
    console.warn('[HeadingView] copy failed', err)
  }
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="heading-wrapper"
    :data-level="level"
    :data-heading-id="headingId"
  >
    <a
      class="heading-anchor"
      :href="`#${headingId}`"
      :class="{ copied }"
      :aria-label="copied ? '已复制' : '复制链接到剪贴板'"
      :title="copied ? '已复制' : '复制链接到剪贴板'"
      contentEditable="false"
      @mousedown.stop
      @click="copyLink"
    >
      {{ copied ? '✓' : '#' }}
    </a>
    <!--
      不传 as:NodeViewContent 在 level 变化时,Vue 复用同一节点,
      ProseMirror 不会重新挂载内容到新 DOM。as 改成 div 让所有 level
      共用同一容器,语义和视觉由 .heading-wrapper[data-level]
      CSS 区分。
    -->
    <NodeViewContent as="div" class="heading-content" />
  </NodeViewWrapper>
</template>

<style scoped>
.heading-wrapper {
  position: relative;
}
</style>
