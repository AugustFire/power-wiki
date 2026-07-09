<script setup lang="ts">
/**
 * EmptyState — universal "nothing here" placeholder.
 *
 * 三个语义槽(variant)区分意图,各自默认 icon:
 *   - 'no-data'         没有任何数据(默认 icon: inbox)
 *   - 'no-results'      查询/过滤没匹配(默认 icon: search_off)
 *   - 'no-permission'   没权限(默认 icon: lock)
 *
 * icon / title / hint 都能用 prop 或同名 slot 覆盖;variant 默认值可在 prop
 * 里指定,未指定走 'no-data'。
 *
 * 用法:
 *   <EmptyState icon="folder_open" title="还没有页面" hint="试试新建一个">
 *     <button class="btn primary" @click="create">新建</button>
 *   </EmptyState>
 *
 * 视觉上 muted(text-2/3),不抢正文的眼。CTA 用 default slot,自决位置。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    icon?: string
    hint?: string
    variant?: 'no-data' | 'no-results' | 'no-permission'
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { variant: 'no-data', size: 'md' },
)

const VARIANT_ICON: Record<string, string> = {
  'no-data': 'inbox',
  'no-results': 'search_off',
  'no-permission': 'lock',
}

// 当 caller 给了 icon prop / icon slot,优先用;否则按 variant 默认。
const fallbackIcon = computed(() => VARIANT_ICON[props.variant] ?? 'inbox')
</script>

<template>
  <div
    class="empty-state"
    :class="[`empty-${size}`, `empty-${variant}`]"
    role="status"
  >
    <div v-if="icon || $slots.icon" class="empty-icon">
      <slot name="icon">
        <span class="material-symbols-outlined">{{ icon ?? fallbackIcon }}</span>
      </slot>
    </div>
    <div class="empty-title">{{ title }}</div>
    <div v-if="hint || $slots.hint" class="empty-hint">
      <slot name="hint">{{ hint }}</slot>
    </div>
    <div v-if="$slots.default" class="empty-action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  color: var(--text-3);
  gap: 4px;
}

.empty-sm { padding: 28px 16px; }
.empty-md { padding: 56px 20px; }
.empty-lg { padding: 96px 24px; }

.empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--bg-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 12px;
  color: var(--text-3);
}
.empty-icon .material-symbols-outlined {
  font-size: 24px;
  opacity: 0.7;
}
.empty-no-permission .empty-icon {
  background: var(--warning-soft);
  color: var(--warning-text);
}
.empty-no-permission .empty-icon .material-symbols-outlined {
  opacity: 1;
}

.empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-2);
  line-height: 1.4;
}
.empty-sm .empty-title { font-size: 13px; }

.empty-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
  max-width: 360px;
}

.empty-action {
  margin-top: 14px;
  display: flex;
  gap: 8px;
  justify-content: center;
}
</style>
