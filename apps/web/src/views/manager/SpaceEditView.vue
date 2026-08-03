<script setup lang="ts">
/**
 * SpaceEditView — 空间管理 shell(Phase A.6 + v0.7 + P1-5 拆分)。
 *
 * 拆分后职责:
 *  - 加载空间、grants、allGroups、allUsers(按身份分流:admin 走
 *    api.admin.* + /permissions/candidates,space-admin 走 api.spaces.*)
 *  - URL 同步:`?tab=` 切换 info / members / grants,`?highlight=` 用于
 *    成员 tab「调整授权」跳授权 tab 时的高亮
 *  - 持有共享数据,向下分发给三个子 tab:
 *      - SpaceInfoTab.vue:基本信息 / 主页 / 归档 / 删除
 *      - SpaceMembersTab.vue:成员浏览(P1-2 已存在)
 *      - SpaceGrantsTab.vue:访问控制 / 角色菜单 / 有效角色预览
 *  - 路由 / breadcrumb / loading 骨架
 *
 * 行为保持不变:视觉、URL 契约、API 调用、菜单 + popover 行为 1:1 对应
 * 拆分前的 SpaceEditView(只是把 2608 行单文件切成 4 个职责单一的文件)。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Skeleton from '@/components/ui/Skeleton.vue'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import SpaceMembersTab from '@/views/manager/SpaceMembersTab.vue'
import SpaceInfoTab from '@/components/manager/space/SpaceInfoTab.vue'
import SpaceGrantsTab from '@/components/manager/space/SpaceGrantsTab.vue'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import type {
  Space,
  SpaceGrants,
  User,
  UserGroup,
} from '@power-wiki/shared'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const spaceId = computed(() => String(route.params.id ?? ''))

/* ─── 共享数据(shell 持有,header adminUserIds 也要读) ───────── */
const space = ref<Space | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const grants = ref<SpaceGrants>({ groups: [], users: [] })
const originalGrants = ref<SpaceGrants>({ groups: [], users: [] })
const allGroups = ref<UserGroup[]>([])
const allUsers = ref<User[]>([])

/* ─── Tab 状态(URL 同步) ────────────────────────────────────── */
type SpaceTab = 'info' | 'members' | 'grants'
const TABS: Array<{ value: SpaceTab; label: string; icon: string }> = [
  { value: 'info',    label: '信息', icon: 'info' },
  { value: 'members', label: '成员', icon: 'group' },
  { value: 'grants',  label: '授权', icon: 'shield_person' },
]
const activeTab = computed<SpaceTab>(() => {
  const raw = route.query.tab
  if (raw === 'members' || raw === 'grants') return raw
  return 'info'
})
const visibleTabs = computed(() => {
  if (space.value?.kind === 'personal') return TABS.filter((t) => t.value === 'info')
  return TABS
})
function switchTab(tab: SpaceTab) {
  void router.replace({ path: route.path, query: { ...route.query, tab } })
}

/* ─── 跨 tab 高亮(成员 → 授权) ─────────────────────────────── */
const highlightedGrant = ref<{ kind: 'user' | 'group'; id: string } | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

function applyHighlightFromQuery() {
  const raw = route.query.highlight
  if (typeof raw !== 'string') {
    highlightedGrant.value = null
    return
  }
  const m = raw.match(/^grant:(user|group):(.+)$/)
  if (!m) {
    highlightedGrant.value = null
    return
  }
  highlightedGrant.value = { kind: m[1] as 'user' | 'group', id: m[2]! }
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedGrant.value = null
    const { highlight: _drop, ...rest } = route.query
    void _drop
    void router.replace({
      name: route.name as string | undefined,
      params: route.params,
      query: rest,
    }).catch(() => { /* ignore navigation duplicate */ })
  }, 1800)
}

watch(
  () => [route.query.tab, route.query.highlight],
  ([tab]) => {
    if (tab !== 'grants' && highlightedGrant.value) {
      highlightedGrant.value = null
      if (highlightTimer) clearTimeout(highlightTimer)
    }
    if (tab === 'grants') applyHighlightFromQuery()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer)
})

