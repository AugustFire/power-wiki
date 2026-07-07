<script setup lang="ts">
/**
 * CheatSheetModal — ⌘/ 唤起的快捷键速查表.
 *
 * 让新用户知道「快捷键存在」是唯一目的:StarterKit 的 keymap 全开
 * (见 CLAUDE.md「键盘快捷键放开」),但没有任何 UI 提示用户它们存在。
 * 这张速查表把散落在编辑器 / 全局的快捷键集中列出,分三组(全局 /
 * 编辑 / 结构),按 <kbd> 渲染,跟 TopBar 的 ⌘K hint 用同一套样式。
 *
 * 交互跟 ConfirmDialog 对齐:Teleport to body、backdrop click 关闭、
 * Escape 关闭、打开时锁 body 滚动。开关状态在 uiStore.cheatSheetOpen,
 * ⌘/ 在 App.vue 的全局 keydown 里触发。
 */
import { onBeforeUnmount, watch } from 'vue'
import { useUiStore } from '@/stores/ui'
import { storeToRefs } from 'pinia'

const uiStore = useUiStore()
const { cheatSheetOpen } = storeToRefs(uiStore)

type Shortcut = { keys: string[]; desc: string }
type Group = { title: string; items: Shortcut[] }

// ⌘ 在 Windows 上就是 Ctrl,mac 是 Cmd。这里统一用 ⌘ 符号(跟 TopBar
// 一致),不做平台分支 —— 视口锁死桌面端,用户能自行对应。
const groups: Group[] = [
  {
    title: '全局',
    items: [
      { keys: ['⌘', 'K'], desc: '搜索所有页面' },
      { keys: ['/'], desc: '搜索(聚焦不在输入框时)' },
      { keys: ['⌘', '/'], desc: '打开 / 关闭这张速查表' },
      { keys: ['⌘', 'S'], desc: '立即保存(打版本快照)' },
    ],
  },
  {
    title: '编辑',
    items: [
      { keys: ['⌘', 'B'], desc: '加粗' },
      { keys: ['⌘', 'I'], desc: '斜体' },
      { keys: ['⌘', 'U'], desc: '下划线' },
      { keys: ['⌘', 'Z'], desc: '撤销' },
      { keys: ['⌘', '⇧', 'Z'], desc: '重做' },
    ],
  },
  {
    title: '结构',
    items: [
      { keys: ['⌘', '⌥', '1'], desc: '标题 1' },
      { keys: ['⌘', '⌥', '2'], desc: '标题 2' },
      { keys: ['⌘', '⇧', '7'], desc: '有序列表' },
      { keys: ['⌘', '⇧', '8'], desc: '无序列表' },
      { keys: ['⌘', '⇧', '9'], desc: '引用块' },
      { keys: ['/'], desc: '行首唤起 slash 菜单(编辑器内)' },
    ],
  },
]

function onKey(e: KeyboardEvent) {
  if (!cheatSheetOpen.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    uiStore.closeCheatSheet()
  }
}

watch(
  cheatSheetOpen,
  (open) => {
    if (open) {
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', onKey)
    } else {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKey)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <transition name="cheat-fade">
      <div
        v-if="cheatSheetOpen"
        class="cheat-backdrop"
        @mousedown.self="uiStore.closeCheatSheet()"
      >
        <div
          class="cheat-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cheat-title"
          @mousedown.stop
        >
          <header class="cheat-head">
            <h2 id="cheat-title" class="cheat-title">键盘快捷键</h2>
            <button
              class="cheat-close"
              type="button"
              aria-label="关闭"
              @click="uiStore.closeCheatSheet()"
            >
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>
          <div class="cheat-grid">
            <section v-for="g in groups" :key="g.title" class="cheat-group">
              <h3 class="cheat-group-title">{{ g.title }}</h3>
              <ul class="cheat-list">
                <li v-for="(s, i) in g.items" :key="i" class="cheat-row">
                  <span class="cheat-desc">{{ s.desc }}</span>
                  <span class="cheat-keys">
                    <kbd v-for="(k, ki) in s.keys" :key="ki" class="cheat-kbd">{{ k }}</kbd>
                  </span>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.cheat-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim-2);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.cheat-dialog {
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 24px;
}
.cheat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.cheat-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}
.cheat-close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cheat-close:hover {
  background: var(--hover-bg, #f4f5f7);
}
.cheat-close .material-symbols-outlined {
  font-size: 20px;
}

.cheat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}
.cheat-group-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  margin: 0 0 10px;
}
.cheat-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cheat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cheat-desc {
  font-size: 13px;
  color: var(--text-2);
  min-width: 0;
}
.cheat-keys {
  display: inline-flex;
  gap: 3px;
  flex-shrink: 0;
}
.cheat-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.cheat-fade-enter-active,
.cheat-fade-leave-active {
  transition: opacity var(--duration-fast) ease;
}
.cheat-fade-enter-active .cheat-dialog,
.cheat-fade-leave-active .cheat-dialog {
  transition: transform var(--duration-base) var(--ease-out);
}
.cheat-fade-enter-from,
.cheat-fade-leave-to {
  opacity: 0;
}
.cheat-fade-enter-from .cheat-dialog,
.cheat-fade-leave-to .cheat-dialog {
  transform: translateY(-8px) scale(0.97);
}
</style>
