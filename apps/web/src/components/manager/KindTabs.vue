<!--
  KindTabs — 2-tab toggle for separating 团队 / 个人 spaces.

  Used by /manager/spaces and /manager/trash to scope their data — admins see
  both kinds of spaces (Stage 6 personal-space feature), but the UX surface
  cleanly partitions them so admins aren't sifting through every user's
  personal space to find a shared one.

  v-model is the active tab id ('shared' | 'personal'). The actual data
  filtering lives in the parent — this component is presentational only.

  Counts are optional badges next to each tab label; pass `sharedCount` /
  `personalCount` to surface them. They give admins an at-a-glance sense of
  how much content is on each side without forcing a tab click.
-->
<script setup lang="ts">
type TabId = 'shared' | 'personal'

defineProps<{
  modelValue: TabId
  sharedCount?: number
  personalCount?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: TabId): void
}>()

function select(tab: TabId) {
  emit('update:modelValue', tab)
}
</script>

<template>
  <div class="kt-tabs" role="tablist">
    <button
      type="button"
      role="tab"
      class="kt-tab"
      :class="{ 'kt-tab-active': modelValue === 'shared' }"
      :aria-selected="modelValue === 'shared'"
      @click="select('shared')"
    >
      <span class="kt-label">团队</span>
      <span v-if="sharedCount !== undefined" class="kt-count">{{ sharedCount }}</span>
    </button>
    <button
      type="button"
      role="tab"
      class="kt-tab"
      :class="{ 'kt-tab-active': modelValue === 'personal' }"
      :aria-selected="modelValue === 'personal'"
      @click="select('personal')"
    >
      <span class="kt-label">个人</span>
      <span v-if="personalCount !== undefined" class="kt-count">{{ personalCount }}</span>
    </button>
  </div>
</template>

<style scoped>
.kt-tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: var(--bg-canvas);
  border-radius: 8px;
  border: 1px solid var(--border);
}
.kt-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 14px;
  border: 0;
  background: transparent;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-3);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  font-family: inherit;
}
.kt-tab:hover {
  color: var(--text-1);
}
.kt-tab-active {
  background: var(--bg);
  color: var(--text-1);
  box-shadow: 0 1px 2px rgba(9, 30, 66, 0.08);
}
.kt-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  background: var(--bg-canvas);
  border-radius: 9px;
}
.kt-tab-active .kt-count {
  color: var(--accent);
  background: var(--accent-soft);
}
</style>