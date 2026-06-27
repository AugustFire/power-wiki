<script setup lang="ts">
/**
 * StatBlock — compact stat display for context panels.
 *
 *   <StatBlock :value="9" label="总用户" />
 *   <StatBlock :value="2" label="管理员" hint="占 22%" tone="accent" />
 *   <StatBlock :value="3" label="禁用" tone="danger" :progress="0.3" />
 *
 * `tone` colors the value text using existing semantic tokens.
 * `progress` (0..1) renders a thin accent bar below for proportional indicators.
 */
defineProps<{
  value: number | string
  label: string
  hint?: string
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger'
  /** 0..1 — if provided, draws a thin progress bar at the bottom */
  progress?: number
}>()
</script>

<template>
  <div class="stat-block" :class="`tone-${tone ?? 'default'}`">
    <div class="sb-value">{{ value }}</div>
    <div class="sb-label">{{ label }}</div>
    <div v-if="hint" class="sb-hint">{{ hint }}</div>
    <div v-if="typeof progress === 'number'" class="sb-bar-track">
      <div
        class="sb-bar-fill"
        :style="{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }"
      />
    </div>
  </div>
</template>

<style scoped>
.stat-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.sb-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.sb-label {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.3;
}

.sb-hint {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  line-height: 1.3;
}

/* tone coloring — applied to the big value */
.tone-accent .sb-value { color: var(--accent); }
.tone-success .sb-value { color: var(--success); }
.tone-warning .sb-value { color: var(--warning); }
.tone-danger .sb-value { color: var(--danger); }

.sb-bar-track {
  margin-top: 6px;
  height: 3px;
  background: var(--bg-subtle);
  border-radius: var(--radius-pill, 999px);
  overflow: hidden;
}
.sb-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--radius-pill, 999px);
  transition: width var(--duration-base) var(--ease-out);
}
.tone-success .sb-bar-fill { background: var(--success); }
.tone-warning .sb-bar-fill { background: var(--warning); }
.tone-danger .sb-bar-fill { background: var(--danger); }
</style>