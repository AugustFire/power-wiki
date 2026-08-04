<script setup lang="ts">
/**
 * StatCard — team space home 大卡(stat-grid 用)。
 *
 * 跟 manager 的 StatBlock(apps/web/src/components/manager/StatBlock.vue)
 * 视觉不同:这里是大尺寸 hero card(icon + label + value + trend),
 * StatBlock 是 context panel 用的小方块(label + value + hint)。
 *
 * 点击行为:RouterLink 包裹,`route.query.filter` toggle。
 *   - 当前 filter === filterKey → 清除(关闭 drill-down)
 *   - 当前 filter !== filterKey → 设置为 filterKey
 * filterKey=null 表示不可点击(纯展示),走 <div>。
 */
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

const props = withDefaults(
  defineProps<{
    label: string
    value: number | string
    trend?: string
    icon: string
    variant?: 'default' | 'success' | 'purple' | 'warning'
    /** 传给 ?filter= 的值;null = 不可点击 */
    filterKey: 'all' | 'today' | 'week' | 'mine' | null
  }>(),
  { variant: 'default' },
)

const route = useRoute()

const isActive = computed(() => route.query.filter === props.filterKey)
const isClickable = computed(() => props.filterKey !== null)

const linkTo = computed(() => {
  if (!isClickable.value) return null
  return {
    path: route.path,
    query: {
      ...route.query,
      filter: isActive.value ? undefined : props.filterKey,
    },
  }
})
</script>

<template>
  <RouterLink
    v-if="isClickable && linkTo"
    :to="linkTo"
    class="stat-card"
    :class="[`tone-${variant}`, { 'is-clickable': true, 'is-active': isActive }]"
    :aria-pressed="isActive"
  >
    <div class="sc-label">
      <span class="material-symbols-outlined">{{ icon }}</span>
      {{ label }}
    </div>
    <div class="sc-value">{{ value }}</div>
    <div v-if="trend" class="sc-trend">{{ trend }}</div>
    <span
      v-if="isActive"
      class="material-symbols-outlined sc-arrow"
      aria-hidden="true"
    >chevron_right</span>
  </RouterLink>
  <div
    v-else
    class="stat-card"
    :class="[`tone-${variant}`]"
  >
    <div class="sc-label">
      <span class="material-symbols-outlined">{{ icon }}</span>
      {{ label }}
    </div>
    <div class="sc-value">{{ value }}</div>
    <div v-if="trend" class="sc-trend">{{ trend }}</div>
  </div>
</template>

<style scoped>
/* 基础 .stat-card 视觉由全局 styles/components.css 提供(背景 / 边框 /
   padding / ::before 左侧 3px accent bar / hover)。本组件只补充:
   - is-clickable:RouterLink 包裹 + cursor + 键盘 focus ring
   - is-active:当前 filter 命中时的视觉强调(用户已激活的 drill-down)
   - sc-label / sc-value / sc-trend:内部行内排版(label 走 inline-flex 加
     icon,value 走 28px tabular-nums,trend 走 11px secondary) */

/* .stat-card.is-clickable 同时是 RouterLink 渲染出来的 <a>,全局 .stat-card
   默认背景色 + 边框都从 components.css 来,我们只补 cursor + focus ring +
   RouterLink 默认文字色 / 下划线重置 */
.stat-card.is-clickable {
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}
.stat-card.is-clickable:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* 激活态:整卡 accent-soft 底色 + accent 边框 + 1px ring,提示用户当前
   drill-down 来自这张卡。优先级压过 .stat-card:hover。 */
.stat-card.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}
.stat-card.is-active:hover {
  background: var(--accent-soft);
}

.sc-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  margin-bottom: 6px;
}
.sc-label .material-symbols-outlined {
  font-size: 16px;
  color: var(--text-3);
}
.stat-card.tone-success .sc-label .material-symbols-outlined { color: var(--success); }
.stat-card.tone-purple .sc-label .material-symbols-outlined { color: var(--purple, #7B68EE); }
.stat-card.tone-warning .sc-label .material-symbols-outlined { color: var(--warning); }

.sc-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.sc-trend {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.3;
  margin-top: 4px;
}

.sc-arrow {
  position: absolute;
  top: 14px;
  right: 14px;
  font-size: 18px;
  color: var(--accent);
  opacity: 0.85;
}
</style>