<script setup lang="ts">
/**
 * EditView 顶栏 ⋮ 下拉 —— 把「限制」「分享」两个低频操作集中到 popover,
 * 给顶栏省出 2 个元素的空间(P0/5.3 — 1280 视口下顶栏从 6 元素收口到 4)。
 *
 * 模式镜像 PageMoreActionsMenu(rootEl + open ref + click-outside + escape
 * + transition + scoped CSS),不复用是因为本组件只有 2 个 item,引一次
 * PageMoreActionsMenu 的 props(busy / duplicating / export 链)反而把 EditView
 * 强绑到 ReadView 的菜单 UX。Menu 通用组件是 5.3 的另 P0 工作,本组件不抢
 * 先,等 Menu 落地后再统一迁。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const emit = defineEmits<{
  (e: 'restrictions'): void
  (e: 'share'): void
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}
function close() {
  open.value = false
}
function onDocClick(e: MouseEvent) {
  if (!open.value || !rootEl.value) return
  if (!rootEl.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})

function onRestrictions() {
  close()
  emit('restrictions')
}
function onShare() {
  close()
  emit('share')
}
</script>

<template>
  <div ref="rootEl" class="edit-more-menu">
    <button
      type="button"
      class="btn more-trigger"
      :class="{ open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      aria-label="更多操作"
      title="更多操作"
      @click="toggle"
    >
      <span class="material-symbols-outlined icon-md">more_horiz</span>
    </button>

    <transition name="more-fade">
      <div v-if="open" class="more-popover" role="menu">
        <button
          type="button"
          class="more-item"
          role="menuitem"
          @click="onRestrictions"
        >
          <span class="material-symbols-outlined more-icon">lock</span>
          <span class="more-label-inline">限制</span>
        </button>
        <button
          type="button"
          class="more-item"
          role="menuitem"
          @click="onShare"
        >
          <span class="material-symbols-outlined more-icon">share</span>
          <span class="more-label-inline">分享</span>
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
/* 跟 PageMoreActionsMenu 同款 chrome —— 后续 Menu 通用组件落地后再统一 */
.edit-more-menu {
  position: relative;
  display: inline-flex;
}

.more-trigger.open {
  background: var(--border);
  color: var(--text-1);
}

.more-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 160px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-md);
  padding: 4px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.more-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  text-align: left;
  cursor: pointer;
  width: 100%;
  transition: background var(--duration-fast, 120ms) var(--ease-out, ease-out);
}
.more-item:hover {
  background: var(--bg-canvas);
}
.more-item:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.more-icon {
  font-size: 18px;
  color: var(--text-2);
  flex-shrink: 0;
}

.more-label-inline {
  font-size: 14px;
  color: var(--text-1);
  line-height: 1.3;
}

.more-fade-enter-active,
.more-fade-leave-active {
  transition: opacity 120ms var(--ease-out, ease-out), transform 120ms var(--ease-out, ease-out);
}
.more-fade-enter-from,
.more-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>