<script setup lang="ts">
/**
 * SpacesContextPanel — right-side panel for SpacesView.
 *
 * Reads from the shared `spacesStore` instead of firing its own
 * `api.admin.spaces.list()`. The store is loaded once at app boot
 * (`main.ts` → `useSpacesStore().init()`) and admin gets the full
 * visible-spaces list — which for admin role == "all spaces", same data
 * the panel used to fetch separately. SpacesView writes back via
 * `spacesStore.upsert/refresh` after CRUD, so this panel stays in sync
 * with no extra wiring.
 *
 * Stats per space come straight off the Space DTO (pageCount /
 * accessGroupIds are server-aggregated; see `getSpacePageStats` in
 * `apps/api/src/lib/spaceStats.ts`).
 *
 * 5.14: 「空空间」/「未授权」两个 StatBlock 改为 RouterLink 跳到
 * /manager/spaces?filter=empty|unauthorized;SpacesView 接收 query 并
 * 应用客户端 filter + active filter chip。count === 0 时降级为纯展示,
 * 避免跳进永远空的结果页。
 */
import { computed } from 'vue'
import { useSpacesStore } from '@/stores/spaces'
import ContextPanel from '@/components/manager/ContextPanel.vue'
import StatBlock from '@/components/manager/StatBlock.vue'

const spacesStore = useSpacesStore()

const totalSpaces = computed(() => spacesStore.spaces.value.length)
const totalPages = computed(() =>
  spacesStore.spaces.value.reduce((sum: number, sp) => sum + (sp.pageCount ?? 0), 0),
)
const totalAccessRels = computed(() =>
  spacesStore.spaces.value.reduce(
    (sum: number, sp) => sum + (sp.accessGroupIds?.length ?? 0),
    0,
  ),
)
const emptySpacesCount = computed(
  () =>
    spacesStore.spaces.value.filter((sp) => (sp.pageCount ?? 0) === 0).length,
)
const unauthorizedSpacesCount = computed(
  () =>
    spacesStore.spaces.value.filter((sp) => (sp.accessGroupIds?.length ?? 0) === 0)
      .length,
)
const biggestSpace = computed(() => {
  let best: { name: string; count: number; color: string } | null = null
  for (const sp of spacesStore.spaces.value) {
    const c = sp.pageCount ?? 0
    if (!best || c > best.count) best = { name: sp.name, count: c, color: sp.color }
  }
  return best
})
</script>

<template>
  <ContextPanel>
    <template #title>空间概览</template>

    <!-- Create action lives in the main area's header (SpacesView), not
         here. Right panel is read-only info / stats. -->

    <div class="row-3">
      <StatBlock :value="totalSpaces" label="总空间" />
      <StatBlock :value="totalPages" label="总页面" tone="accent" />
      <StatBlock :value="totalAccessRels" label="授权关系" />
    </div>

    <div class="section">
      <div class="section-title">需要关注</div>
      <!-- 5.14 drilldown:count > 0 时整块可点,跳到 SpacesView 带 filter query;
           count === 0 时降级为纯展示(跟 PeopleContextPanel 一致)。 -->
      <RouterLink
        v-if="emptySpacesCount > 0"
        :to="{ path: '/manager/spaces', query: { filter: 'empty' } }"
        class="stat-link stat-link-warning"
      >
        <StatBlock
          :value="emptySpacesCount"
          label="空空间"
          hint="可删除以整理"
          tone="warning"
        />
        <span class="material-symbols-outlined stat-link-arrow">chevron_right</span>
      </RouterLink>
      <StatBlock
        v-else
        :value="emptySpacesCount"
        label="空空间"
        hint="无"
        tone="warning"
      />
      <RouterLink
        v-if="unauthorizedSpacesCount > 0"
        :to="{ path: '/manager/spaces', query: { filter: 'unauthorized' } }"
        class="stat-link stat-link-danger"
      >
        <StatBlock
          :value="unauthorizedSpacesCount"
          label="未授权"
          hint="只有管理员可访问"
          tone="danger"
        />
        <span class="material-symbols-outlined stat-link-arrow">chevron_right</span>
      </RouterLink>
      <StatBlock
        v-else
        :value="unauthorizedSpacesCount"
        label="未授权"
        hint="无"
        tone="danger"
      />
    </div>

    <div v-if="biggestSpace" class="section">
      <div class="section-title">最大空间</div>
      <div class="bs-card">
        <span class="bs-avatar" :style="{ background: biggestSpace.color }">
          {{ biggestSpace.name.slice(0, 2) }}
        </span>
        <div class="bs-text">
          <div class="bs-name">{{ biggestSpace.name }}</div>
          <div class="bs-count">{{ biggestSpace.count }} 个页面</div>
        </div>
      </div>
    </div>
  </ContextPanel>
</template>

<style scoped>
.row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.section:first-of-type {
  border-top: 0;
  padding-top: 0;
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* 5.14 drilldown — RouterLink wrapper gives the StatBlock an "actionable"
   affordance: hover background shift + chevron fade-in. arrow 默认 opacity 0
   避免跟普通 stat 视觉混淆。 */
.stat-link {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  margin: -6px -8px;
  border-radius: var(--radius-md, 4px);
  text-decoration: none;
  color: inherit;
  transition: background var(--duration-fast) var(--ease-out);
}
.stat-link:hover {
  background: var(--bg-canvas);
}
.stat-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.stat-link-arrow {
  font-size: 18px;
  color: var(--text-3);
  flex-shrink: 0;
  opacity: 0;
  transform: translateX(-2px);
  transition: opacity var(--duration-fast) var(--ease-out),
              transform var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.stat-link-warning:hover .stat-link-arrow { color: var(--warning); }
.stat-link-danger:hover .stat-link-arrow { color: var(--danger); }
.stat-link:hover .stat-link-arrow,
.stat-link:focus-visible .stat-link-arrow {
  opacity: 1;
  transform: translateX(0);
}
.bs-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-canvas);
  border-radius: var(--radius-md, 4px);
}
.bs-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 700;
  font-size: 12px;
  flex-shrink: 0;
}
.bs-text { min-width: 0; flex: 1; }
.bs-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bs-count {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
</style>