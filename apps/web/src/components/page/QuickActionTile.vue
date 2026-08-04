<script setup lang="ts">
/**
 * QuickActionTile — PersonalHomeView 顶部「快速操作条」的圆形大按钮。
 *
 * 用法:
 *   <QuickActionTile
 *     icon="note_add"
 *     label="快速新建"
 *     @click="quickCreatePage"
 *   />
 *
 * 设计目标:作为工作台最高频 3 个动作(快速新建 / 快速导入 / 个人空间)
 * 的圆形大入口,跟下方 sections row 视觉权重分离。视觉走 tokens.css 变量,
 * 56px 圆形 box + icon + label,hover 边框过渡到 accent。
 *
 * 不持有状态,emit('click') 交给父组件处理(新建 / 导入 / 切空间 三方
 * 都对接到 pagesStore / uiStore.openImport / spacesStore.setActiveSpace)。
 */
defineProps<{
  /** material-symbols-outlined 图标名 */
  icon: string
  /** 圆形下方 label 文字 */
  label: string
  /** hover tooltip */
  title?: string
  /** 不可点态:disabled 时整体 opacity 0.5 + cursor not-allowed,不 emit click */
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'click'): void
}>()

function onClick(): void {
  emit('click')
}
</script>

<template>
  <button
    type="button"
    class="quick-tile"
    :class="{ 'is-disabled': disabled }"
    :disabled="disabled"
    :title="title ?? label"
    @click="onClick"
  >
    <span class="quick-circle">
      <span class="material-symbols-outlined">{{ icon }}</span>
    </span>
    <span class="quick-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.quick-tile {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.quick-tile:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.quick-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  color: var(--accent);
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.quick-circle .material-symbols-outlined {
  font-size: 32px;
  color: inherit;
}
.quick-tile:hover .quick-circle {
  border-color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
}
.quick-tile:active .quick-circle {
  transform: translateY(0);
}

.quick-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  white-space: nowrap;
  letter-spacing: 0.02em;
}
.quick-tile:hover .quick-label { color: var(--text-1); }

.quick-tile.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.quick-tile.is-disabled:hover .quick-circle {
  border-color: var(--border);
  background: var(--bg-subtle);
  transform: none;
}
</style>
