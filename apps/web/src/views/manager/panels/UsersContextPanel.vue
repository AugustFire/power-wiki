<script setup lang="ts">
/**
 * UsersContextPanel — right-side panel for UsersView.
 *
 * Loads users independently of UsersView (small payload, fine to fetch twice).
 * Computes the same stats that drive the header subtitle + breakdowns by
 * status / role / recent activity.
 */
import { computed, onMounted, ref } from 'vue'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import { useManagerActions } from '@/composables/useManagerActions'
import type { User } from '@power-wiki/shared'
import ContextPanel from '@/components/manager/ContextPanel.vue'
import StatBlock from '@/components/manager/StatBlock.vue'

const { showCreateUser } = useManagerActions()
function toggleCreate() { showCreateUser.value = !showCreateUser.value }

const uiStore = useUiStore()
const users = ref<User[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    users.value = await api.admin.users.list()
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '加载用户统计失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const total = computed(() => users.value.length)
const adminCount = computed(() => users.value.filter((u) => u.role === 'admin').length)
const userCount = computed(() => users.value.filter((u) => u.role === 'user').length)

const activeCount = computed(() => users.value.filter((u) => u.status === 'active').length)
const mustResetCount = computed(() => users.value.filter((u) => u.status === 'must_reset_password').length)
const disabledCount = computed(() => users.value.filter((u) => u.status === 'disabled').length)

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const recentlyActiveCount = computed(
  () => users.value.filter((u) => u.lastLoginAt && Date.now() - u.lastLoginAt < SEVEN_DAYS).length,
)
const neverLoggedInCount = computed(() => users.value.filter((u) => !u.lastLoginAt).length)

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}
</script>

<template>
  <ContextPanel>
    <template #title>用户概览</template>

    <button
      type="button"
      class="quick-action"
      :class="{ 'is-open': showCreateUser }"
      @click="toggleCreate"
    >
      <span class="material-symbols-outlined qa-icon">
        {{ showCreateUser ? 'close' : 'person_add' }}
      </span>
      <span>{{ showCreateUser ? '取消创建' : '创建新用户' }}</span>
    </button>

    <div class="row-3">
      <StatBlock :value="total" label="总用户" />
      <StatBlock :value="adminCount" label="管理员" :hint="`占 ${pct(adminCount, total)}%`" tone="accent" />
      <StatBlock :value="userCount" label="普通用户" />
    </div>

    <div class="section">
      <div class="section-title">状态分布</div>
      <StatBlock
        :value="activeCount"
        label="正常"
        tone="success"
        :progress="total === 0 ? 0 : activeCount / total"
      />
      <StatBlock
        :value="mustResetCount"
        label="需重置密码"
        tone="warning"
        :progress="total === 0 ? 0 : mustResetCount / total"
      />
      <StatBlock
        :value="disabledCount"
        label="已禁用"
        tone="danger"
        :progress="total === 0 ? 0 : disabledCount / total"
      />
    </div>

    <div class="section">
      <div class="section-title">活跃度</div>
      <StatBlock :value="recentlyActiveCount" label="近 7 天活跃" />
      <StatBlock :value="neverLoggedInCount" label="从未登录" tone="warning" />
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
  padding-top: 4px;
  border-top: 1px dashed var(--border);
  margin-top: 4px;
  padding-top: 12px;
}
.section:first-of-type {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>