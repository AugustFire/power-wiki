<script setup lang="ts">
/**
 * PeopleContextPanel — right-side panel for PeopleView.
 *
 * Combines the stats that used to live in UsersContextPanel +
 * GroupsContextPanel. Both create-entity buttons are here (the active
 * tab's button is highlighted); the tab itself controls which form
 * opens in the main pane.
 */
import { computed, onMounted, ref } from 'vue'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import { useRouter } from 'vue-router'
import type { User, UserGroup, PageNode } from '@power-wiki/shared'
import ContextPanel from '@/components/manager/ContextPanel.vue'
import StatBlock from '@/components/manager/StatBlock.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'

const uiStore = useUiStore()
const router = useRouter()

const users = ref<User[]>([])
const groups = ref<UserGroup[]>([])
const memberCountByGroup = ref<Record<string, number>>({})
const recentPages = ref<PageNode[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const [u, g] = await Promise.all([api.admin.users.list(), api.admin.groups.list()])
    users.value = u
    groups.value = g
    const counts: Record<string, number> = {}
    await Promise.all(
      g.map(async (grp) => {
        const full = await api.admin.groups.get(grp.id)
        counts[grp.id] = full.memberIds?.length ?? 0
      }),
    )
    memberCountByGroup.value = counts
    // Recent activity = top 5 most recently updated pages (admin sees all
    // spaces). Lightweight fetch; admin is the only viewer here so this
    // is fine to do alongside the user/group queries.
    try {
      const allPages = await api.pages.list({})
      recentPages.value = [...allPages]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
    } catch {
      recentPages.value = []
    }
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '加载人员统计失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

/* ─── user stats (lifted from old UsersContextPanel) ─── */
const totalUsers = computed(() => users.value.length)
const adminCount = computed(() => users.value.filter((u) => u.role === 'admin').length)
const regularUserCount = computed(() => users.value.filter((u) => u.role === 'user').length)
const activeCount = computed(() => users.value.filter((u) => u.status === 'active').length)
const mustResetCount = computed(
  () => users.value.filter((u) => u.status === 'must_reset_password').length,
)
const disabledCount = computed(() => users.value.filter((u) => u.status === 'disabled').length)
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const recentlyActiveCount = computed(
  () => users.value.filter((u) => u.lastLoginAt && Date.now() - u.lastLoginAt < SEVEN_DAYS).length,
)
const neverLoggedInCount = computed(() => users.value.filter((u) => !u.lastLoginAt).length)

/* ─── group stats (lifted from old GroupsContextPanel) ─── */
const totalGroups = computed(() => groups.value.length)
const totalMemberSlots = computed(() =>
  Object.values(memberCountByGroup.value).reduce((a, b) => a + b, 0),
)
const averageMembers = computed(() =>
  totalGroups.value === 0 ? 0 : Math.round(totalMemberSlots.value / totalGroups.value),
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

/* ─── New in 5d: 最近登录 + 最近活动 (right panel fillers for 2K) ─── */
const topLoggedIn = computed(() =>
  [...users.value]
    .filter((u) => u.lastLoginAt)
    .sort((a, b) => (b.lastLoginAt ?? 0) - (a.lastLoginAt ?? 0))
    .slice(0, 5),
)

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}

function relativeShort(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function openPage(id: string) {
  void router.push(`/p/${id}`)
}
</script>

<template>
  <ContextPanel>
    <template #title>人员概览</template>

    <!-- Create actions live in the main area's header (PeopleView), not
         here. Right panel is read-only info / stats. -->

    <!-- Users stats -->
    <div class="section">
      <div class="section-title">用户</div>
      <div class="row-3">
        <StatBlock :value="totalUsers" label="总用户" />
        <StatBlock
          :value="adminCount"
          label="管理员"
          :hint="`占 ${pct(adminCount, totalUsers)}%`"
          tone="accent"
        />
        <StatBlock :value="regularUserCount" label="普通用户" />
      </div>
    </div>

    <div class="section">
      <div class="section-title">用户状态</div>
      <StatBlock
        :value="activeCount"
        label="正常"
        tone="success"
        :progress="totalUsers === 0 ? 0 : activeCount / totalUsers"
      />
      <StatBlock
        :value="mustResetCount"
        label="需重置密码"
        tone="warning"
        :progress="totalUsers === 0 ? 0 : mustResetCount / totalUsers"
      />
      <StatBlock
        :value="disabledCount"
        label="已禁用"
        tone="danger"
        :progress="totalUsers === 0 ? 0 : disabledCount / totalUsers"
      />
    </div>

    <div class="section">
      <div class="section-title">用户活跃度</div>
      <StatBlock :value="recentlyActiveCount" label="近 7 天活跃" />
      <StatBlock :value="neverLoggedInCount" label="从未登录" tone="warning" />
    </div>

    <!-- Group stats -->
    <div class="section">
      <div class="section-title">用户组</div>
      <div class="row-3">
        <StatBlock :value="totalGroups" label="总组数" />
        <StatBlock
          :value="totalMemberSlots"
          label="总成员"
          :hint="`约 ${averageMembers} / 组`"
          tone="accent"
        />
        <StatBlock :value="emptyGroupsCount" label="空组" tone="warning" />
      </div>
      <div v-if="largestGroup" class="lg-card">
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

    <!-- 最近登录: top 5 users sorted by lastLoginAt desc. Fills the right
         panel on 2K where 320px would otherwise feel sparse. -->
    <div v-if="topLoggedIn.length > 0" class="section">
      <div class="section-title">最近登录</div>
      <ul class="mini-list">
        <li v-for="u in topLoggedIn" :key="u.id" class="mini-row">
          <UserAvatar :size="24" :label="u.name" :color="u.color" />
          <div class="mini-text">
            <div class="mini-name">{{ u.name }}</div>
            <div class="mini-sub">{{ relativeShort(u.lastLoginAt!) }}</div>
          </div>
        </li>
      </ul>
    </div>

    <!-- 最近活动: top 5 most recently updated pages. Gives the admin a
         quick "what's been happening" glance without leaving the panel. -->
    <div v-if="recentPages.length > 0" class="section">
      <div class="section-title">最近活动</div>
      <ul class="mini-list">
        <li
          v-for="p in recentPages"
          :key="p.id"
          class="mini-row mini-row-clickable"
          role="button"
          tabindex="0"
          @click="openPage(p.id)"
          @keydown.enter="openPage(p.id)"
        >
          <span class="material-symbols-outlined mini-page-icon">description</span>
          <div class="mini-text">
            <div class="mini-name mini-name-ellipsis">{{ p.icon }} {{ p.title || '未命名' }}</div>
            <div class="mini-sub">{{ relativeShort(p.updatedAt) }}</div>
          </div>
        </li>
      </ul>
    </div>
  </ContextPanel>
</template>

<style scoped>
.row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
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
  margin-top: 4px;
}
.lg-icon { font-size: 20px; color: var(--accent); flex-shrink: 0; }
.lg-text { min-width: 0; flex: 1; }
.lg-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lg-count { font-size: 12px; color: var(--text-3); margin-top: 2px; }

.hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
  margin: 0;
}

/* Mini list (最近登录 / 最近活动) — compact rows for 320px context. */
.mini-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mini-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm, 3px);
  transition: background var(--duration-fast) var(--ease-out);
}
.mini-row-clickable {
  cursor: pointer;
}
.mini-row-clickable:hover {
  background: var(--bg-canvas);
}
.mini-row-clickable:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.mini-text {
  flex: 1;
  min-width: 0;
}
.mini-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
  line-height: 1.3;
}
.mini-name-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-sub {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.3;
  margin-top: 1px;
}
.mini-page-icon {
  font-size: 18px;
  color: var(--text-3);
  flex-shrink: 0;
}
</style>