/* ─── 身份 / 路由 gate ───────────────────────────────────────── */
const isGlobalAdmin = computed(() => authStore.isAdmin)
const canEditMetadata = computed(
  () => isGlobalAdmin.value || space.value?.viewerRole === 'admin',
)
const isManagerRoute = computed(() =>
  route.matched.some((record) => record.path === '/manager'),
)
const backTarget = computed(() => (isManagerRoute.value ? '/manager/spaces' : '/'))
const backLabel = computed(() => (isManagerRoute.value ? '空间' : '我的知识库'))

const breadcrumbSegments = computed(() => {
  const cur = space.value?.name ?? '—'
  return [
    { label: backLabel.value, to: backTarget.value },
    { label: cur },
  ]
})

/* ─── Header 用的 adminUserIds(从 grants 派生) ──────────────── */
const adminUserIds = computed(() =>
  grants.value.users.filter((u) => u.role === 'admin').map((u) => u.userId),
)

function userNameOf(id: string): string {
  return allUsers.value.find((u) => u.id === id)?.name ?? id
}

/* ─── 加载 ───────────────────────────────────────────────────── */
async function load() {
  loading.value = true
  loadError.value = null
  try {
    const isAdmin = isGlobalAdmin.value
    let s: Space
    let g: SpaceGrants
    let groupsAll: UserGroup[]
    let usersAll: User[]
    if (isAdmin) {
      const [s2, g2, groupsP, usersP] = await Promise.all([
        api.admin.spaces.get(spaceId.value),
        api.spaces.permissions.get(spaceId.value),
        api.admin.groups.list({ limit: 200 }),
        api.admin.users.list({ limit: 200 }),
      ])
      s = s2
      g = g2
      groupsAll = groupsP.items
      usersAll = usersP.items
    } else {
      const [s2, g2, candidates] = await Promise.all([
        api.spaces.get(spaceId.value),
        api.spaces.permissions.get(spaceId.value),
        api.spaces.permissions.candidates(spaceId.value),
      ])
      s = s2
      g = g2
      groupsAll = candidates.groups
      usersAll = candidates.users
    }
    space.value = s
    grants.value = g
    allGroups.value = groupsAll
    allUsers.value = usersAll
    originalGrants.value = JSON.parse(JSON.stringify(grants.value))
    if (s.kind === 'personal') {
      void router.replace('/')
      return
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      loadError.value = '空间不存在或您没有管理权限'
    } else {
      loadError.value = e instanceof ApiError ? e.message : '加载失败'
    }
  } finally {
    loading.value = false
  }
}

watch(spaceId, () => {
  if (spaceId.value) void load()
})
onMounted(load)

useDocumentTitle(() => (space.value ? `编辑空间: ${space.value.name}` : null))

/* ─── 子 tab 事件回调 ────────────────────────────────────────── */
function onSpaceUpdated(updated: Space) {
  space.value = updated
}

function onSpaceDeleted() {
  void router.push(backTarget.value)
}

function onGrantsChanged(next: SpaceGrants) {
  grants.value = next
}

function onGrantsSaved(saved: SpaceGrants) {
  grants.value = saved
  originalGrants.value = JSON.parse(JSON.stringify(saved))
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}
</script>

