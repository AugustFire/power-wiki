<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BubbleMenu } from '@tiptap/vue-3'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import LinkPopover from './LinkPopover.vue'
import { useBlockTypeSwitcher } from '@/composables/useBlockTypeSwitcher'
import type { BlockTypeId } from '@/composables/useBlockTypeSwitcher'

const props = defineProps<{
  editor: Editor | null
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
      id: 'inlineCode', icon: 'code', title: '行内代码',
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

// ─── 块类型下拉(紧凑版,跟工具栏选项完全一致) ──────────────────
// 共享工具栏的 setBlockType,只复制 UI 状态(open/close/click outside)。
// 选项集(T4 决策)= 工具栏的 6 项:正文 / 一级 / 二级 / 三级 / 引用 / 代码块。
const editorRef = computed(() => props.editor)
const { blockTypeOptions, blockTypeLabel, setBlockType } = useBlockTypeSwitcher(editorRef)

const blockTypeWrap = ref<HTMLElement | null>(null)
const blockTypeOpen = ref(false)

function toggleBlockType() {
  blockTypeOpen.value = !blockTypeOpen.value
}

function onSelectBlockType(type: BlockTypeId) {
  setBlockType(type)
  blockTypeOpen.value = false
}

function onDocMouseDown(e: MouseEvent) {
  if (linkOpen.value && linkWrap.value && !linkWrap.value.contains(e.target as Node)) {
    linkOpen.value = false
  }
  if (blockTypeOpen.value && blockTypeWrap.value && !blockTypeWrap.value.contains(e.target as Node)) {
    blockTypeOpen.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))

// 只在非空选区 + 不在不可编辑节点内时显示
// 但 link popover 打开期间必须保持显示 —— 用户点链接按钮后焦点会跳到输入框,
// 选区塌缩,shouldShow 默认会返回 false,把整个 BubbleMenu 连同 popover 一起卸载。
// NodeSelection(atom 节点 / 整块选区)的 from === to 也是 true,但不是文本选区
// —— 用 selection instanceof TextSelection 区分,挡掉 NodeSelection 避免
// 点击图片/Callout/附件节点时弹出"加粗/斜体"工具栏(节点本身有自己的工具栏)。
function shouldShow({ editor }: { editor: Editor | null }) {
  if (!editor) return false
  if (editor.isActive('codeBlock')) return false
  if (linkOpen.value) return true
  const sel = editor.state.selection
  if (!(sel instanceof TextSelection)) return false
  if (sel.from === sel.to) return false
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
      <div ref="blockTypeWrap" class="bubble-blocktype-wrap" :class="{ open: blockTypeOpen }">
        <button
          class="bubble-blocktype"
          type="button"
          :aria-expanded="blockTypeOpen"
          aria-haspopup="menu"
          title="段落格式"
          @mousedown.prevent="toggleBlockType"
        >
          <span class="bubble-blocktype-label">{{ blockTypeLabel }}</span>
          <span class="material-symbols-outlined chev">expand_more</span>
        </button>
        <Transition name="popover-fade">
          <div v-if="blockTypeOpen" class="bubble-blocktype-menu">
            <button
              v-for="opt in blockTypeOptions"
              :key="opt.id"
              class="bubble-blocktype-opt"
              :class="{ active: opt.isActive() }"
              @mousedown.prevent="onSelectBlockType(opt.id)"
            >
              <span class="material-symbols-outlined">{{ opt.icon }}</span>
              <span>{{ opt.label }}</span>
            </button>
          </div>
        </Transition>
      </div>
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
  border-radius: var(--radius-md);
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

/* ─── Block-type 下拉(紧凑版,跟工具栏选项/行为完全一致) ───── */
.bubble-blocktype-wrap {
  position: relative;
  display: inline-flex;
}
.bubble-blocktype {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-md);
  background: transparent;
  border: 0;
  color: var(--text-2);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.bubble-blocktype:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.bubble-blocktype-wrap.open .bubble-blocktype {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.bubble-blocktype .chev {
  font-size: 16px;
  color: var(--text-3);
}

.bubble-blocktype-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 50;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 4px;
  min-width: 140px;
  /* popover 默认从 trigger 向下;bubble menu 通常在选区上方,
     这里用 bottom 让它从 trigger 向上展开,跟工具栏体验一致。 */
}
.bubble-blocktype-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-md);
  background: transparent;
  border: 0;
  color: var(--text-2);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.bubble-blocktype-opt:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.bubble-blocktype-opt.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.bubble-blocktype-opt .material-symbols-outlined {
  font-size: 18px;
}
</style>

