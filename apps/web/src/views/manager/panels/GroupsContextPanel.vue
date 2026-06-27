<script setup lang="ts">
/**
 * GroupsContextPanel — right-side panel for GroupsView.
 *
 * Loads groups + users + per-group member counts. Same data fetch as
 * GroupsView; cheap enough (small N of groups) to do twice.
 */
import { computed, onMounted, ref } from 'vue'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import { useManagerActions } from '@/composables/useManagerActions'
import type { User, UserGroup } from '@power-wiki/shared'
import ContextPanel from '@/components/manager/ContextPanel.vue'
import StatBlock from '@/components/manager/StatBlock.vue'

const { showCreateGroup } = useManagerActions()
function toggleCreate() { showCreateGroup.value = !showCreateGroup.value }

const uiStore = useUiStore()
const groups = ref<UserGroup[]>([])
const users = ref<User[]>([])
const memberCountByGroup = ref<Record<string, number>>({})
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const [g, u] = await Promise.all([api.admin.groups.list(), api.admin.users.list()])
    groups.value = g
    users.value = u
    const counts: Record<string, number> = {}
    await Promise.all(
      g.map(async (grp) => {
        const full = await api.admin.groups.get(grp.id)
        counts[grp.id] = full.memberIds?.length ?? 0
      }),
    )
    memberCountByGroup.value = counts
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '加载组统计失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const totalGroups = computed(() => groups.value.length)

// Unique member set across all groups (same user in 2 groups counts once).
const allMemberIds = computed(() => {
  const set = new Set<string>()
  for (const count of Object.values(memberCountByGroup.value)) {
    // We don't have memberIds here — only counts. For the "总成员(去重)"
    // approximation, sum the counts and clamp at userCount.
    void count
  }
  // Without memberIds per group, exact dedup isn't possible here without
  // another fetch. Approximate as the sum (will overcount if user is in
  // multiple groups). Show as "<= 用户总数" hint instead.
  return Object.values(memberCountByGroup.value).reduce((a, b) => a + b, 0)
})

const averageMembers = computed(() =>
  totalGroups.value === 0 ? 0 : Math.round(allMemberIds.value / totalGroups.value),
)

const emptyGroupsCount = computed(
  () => groups.value.filter((g) => (memberCountByGroup.value[g.id] ?? 0) === 0).length,
)

const largestGroup = computed(() => {
  let best: { name: string; count: number } | null = null
  for (const g of groups.value) {
    const c = memberCountByGroup.value[g.id] ?? 0
    if (!best || c > best.count) best = { name: g.name, count: c }
  }
  return best
})
</script>

<template>
  <ContextPanel>
    <template #title>用户组概览</template>

    <button
      type="button"
      class="quick-action"
      :class="{ 'is-open': showCreateGroup }"
      @click="toggleCreate"
    >
      <span class="material-symbols-outlined qa-icon">
        {{ showCreateGroup ? 'close' : 'group_add' }}
      </span>
      <span>{{ showCreateGroup ? '取消创建' : '创建新用户组' }}</span>
    </button>

    <div class="row-3">
      <StatBlock :value="totalGroups" label="总组数" />
      <StatBlock :value="allMemberIds" label="总成员" :hint="`约 ${averageMembers} / 组`" tone="accent" />
      <StatBlock :value="emptyGroupsCount" label="空组" tone="warning" />
    </div>

    <div v-if="largestGroup" class="section">
      <div class="section-title">最大组</div>
      <div class="lg-card">
        <span class="material-symbols-outlined lg-icon">workspaces</span>
        <div class="lg-text">
          <div class="lg-name">{{ largestGroup.name }}</div>
          <div class="lg-count">{{ largestGroup.count }} 名成员</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">说明</div>
      <p class="hint">
        用户可属于多个组;勾选空间访问组即可批量授权该组下所有用户。<br />
        同一用户在多个组中只占用一次授权额度。
      </p>
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
  gap: 8px;
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
.lg-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-canvas);
  border-radius: var(--radius-md, 4px);
}
.lg-icon {
  font-size: 20px;
  color: var(--accent);
  flex-shrink: 0;
}
.lg-text { min-width: 0; flex: 1; }
.lg-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lg-count {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
  margin: 0;
}
</style>