<template>
  <div class="space-edit">
    <Breadcrumb
      v-if="!isManagerRoute"
      :segments="breadcrumbSegments"
    >
      <template #current="{ segment }">
        <span class="crumb-item current">
          <Skeleton v-if="loading" width="120px" height="14px" />
          <template v-else>{{ segment.label }}</template>
        </span>
      </template>
    </Breadcrumb>
    <Breadcrumb
      v-else
      variant="inline"
      :segments="breadcrumbSegments"
    >
      <template #current="{ segment }">
        <span class="crumb-item current">
          <Skeleton v-if="loading" width="120px" height="14px" />
          <template v-else>{{ segment.label }}</template>
        </span>
      </template>
    </Breadcrumb>

    <header class="se-header" v-if="space">
      <div class="se-header-text">
        <div class="se-title-row">
          <span
            class="se-avatar"
            :style="{ background: space.color }"
            aria-hidden="true"
          >
            <span v-if="space.icon" class="material-symbols-outlined se-icon">{{ space.icon }}</span>
            <span v-else class="se-initials">{{ space.name.slice(0, 2) }}</span>
          </span>
          <h1 class="se-title">{{ space.name }}</h1>
          <span
            v-if="space.kind === 'personal'"
            class="se-kind-badge se-kind-personal"
            title="个人空间:只有所有者可见,管理员只读"
          >个人空间</span>
          <span
            v-else
            class="se-kind-badge se-kind-shared"
            title="团队空间:授权组成员可见"
          >团队空间</span>
        </div>
        <div class="se-meta-row">
          <span class="se-meta-item">创建于 {{ formatDate(space.createdAt) }}</span>
          <template v-if="space.kind === 'personal' && space.ownerName">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">所有者:<RouterLink :to="{ name: 'manager-user-edit', params: { id: space.ownerId } }">{{ space.ownerName }}</RouterLink></span>
          </template>
          <template v-else-if="space.kind === 'personal' && !space.ownerName && space.ownerId">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">所有者 ID:<code>{{ space.ownerId }}</code></span>
          </template>
          <template v-if="adminUserIds.length > 0">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">
              管理员:
              <template v-for="(id, idx) in adminUserIds" :key="id">
                <RouterLink :to="{ name: 'manager-user-edit', params: { id } }">{{ userNameOf(id) }}</RouterLink><template v-if="idx < adminUserIds.length - 1">, </template>
              </template>
            </span>
          </template>
          <template v-else-if="space.kind !== 'personal'">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">管理员:全局 admin(无 user-level admin)</span>
          </template>
        </div>
      </div>
    </header>

    <header v-else-if="loading" class="se-header">
      <div class="se-header-text">
        <div class="se-title-row">
          <Skeleton width="40px" height="40px" radius="6px" />
          <Skeleton width="200px" height="22px" />
          <Skeleton width="80px" height="20px" radius="999px" />
        </div>
        <p class="se-sub">
          <Skeleton width="240px" height="12px" />
        </p>
      </div>
    </header>

    <nav
      v-if="space && visibleTabs.length > 1"
      class="se-tabs"
      role="tablist"
      aria-label="空间设置分区"
    >
      <button
        v-for="t in visibleTabs"
        :key="t.value"
        type="button"
        role="tab"
        class="se-tab"
        :class="{ 'se-tab-active': activeTab === t.value }"
        :aria-selected="activeTab === t.value"
        :aria-current="activeTab === t.value ? 'page' : undefined"
        @click="switchTab(t.value)"
      >
        <span class="material-symbols-outlined se-tab-icon">{{ t.icon }}</span>
        <span>{{ t.label }}</span>
      </button>
    </nav>

    <div v-if="loadError" class="se-error">
      <p>{{ loadError }}</p>
      <button
        type="button"
        class="btn ghost"
        @click="router.push(backTarget)"
      >返回</button>
    </div>

    <template v-else-if="loading">
      <div class="se-stack">
        <section v-if="isGlobalAdmin" class="se-card">
          <Skeleton width="100px" height="18px" />
          <div class="se-fields">
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
            <div class="se-color-row">
              <Skeleton width="40px" height="12px" />
              <Skeleton width="240px" height="28px" />
            </div>
          </div>
        </section>
        <section class="se-card">
          <Skeleton width="100px" height="18px" />
          <div class="se-perms-grid">
            <div>
              <Skeleton width="100%" height="36px" />
              <Skeleton :count="3" height="44px" />
            </div>
            <div>
              <Skeleton width="100%" height="36px" />
              <Skeleton :count="3" height="44px" />
            </div>
          </div>
        </section>
      </div>
    </template>

    <div v-else-if="space" class="se-stack">
      <div v-if="!isGlobalAdmin" class="se-info">
        <span class="material-symbols-outlined se-info-icon">shield_person</span>
        <span>
          你是本空间的<strong>管理员</strong>(space-admin),可管理成员授权、修改空间名称、描述和颜色。删除空间由全局 admin 处理。
        </span>
      </div>

      <SpaceInfoTab
        v-if="activeTab === 'info'"
        :space="space"
        :is-global-admin="isGlobalAdmin"
        @updated="onSpaceUpdated"
        @deleted="onSpaceDeleted"
      />

      <SpaceMembersTab
        v-if="activeTab === 'members' && space.kind !== 'personal'"
        :space-id="space.id"
      />

      <SpaceGrantsTab
        v-if="activeTab === 'grants'"
        :space="space"
        :grants="grants"
        :original-grants="originalGrants"
        :all-groups="allGroups"
        :all-users="allUsers"
        :highlighted-grant="highlightedGrant"
        @update:grants="onGrantsChanged"
        @saved="onGrantsSaved"
      />
    </div>
  </div>
