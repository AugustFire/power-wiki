<script setup lang="ts">
/**
 * 页面关注 👁 按钮 —— M13 入口组件,放 ReadView / EditView 顶部 subheader 的
 * page-actions 行(与 "页面历史" 同款 `.btn`),不是底部 reactions 行。
 *
 * 位置契约(2026-07-10 用户拍板,贴 design/wiki-read.html:311):
 *   ReadView subheader .page-actions:[ExportMenu | 页面历史 | **关注** | 编辑]
 *   EditView subheader .page-actions:[... | 关闭 | **关注** | 发布]
 *
 * 状态:
 *   - page.watchedByMe=true → 实心 visibility(FILL=1)+ label='已关注'
 *   - page.watchedByMe=false → 空心 visibility(FILL=0)+ label='关注'
 *
 * 计数:
 *   - watchersCount > 0 → 在 label 前显示一个小数字(参考 like-button 模式)
 *   - watchersCount === 0 → 不显示计数,只显示 icon + label
 *
 * 乐观翻转走 store.togglePageWatch,失败由 store banner 兜底 + 自动回滚。
 * 这里 re-entry guard 防双击。
 */
import { computed, ref } from 'vue'
import type { PageNode } from '@power-wiki/shared'
import { usePagesStore } from '@/stores/pages'

const props = defineProps<{
  /** 当前页 PageNode —— reactive 字段 watchedByMe / watchersCount 由 store 维护 */
  page: PageNode
}>()

const pagesStore = usePagesStore()
const toggling = ref(false)

const isWatched = computed(() => props.page.watchedByMe === true)
const watchersCount = computed(() => props.page.watchersCount ?? 0)

async function onClick() {
  if (toggling.value) return
  toggling.value = true
  try {
    await pagesStore.togglePageWatch(props.page.id)
  } finally {
    toggling.value = false
  }
}
</script>

<template>
  <button
    type="button"
    class="btn watch-btn"
    :class="{ active: isWatched }"
    :disabled="toggling"
    :aria-pressed="isWatched"
    :title="isWatched ? '取消关注 — 不再收到此页更新通知' : '关注此页 — 编辑、改名、移动时会收到通知'"
    @click="onClick"
  >
    <span class="material-symbols-outlined watch-icon">visibility</span>
    <span v-if="watchersCount > 0" class="watch-count">{{ watchersCount }}</span>
    <span class="watch-label">{{ isWatched ? '已关注' : '关注' }}</span>
  </button>
</template>

<style scoped>
/* 复用 .btn 全局 token,只覆盖 .watch-btn 专属:active 视觉 + 计数宽度 +
   标签写法。`.btn` 已经在 components.css:163 统一了 height 32 / padding 0 12 /
   radius / font 14,跟兄弟按钮(页面历史 / 编辑)同密度。

   active 态:跟 `.btn.primary` 同档(accent 蓝边 + accent 软底),表达「订阅成功」。
   比 `.btn.primary` 浅一档(active 仍是 ghost 边框 + accent 软底,不抢 primary
   「编辑 / 发布」的高亮位)。 */

.watch-btn .watch-icon {
  font-size: 16px;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

.watch-btn.active .watch-icon {
  font-variation-settings: 'FILL' 1, 'wght' 600, 'GRAD' 0, 'opsz' 24;
}

.watch-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.watch-btn.active:hover {
  background: var(--accent-soft);
}

.watch-count {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.85;
}

.watch-label {
  /* 让计数 + label 之间有视觉间隔,而不靠空格断行 */
  margin-left: 2px;
}
</style>