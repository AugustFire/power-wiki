<script setup lang="ts">
/**
 * SpacesContextPanel — right-side panel for SpacesView.
 *
 * Loads spaces + per-space page counts. Same data fetch as SpacesView.
 */
import { computed, onMounted, ref } from 'vue'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import { useManagerActions } from '@/composables/useManagerActions'
import type { Space } from '@power-wiki/shared'
import ContextPanel from '@/components/manager/ContextPanel.vue'
import StatBlock from '@/components/manager/StatBlock.vue'

const { showCreateSpace } = useManagerActions()
function toggleCreate() { showCreateSpace.value = !showCreateSpace.value }

const uiStore = useUiStore()
const spaces = ref<Space[]>([])
const pageCountBySpace = ref<Record<string, number>>({})
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const s = await api.admin.spaces.list()
    spaces.value = s
    const counts: Record<string, number> = {}
    await Promise.all(
      s.map(async (sp) => {
        const pages = await api.pages.list({ space: sp.id }).catch(() => [])
        counts[sp.id] = pages.length
      }),
    )
    pageCountBySpace.value = counts
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '加载空间统计失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const totalSpaces = computed(() => spaces.value.length)
const totalPages = computed(() =>
  Object.values(pageCountBySpace.value).reduce((a, b) => a + b, 0),
)
const totalAccessRels = computed(() =>
  spaces.value.reduce((sum, sp) => sum + (sp.accessGroupIds?.length ?? 0), 0),
)
const emptySpacesCount = computed(
  () => spaces.value.filter((sp) => (pageCountBySpace.value[sp.id] ?? 0) === 0).length,
)
const unauthorizedSpacesCount = computed(
  () => spaces.value.filter((sp) => (sp.accessGroupIds?.length ?? 0) === 0).length,
)
const biggestSpace = computed(() => {
  let best: { name: string; count: number; color: string } | null = null
  for (const sp of spaces.value) {
    const c = pageCountBySpace.value[sp.id] ?? 0
    if (!best || c > best.count) best = { name: sp.name, count: c, color: sp.color }
  }
  return best
})
</script>

<template>
  <ContextPanel>
    <template #title>空间概览</template>

    <button
      type="button"
      class="quick-action"
      :class="{ 'is-open': showCreateSpace }"
      @click="toggleCreate"
    >
      <span class="material-symbols-outlined qa-icon">
        {{ showCreateSpace ? 'close' : 'create_new_folder' }}
      </span>
      <span>{{ showCreateSpace ? '取消创建' : '创建新空间' }}</span>
    </button>

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
.quick-action {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 12px;
  background: var(--accent);
  color: #FFFFFF;
  border: 0;
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-sans, inherit);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.quick-action:hover { background: var(--accent-hover); }
.quick-action.is-open {
  background: var(--bg-subtle);
  color: var(--text-2);
}
.quick-action.is-open:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.qa-icon { font-size: 18px; }

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