</template>

<style scoped>
.space-edit {
  max-width: 1800px;
  margin: 0 auto;
  padding-bottom: 80px;
  width: 100%;
}

.se-stack { display: flex; flex-direction: column; gap: 12px; }

.se-error {
  padding: 48px;
  text-align: center;
  color: var(--danger);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.se-error .btn { margin-top: 12px; display: inline-flex; }

.se-info {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  line-height: 1.5;
}
.se-info-icon { font-size: 18px; flex-shrink: 0; }
.se-info strong { font-weight: 600; }

.se-header { margin-bottom: 14px; }
.se-title-row { display: flex; align-items: center; gap: 12px; }
.se-avatar {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 700;
  font-size: 14px;
  flex-shrink: 0;
}
.se-icon { font-size: 22px !important; }
.se-initials { letter-spacing: 0.5px; text-transform: uppercase; }
.se-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0; }
.se-kind-badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 11px;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.se-kind-personal { background: var(--accent-soft); color: var(--accent); }
.se-kind-shared { background: var(--bg-canvas); color: var(--text-3); }
.se-sub { font-size: 13px; color: var(--text-3); margin: 4px 0 0 52px; }
.se-sub a { color: var(--accent); text-decoration: none; }
.se-sub a:hover { text-decoration: underline; }
.se-sub code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background: var(--bg-canvas);
  padding: 1px 4px;
  border-radius: 3px;
}
.se-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  font-size: 13px;
  color: var(--text-3);
  margin: 0 0 0 52px;
  align-items: baseline;
  line-height: 1.5;
}
.se-meta-sep { color: var(--text-3); user-select: none; }
.se-meta-item { display: inline-flex; align-items: baseline; gap: 2px; }
.se-meta-item a {
  color: var(--accent);
  text-decoration: none;
  padding: 1px 3px;
  margin: -1px -3px;
  border-radius: 3px;
  transition: background var(--duration-fast) var(--ease-out);
}
.se-meta-item a:hover { background: var(--accent-soft, #DEEBFF); }
.se-meta-item code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background: var(--bg-canvas);
  padding: 1px 4px;
  border-radius: 3px;
}

.se-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.se-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
  position: relative;
}
.se-tab:hover:not(.se-tab-active) {
  color: var(--text-1);
  background: var(--bg-canvas);
}
.se-tab-icon { font-size: 16px; line-height: 1; }
.se-tab-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

/* skeleton-only styles (shell 仍需要在 loading 时画这些 placeholder) */
.se-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 16px 20px;
}
.se-fields {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) 2fr;
  column-gap: 16px;
  row-gap: 14px;
}
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.se-color-row { display: flex; flex-direction: column; gap: 6px; }
.se-perms-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}
</style>
