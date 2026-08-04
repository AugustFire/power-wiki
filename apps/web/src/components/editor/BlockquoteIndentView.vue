<script setup lang="ts">
/**
 * BlockquoteIndent NodeView —— P1/5.2-quote。
 *
 * 渲染职责:
 *   1. 透传 NodeViewContent(段落)到默认 blockquote 容器里 —— ProseMirror
 *      负责把 blockquote 内部的 children 挂到 NodeViewContent 槽位,跟
 *      Callout / Toggle 一样。
 *   2. 可选 footer:有 cite URL 时在底部显示「来源: <a>example.com</a>」
 *      链接。无 cite → 不渲染 footer,regression 跟原 Blockquote 一致。
 *   3. 编辑态:无 UI(无 popover),靠双击 / 聚焦 footer 进入 PM 的文本编辑。
 *      cite 的修改走 slash 菜单的「/quote」先 unset 再 set(cite attr 是
 *      toggle 语义,不像 status badge 那样需要弹窗切换)。
 */
import { computed } from 'vue'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/vue-3'
import type { EditorNodeViewProps } from '@/editor/nodeViewProps'

const props = defineProps<EditorNodeViewProps<{ cite?: string | null }>>()

const cite = computed<string | null>(() => {
  const raw = props.node.attrs.cite
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
})

const displayHost = computed<string | null>(() => {
  if (!cite.value) return null
  try {
    return new URL(cite.value).host
  } catch {
    return cite.value
  }
})
</script>

<template>
  <NodeViewWrapper as="blockquote" class="blockquote-indent" :cite="cite ?? undefined">
    <NodeViewContent class="bqc-content" />
    <footer v-if="cite" class="bqc-footer">
      <span class="material-symbols-outlined" aria-hidden="true">link</span>
      <span>来源:</span>
      <a :href="cite" target="_blank" rel="noopener noreferrer">{{ displayHost }}</a>
    </footer>
  </NodeViewWrapper>
</template>

<style scoped>
.bqc-content {
  display: block;
}
.bqc-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
  font-size: 12px;
  color: var(--text-3);
  user-select: text;
}
.bqc-footer .material-symbols-outlined {
  font-size: 14px;
}
.bqc-footer a {
  color: var(--accent);
  text-decoration: none;
}
.bqc-footer a:hover {
  text-decoration: underline;
}
</style>
