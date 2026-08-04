<script setup lang="ts">
/**
 * CreatedPageGroup — PersonalHomeView「我创建的」section 的单个空间分组。
 *
 * 用法:
 *   <CreatedPageGroup
 *     :space="space"
 *     :pages="pagesInGroup"
 *     @open-page="openPage"
 *     @prefetch="ensurePageLoaded"
 *   />
 *
 * 结构:
 *   - 顶行 `<button class="cpg-head">`:SpaceAvatar + 空间名 + "X 个" chip + caret
 *   - 展开:一组 DashboardCard `variant="page"`,row 通过 section-list 自带 border
 *     走视觉断点
 *   - 折叠:只露顶行,内容收起
 *
 * 折叠态走 `uiStore.toggleSection('created-group-{spaceId}', defaultCollapsed)`:
 * localStorage 持久化(`PERSIST_KEYS.SIDEBAR_SECTIONS`),刷新保留;跟 Sidebar
 * 的页面树折叠状态走同一基础设施,不另开 key。
 *
 * 不持有"是否要渲染 group"逻辑 — 父组件在 createdBySpace computed 里已经过滤
 * 了零页 / 不存在空间的组,这边只负责单组 UI + 折叠。
 */
import { computed } from 'vue'
import { useUiStore } from '@/stores/ui'
import DashboardCard from '@/components/page/DashboardCard.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import type { PageNode, Space } from '@power-wiki/shared'

const props = withDefaults(
  defineProps<{
    space: Space | null
    /** 空间已被删时的 fallback 名;显示用 */
    spaceName: string
    pages: PageNode[]
    /** 默认折叠态(展开),不传 = false */
    defaultCollapsed?: boolean
  }>(),
  { defaultCollapsed: false },
)

const uiStore = useUiStore()

const emit = defineEmits<{
  (e: 'openPage', pageId: string): void
  (e: 'prefetch', page: PageNode): void
}>()

const sectionKey = computed(() => `created-group-${props.space?.id ?? 'deleted'}`)
const collapsed = computed(() => uiStore.isSectionCollapsed(sectionKey.value, props.defaultCollapsed))

function onToggle(): void {
  uiStore.toggleSection(sectionKey.value, props.defaultCollapsed)
}

const chipColor = computed(() => props.space?.color ?? 'var(--text-3)')
const isPersonal = computed(() => props.space?.kind === 'personal')

function openRow(pageId: string): void {
  emit('openPage', pageId)
}
function prefetchRow(page: PageNode): void {
  emit('prefetch', page)
}
</script>

<template>
  <section class="cpg">
    <button type="button" class="cpg-head" @click="onToggle">
      <SpaceAvatar :space="space" :size="20" />
      <span class="cpg-name">{{ space?.name ?? spaceName }}</span>
      <span class="cpg-kind" :title="isPersonal ? '个人空间' : '团队空间'">
        {{ isPersonal ? '个人' : '团队' }}
      </span>
      <span class="cpg-count">{{ pages.length }} 个</span>
      <span
        class="material-symbols-outlined cpg-caret"
        :class="{ 'cpg-caret-collapsed': collapsed }"
        aria-hidden="true"
      >expand_more</span>
    </button>
    <ul v-if="!collapsed" class="cpg-list">
      <li
        v-for="page in pages"
        :key="page.id"
        @mouseenter="prefetchRow(page)"
      >
        <DashboardCard
          variant="page"
          :page="page"
          :space-name="space?.name ?? spaceName"
          :space-color="chipColor"
          :space-kind="isPersonal ? 'personal' : 'shared'"
          @open-page="openRow"
        />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.cpg {
  margin: 0;
  padding: 0;
}
.cpg + .cpg { border-top: 1px solid var(--border); }

.cpg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.cpg-head:hover { background: var(--bg-subtle); }
.cpg-head:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

.cpg-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  max-width: 200px;
}
.cpg-kind {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}
.cpg-count {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.cpg-caret {
  font-size: 18px !important;
  color: var(--text-3);
  flex-shrink: 0;
  transition: transform var(--duration-fast) var(--ease-out);
}
.cpg-caret-collapsed { transform: rotate(-90deg); }

.cpg-list {
  list-style: none;
  margin: 0;
  padding: 0 0 4px 32px;
}
.cpg-list > li:last-child :deep(.dash-card) { border-bottom: 0; }
</style>
