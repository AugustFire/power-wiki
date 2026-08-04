<script setup lang="ts">
/**
 * DrillDownPanel — SpaceHomeView stat-card 触发的下钻列表。
 *
 * 用法:
 *   <DrillDownPanel
 *     title="今日活跃"
 *     :count="12"
 *     :pages="pages"
 *     @clear="setFilter('')"
 *     @open="goPage"
 *   />
 *
 * 列表项:icon + title + author byline(头像 + 名字)+ 相对更新时间。
 * 空态:`暂无符合条件的页面`。
 */
import { formatRelativeTime } from '@/lib/relativeTime'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import type { PageNode } from '@power-wiki/shared'

defineProps<{
  title: string
  count: number
  pages: PageNode[]
}>()

const emit = defineEmits<{
  (e: 'clear'): void
  (e: 'open', pageId: string): void
}>()

function onClear() {
  emit('clear')
}
function onOpenRow(p: PageNode) {
  emit('open', p.id)
}
function onRowKeydown(e: KeyboardEvent, p: PageNode) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('open', p.id)
  }
}
function relTime(ts: number): string {
  return formatRelativeTime(ts)
}
</script>

<template>
  <section class="drill-panel">
    <header class="drill-head">
      <h3 class="drill-title">
        {{ title }}
        <span class="drill-count">{{ count }} 个</span>
      </h3>
      <button type="button" class="btn ghost drill-clear" @click="onClear">
        <span class="material-symbols-outlined">close</span>
        清空筛选
      </button>
    </header>

    <ul v-if="pages.length > 0" class="drill-list">
      <li
        v-for="page in pages"
        :key="page.id"
        tabindex="0"
        role="button"
        class="drill-row"
        @click="onOpenRow(page)"
        @keydown="onRowKeydown($event, page)"
      >
        <span class="material-symbols-outlined drill-doc">description</span>
        <span class="drill-page-title">{{ page.title || '(无标题)' }}</span>
        <span class="drill-byline">
          <UserAvatar
            :size="20"
            :label="page.updatedByName ?? page.authorName ?? '?'"
            :color="page.updatedByColor ?? page.authorColor ?? undefined"
            :avatar-kind="page.updatedByAvatarKind ?? page.authorAvatarKind ?? null"
            :avatar-ref="page.updatedByAvatarRef ?? page.authorAvatarRef ?? null"
            :user-id="page.updatedBy ?? page.authorId ?? null"
          />
          <span class="drill-byline-name">
            {{ page.updatedByName ?? page.authorName ?? '未知' }}
          </span>
        </span>
        <span class="drill-time">{{ relTime(page.updatedAt) }}</span>
      </li>
    </ul>

    <div v-else class="drill-empty">
      <span class="material-symbols-outlined">inbox</span>
      <span>暂无符合条件的页面</span>
    </div>
  </section>
</template>

<style scoped>
.drill-panel {
  margin: 0 0 20px;
  padding: 14px 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.drill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.drill-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}
.drill-count {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.drill-clear {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.drill-clear .material-symbols-outlined {
  font-size: 14px;
}

.drill-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.drill-row {
  display: grid;
  grid-template-columns: 20px 1fr auto auto;
  align-items: center;
  gap: 12px;
  padding: 8px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.drill-row:hover {
  background: var(--bg-subtle);
}
.drill-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.drill-doc {
  font-size: 18px;
  color: var(--text-3);
}
.drill-page-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.drill-byline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.drill-byline-name {
  font-variant-numeric: tabular-nums;
}
.drill-time {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.drill-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px 12px;
  font-size: 13px;
  color: var(--text-3);
}
.drill-empty .material-symbols-outlined {
  font-size: 20px;
}
</style>