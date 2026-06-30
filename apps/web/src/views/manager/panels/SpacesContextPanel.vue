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
      <StatBlock
        :value="emptySpacesCount"
        label="空空间"
        :hint="emptySpacesCount > 0 ? '可删除以整理' : '无'"
        tone="warning"
      />
      <StatBlock
        :value="unauthorizedSpacesCount"
        label="未授权"
        :hint="unauthorizedSpacesCount > 0 ? '只有管理员可访问' : '无'"
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