<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BubbleMenu } from '@tiptap/vue-3'
import LinkPopover from './LinkPopover.vue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  editor: AnyEditor
}>()

interface FormatBtn {
  id: string
  icon: string
  title: string
  shortcut?: string
  isActive: () => boolean
  run: () => void
}

const formatBtns = computed<FormatBtn[]>(() => {
  const e = props.editor
  if (!e) return []
  return [
    {
      id: 'bold', icon: 'format_bold', title: '加粗', shortcut: 'Ctrl+B',
      isActive: () => e.isActive('bold'),
      run: () => e.chain().focus().toggleBold().run(),
    },
    {
      id: 'italic', icon: 'format_italic', title: '斜体', shortcut: 'Ctrl+I',
      isActive: () => e.isActive('italic'),
      run: () => e.chain().focus().toggleItalic().run(),
    },
    {
      id: 'strike', icon: 'format_strikethrough', title: '删除线',
      isActive: () => e.isActive('strike'),
      run: () => e.chain().focus().toggleStrike().run(),
    },
    {
      id: 'inlineCode', icon: 'code', title: '行内代码', shortcut: 'Ctrl+E',
      isActive: () => e.isActive('code'),
      run: () => e.chain().focus().toggleCode().run(),
    },
  ]
})

// ─── 链接 popover(沿用 LinkPopover) ──────────────────────────
const linkWrap = ref<HTMLElement | null>(null)
const linkOpen = ref(false)
const isOnLink = computed(() => !!props.editor?.isActive('link'))

function toggleLink() {
  linkOpen.value = !linkOpen.value
}
function closeLink() {
  linkOpen.value = false
}

function onDocMouseDown(e: MouseEvent) {
  if (!linkOpen.value) return
  if (linkWrap.value && !linkWrap.value.contains(e.target as Node)) {
    linkOpen.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))

// 只在非空选区 + 不在不可编辑节点内时显示
function shouldShow({ editor }: { editor: AnyEditor }) {
  if (!editor) return false
  const { from, to } = editor.state.selection
  if (from === to) return false
  if (editor.isActive('codeBlock')) return false
  return true
}
</script>

<template>
  <BubbleMenu
    v-if="editor"
    :editor="editor"
    :tippy-options="{ duration: 120, animation: 'shift-away-subtle', placement: 'top' }"
    :should-show="shouldShow"
    class="bubble-menu"
  >
    <div class="bubble-row">
      <button
        v-for="btn in formatBtns"
        :key="btn.id"
        class="bubble-btn"
        :class="{ active: btn.isActive() }"
        :title="btn.shortcut ? `${btn.title} (${btn.shortcut})` : btn.title"
        @mousedown.prevent="btn.run()"
      >
        <span class="material-symbols-outlined">{{ btn.icon }}</span>
      </button>
      <div class="bubble-sep"></div>
      <div ref="linkWrap" class="bubble-link-wrap">
        <button
          class="bubble-btn"
          :class="{ active: isOnLink }"
          :title="isOnLink ? '编辑链接' : '添加链接'"
          @mousedown.prevent="toggleLink"
        >
          <span class="material-symbols-outlined">{{ isOnLink ? 'edit' : 'link' }}</span>
        </button>
        <LinkPopover
          v-if="linkOpen"
          :editor="editor"
          :open="linkOpen"
          @close="closeLink"
        />
      </div>
    </div>
  </BubbleMenu>
</template>

<style scoped>
.bubble-menu {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 4px;
  min-width: 0;
}

.bubble-row {
  display: flex;
  align-items: center;
  gap: 1px;
}

.bubble-btn {
  width: 30px;
  height: 30px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  background: transparent;
  cursor: pointer;
  border: none;
  font-family: inherit;
}
.bubble-btn:hover { background: var(--bg-subtle); color: var(--text-1); }
.bubble-btn.active { background: var(--accent-soft); color: var(--accent); }
.bubble-btn .material-symbols-outlined { font-size: 18px; }

.bubble-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
  flex-shrink: 0;
}

.bubble-link-wrap { position: relative; }
</style>
