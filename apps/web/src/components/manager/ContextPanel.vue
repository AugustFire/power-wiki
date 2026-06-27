<script setup lang="ts">
/**
 * ContextPanel — right-side context panel for manager list views.
 *
 *   <ContextPanel>
 *     <template #title>用户概览</template>
 *     <div class="stats-row">
 *       <StatBlock :value="9" label="总用户" />
 *       <StatBlock :value="2" label="管理员" />
 *     </div>
 *     ...
 *   </ContextPanel>
 *
 * Visual: matches .create-panel (white card, 1px border, --radius-md).
 * Sits inside the sticky `.manager-context` column in ManagerLayout.
 */
defineProps<{
  /** Optional id for aria-labelledby on the section */
  id?: string
}>()
</script>

<template>
  <section class="context-panel" :id="id">
    <header v-if="$slots.title || $slots.actions" class="cp-header">
      <h3 class="cp-title">
        <slot name="title">概览</slot>
      </h3>
      <div v-if="$slots.actions" class="cp-actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="cp-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.context-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 16px 18px;
}

.cp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.cp-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0;
}

.cp-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.cp-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>