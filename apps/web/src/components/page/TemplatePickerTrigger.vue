<script setup lang="ts">
/**
 * TemplatePickerTrigger — small dropdown trigger that lets the user
 * pick "新建空白页面" vs "从模板新建…" from the sidebar's create button.
 *
 * Layout: the existing "创建页面" button becomes this trigger's main
 * button; a separate chevron toggles a popover menu. Click outside or
 * Esc closes the menu.
 *
 * Sidebar wires its existing `createRoot` flow to "新建空白页面" and
 * opens the picker dialog for "从模板新建…".
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const emit = defineEmits<{
  blank: []
  fromTemplate: []
}>()

const menuOpen = ref(false)
const rootEl = ref<HTMLElement | null>(null)

function toggleMenu(e: MouseEvent) {
  e.stopPropagation()
  menuOpen.value = !menuOpen.value
}

function pickBlank() {
  menuOpen.value = false
  emit('blank')
}
function pickFromTemplate() {
  menuOpen.value = false
  emit('fromTemplate')
}

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    menuOpen.value = false
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') menuOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="tpt-root">
    <div class="tpt-button-group">
      <button class="create-page-btn tpt-main" @click="pickBlank">
        <span class="material-symbols-outlined icon-lg">add</span>
        创建页面
        <kbd>/</kbd>
      </button>
      <button
        class="tpt-chevron"
        type="button"
        :title="menuOpen ? '关闭菜单' : '更多新建选项'"
        :aria-label="menuOpen ? '关闭菜单' : '更多新建选项'"
        @click="toggleMenu"
      >
        <span class="material-symbols-outlined">expand_more</span>
      </button>
    </div>
    <div v-if="menuOpen" class="tpt-menu" role="menu">
      <button class="tpt-item" type="button" role="menuitem" @click="pickBlank">
        <span class="material-symbols-outlined icon-md">description</span>
        新建空白页面
        <span class="tpt-hint">从头开始写</span>
      </button>
      <button class="tpt-item" type="button" role="menuitem" @click="pickFromTemplate">
        <span class="material-symbols-outlined icon-md">auto_awesome</span>
        从模板新建…
        <span class="tpt-hint">会议纪要 / RFC / SOP</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tpt-root {
  position: relative;
  width: 100%;
}
.tpt-button-group {
  display: flex;
  width: 100%;
}
.tpt-main {
  flex: 1;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.15);
}
.tpt-chevron {
  width: 28px;
  flex-shrink: 0;
  background: var(--accent);
  color: #fff;
  border: 0;
  border-top-right-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tpt-chevron:hover {
  background: #0747A6;
}
.tpt-chevron .material-symbols-outlined {
  font-size: 18px;
}
.tpt-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(9, 30, 66, 0.2));
  padding: 4px;
  z-index: 200;
}
.tpt-item {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-1);
  text-align: left;
}
.tpt-item:hover {
  background: var(--bg-subtle);
}
.tpt-item .material-symbols-outlined {
  color: var(--text-3);
}
.tpt-hint {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}
</style>