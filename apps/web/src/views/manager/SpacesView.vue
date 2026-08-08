<script setup lang="ts">
/**
 * SpacesView — admin space list + create.
 *
 *   - List spaces as cards with color/icon, page count, access-group count.
 *   - Inline create form (name, description, color, optional icon).
 *   - Click card → /spaces/:id (SpaceEditView) for member-of-groups +
 *     rename/delete.
 *   - Delete is gated by the server: refuses if the space still has pages.
 *
 * Stage 7 cleanup: 个人空间和团队空间分两个 tab (`KindTabs`),默认 团队。
 * 在 `个人` tab 上**不**显示创建 / 删除按钮 — admin 不主动管理 personal space,
 * 那是用户的私有草稿区,只读查看就够了。个人空间卡上额外显示"所有者"列
 * (lookup users 表),方便 admin 知道某人的草稿空间属于谁。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { api, ApiError } from '@/lib/api'
import { useConfirm } from '@/composables/useConfirm'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useManagerActions } from '@/composables/useManagerActions'
import { useManagerStats } from '@/composables/useManagerStats'
import { usePaginatedList } from '@/composables/usePaginatedList'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import KindTabs from '@/components/manager/KindTabs.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { SPACE_COLOR_PALETTE } from '@/lib/colorPalettes'
import type { PaginatedQuery, Space, SpaceKindCounts, UserGroup } from '@power-wiki/shared'
import type { User } from '@power-wiki/shared'
import UserAvatar from '@/components/ui/UserAvatar.vue'

const router = useRouter()
const route = useRoute()
const uiStore = useUiStore()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
useDocumentTitle(() => '空间管理')
const { confirm: askConfirm } = useConfirm()

/**
 * Spaces is the main list — paginated with `usePaginatedList`. Groups +
 * users are auxiliary (the access-group preview + the personal-space
 * "所有者" column) and are loaded once as full sets because they need
 * to resolve names for every visible space.
 *
 * P1-1 bug fix:shared / personal 各一个独立 usePaginatedList 实例。
 * 之前的做法是拉全量 + 前端 filter,会出现「limit=50 拿到 48 个 personal
 * + 2 个 shared,第 3 个 shared 被切掉」—— kind 维度的分页必须跟 tab 对齐。
 * 后端 list 支持 `?kind=shared|personal`,前端每次切 tab 触发一次该 kind
 * 的 reset + 后续 loadMore。
 *
 * Stage B.3: both auxiliary lists come from `useManagerStats()` —
 * shared with PeopleView / PeopleContextPanel via the module-level
 * singleton + promise-cache. First caller fires the request; subsequent
 * callers (including SpacesView mounted later in the same SPA session)
 * await the in-flight promise instead of starting a second request.
 */
type KindTab = 'shared' | 'personal'
const kindTab = ref<KindTab>('shared')

const sharedList = usePaginatedList<Space>(
  async (q) => api.admin.spaces.list({ ...q, kind: 'shared' }),
  { pageSize: 50 },
)
const personalList = usePaginatedList<Space>(
  async (q) => api.admin.spaces.list({ ...q, kind: 'personal' }),
  { pageSize: 50 },
)

/** Union for template-side access(ownerNameById / accessSummary / 全局空态判断)。
 * 实际渲染走 visibleSpaces(按当前 tab 过滤的 list items)。 */
const spaces = computed<Space[]>(() => [...sharedList.items.value, ...personalList.items.value])

const sharedSpaces = sharedList.items
const personalSpaces = personalList.items
const sharedSpaceCount = computed(() => sharedSpaces.value.length)
const personalSpaceCount = computed(() => personalSpaces.value.length)

const currentList = computed(() => (kindTab.value === 'shared' ? sharedList : personalList))
const visibleSpaces = computed(() => currentList.value.items.value)
const currentKindHasMore = computed(() => currentList.value.hasMore.value)
const currentKindLoading = computed(() => currentList.value.loading.value)
async function loadMoreSpaces() {
  await currentList.value.loadMore()
}
async function resetCurrentKind() {
  await currentList.value.reset()
}

/* 5.14 drilldown:接收 /manager/spaces?filter=empty|unauthorized。
   仅在 panel 的两个 StatBlock 用了这两个值,作为白名单防止乱 query。
   应用客户端过滤,跟 kind tab 是 AND 关系(共享空间 + 空 = 当前 tab
   内空空间)。filter 变化时 reset 当前 kind 的列表 offset,避免分页
   越界:limit=50 拿到的第 17 个 unfiltered 空间,filter 之后可能落
   在 offset 之外。 */
type FilterKey = '' | 'empty' | 'unauthorized'
const VALID_FILTERS: ReadonlySet<FilterKey> = new Set(['', 'empty', 'unauthorized'])

const activeFilter = computed<FilterKey>(() => {
  const raw = String(route.query.filter ?? '')
  return VALID_FILTERS.has(raw as FilterKey) ? (raw as FilterKey) : ''
})

const filteredVisibleSpaces = computed(() => {
  const list = visibleSpaces.value
  if (!activeFilter.value) return list
  if (activeFilter.value === 'empty') {
    return list.filter((s) => (s.pageCount ?? 0) === 0)
  }
  // unauthorized: 仅 group 授权为 0(跟 panel 计算口径一致;直接
  // user grant 不算「未授权」—— 后端会接受 user grant + 0 group)。
  return list.filter((s) => (s.accessGroupIds?.length ?? 0) === 0)
})

function clearFilter() {
  void router.replace({ query: { ...route.query, filter: undefined } })
}

const filterChipLabel = computed(() => {
  switch (activeFilter.value) {
    case 'empty': return '空空间'
    case 'unauthorized': return '未授权'
    default: return ''
  }
})

watch(activeFilter, (next) => {
  // filter 切换 → 重置当前 kind 的 offset(沿用上面 5.14 设计注释里的理由)。
  if (next) void resetCurrentKind()
})

// P1-1 bug fix:load() 已并行拉齐 shared + personal,不需要 lazy watch。
// kindTab 切换纯客户端,数据已在 store 里。

const {
  groups,
  users: statsUsers,
  ensureGroupsLoaded,
  ensureUsersLoaded,
} = useManagerStats()
const loading = ref(false)
const loadError = ref<string | null>(null)

/**
 * `users` here is the legacy reactive view-local alias for the panel — each row in the table needs to look up `ownerName` by ownerId. The
 * composable already serves the data via `statsUsers`, so this view
 * just forwards it.
 */
const users = statsUsers

const { showCreateSpace: showShowCreate } = useManagerActions()
const showCreate = showShowCreate
const createName = ref('')
const createDesc = ref('')
const createColor = ref(SPACE_COLOR_PALETTE[0].value as string)
const creating = ref(false)
const createError = ref<string | null>(null)

// Reset form fields when the panel button transitions closed → open.
// Also reset `showCreate` on mount so stale open state doesn't carry over.
onMounted(() => { showCreate.value = false })
watch(showCreate, (next, prev) => {
  if (next && !prev) {
    createName.value = ''
    createDesc.value = ''
    createColor.value = SPACE_COLOR_PALETTE[0].value as string
    createError.value = null
  }
})

/**
 * No by-space stat maps: as of Stage B.2, Space DTO carries pageCount /
 * childPageCount / lastPageUpdatedAt / accessGroupIds from the server
 * (single GROUP BY aggregate query), so we read those directly off `s` in the
 * template. The earlier Promise.all(spaces.map(...)) was an N+1 firing one
 * `pages?space=<id>` request per space — visible in the browser Network panel
 * for any admin with many personal spaces.
 */
const groupById = ref<Record<string, UserGroup>>({})

function relativeTime(ts: number): string {
  return formatRelativeTime(ts)
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    // P1-1 bug fix:shared / personal 两个 kind 同时拉,避免默认 tab=shared
    // 时 personal tab 显示「0」(未加载≠为空),造成 admin 误判。
    // 两个 list 走独立 SQL(每 kind 一个 usePaginatedList 实例),并行 fetch,
    // 跟 group set 并行 — 一次往返拿齐,DB 总空间数 ~百级别,代价可接受。
    // `ensureGroupsLoaded` / `ensureUsersLoaded` 共享 useManagerStats,
    // 后续 PeopleView 等 caller 复用同一个 in-flight promise。
    const [, , , ] = await Promise.all([
      sharedList.reset(),
      personalList.reset(),
      ensureGroupsLoaded(),
      ensureUsersLoaded(),
    ])
    if (sharedList.error.value) {
      throw sharedList.error.value
    }
    if (personalList.error.value) {
      throw personalList.error.value
    }
    groupById.value = Object.fromEntries(groups.value.map((grp) => [grp.id, grp]))
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '加载空间失败'
    uiStore.setError(loadError.value)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  showCreate.value = true
}

function closeCreate() {
  showCreate.value = false
  createError.value = null
}

async function onSubmitCreate() {
  if (creating.value) return
  if (!createName.value.trim()) {
    createError.value = '名称不能为空'
    return
  }
  creating.value = true
  createError.value = null
  try {
    const created = await api.admin.spaces.create({
      name: createName.value.trim(),
      description: createDesc.value.trim() || undefined,
      color: createColor.value,
    })
    sharedList.items.value.push(created)
    // Sync the spaces store so the sidebar switcher reflects the new space
    // immediately if admin switches away from manager.
    spacesStore.upsert(created)
    showCreate.value = false
  } catch (e) {
    createError.value = e instanceof ApiError ? e.message : '创建失败'
  } finally {
    creating.value = false
  }
}

async function onArchive(s: Space) {
  const ok = await askConfirm({
    title: '归档空间',
    message: `确定要归档空间「${s.name}」吗?归档后该空间将从切换器中隐藏,页面仍可读但禁止新增和编辑。管理员可随时恢复。`,
    confirmText: '归档',
    danger: false,
  })
  if (!ok) return
  try {
    const updated = await api.admin.spaces.archive(s.id)
    const list = updated.kind === 'personal' ? personalList : sharedList
    const idx = list.items.value.findIndex((x) => x.id === s.id)
    if (idx >= 0) list.items.value[idx] = updated
    // 直接 upsert 到 spacesStore,避免触发 spacesStore.refresh() 重新拉
    // /api/spaces 全量接口。
    spacesStore.upsert(updated)
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '归档失败')
  }
}

async function onUnarchive(s: Space) {
  try {
    const updated = await api.admin.spaces.unarchive(s.id)
    const list = updated.kind === 'personal' ? personalList : sharedList
    const idx = list.items.value.findIndex((x) => x.id === s.id)
    if (idx >= 0) list.items.value[idx] = updated
    spacesStore.upsert(updated)
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '恢复失败')
  }
}

async function onDelete(s: Space) {
  let pageCount: number | null = null
  try {
    pageCount = (await api.admin.spaces.deleteImpact(s.id)).pageCount
  } catch {
    pageCount = null
  }
  const ok = await askConfirm({
    title: '删除空间',
    message: `确定要删除空间「${s.name}」吗?该操作不可撤销。`,
    details: [
      pageCount === null
        ? '空间必须为空(没有页面)才能删除。'
        : pageCount > 0
        ? `当前空间还有 ${pageCount} 个页面,请先删除或移动。`
        : '当前空间没有未删除页面。',
    ],
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await spacesStore.deleteSpace(s.id)
    const list = s.kind === 'personal' ? personalList : sharedList
    list.items.value = list.items.value.filter((x) => x.id !== s.id)
    // 后端 DELETE 已 0-page gate(见 adminSpaces.ts:321),无 cascade 需要,
    // 直接本地滤掉该空间的根节点即可——避免 586KB 全量重拉引起的页面卡顿。
    const sid = s.id
    pagesStore.pages = pagesStore.pages.filter((p: { spaceId: string }) => p.spaceId !== sid)
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : '删除失败'
    if (e instanceof ApiError && e.status === 409 && e.code === 'space_not_empty') {
      uiStore.setError(`该空间下还有 ${(e.body as { pageCount?: number })?.pageCount ?? ''} 个页面,请先删除或移动这些页面`)
    } else {
      uiStore.setError(msg)
    }
  }
}

function openSpace(s: Space) {
  void router.push({ name: 'manager-space-edit', params: { id: s.id } })
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}

// Owner-name lookup for the personal-space "所有者" column. Built lazily so
// switching tabs doesn't re-render the cards needlessly — it just changes
// which list is iterated.
const ownerNameById = computed<Record<string, string>>(() =>
  Object.fromEntries(users.value.map((u) => [u.id, u.name])),
)

/* 授权范围 = 授权组 ∪ 个人授权用户;accessGrants 是 DTO 上的服务端结构化
   数据(Phase A)。这里把 groups / users 拼成「总授权数 + 类型分解」,给
   card 的 access row 用。返回 0 个时给空状态文案。

   Per-card memoization(space.id → summary)避免模板里多次调用产生重复
   work —— 5 次 array.filter + .find 在 50 个 card × 6 字段下也会浪费
   几百次迭代。 */
interface AccessSummary {
  groupIds: string[]
  users: Array<{ id: string; name: string; color?: string | null; avatarKind?: User['avatarKind'] | null; avatarRef?: string | null }>
}
const accessSummaryBySpaceId = computed<Record<string, AccessSummary>>(() => {
  const map: Record<string, AccessSummary> = {}
  for (const s of spaces.value) {
    const groupIds = (s.accessGroupIds ?? []).filter((g) => !g.startsWith('pg-'))
    const userIds = (s.accessGrants?.users ?? []).map((u) => u.userId)
    const resolved = userIds
      .map((id) => users.value.find((u) => u.id === id))
      .filter((u): u is User => !!u)
      .map((u) => ({ id: u.id, name: u.name, color: u.color, avatarKind: u.avatarKind, avatarRef: u.avatarRef }))
    map[s.id] = { groupIds, users: resolved }
  }
  return map
})
function accessSummary(s: Space): AccessSummary {
  return accessSummaryBySpaceId.value[s.id] ?? { groupIds: [], users: [] }
}
</script>

<template>
  <div class="spaces-view">
    <div class="view-content-wide">
    <header class="sv-header">
      <div class="sv-header-text">
        <h1 class="sv-title">空间</h1>
        <p class="sv-sub">共 {{ sharedSpaceCount }} 个团队空间、{{ personalSpaceCount }} 个个人空间 — 用于按团队 / 项目组织页面并控制访问权限</p>
      </div>
      <!-- Create action lives in the main header, not the right context
           panel (which is read-only info / stats). Personal-space tab
           doesn't expose create — personal spaces are auto-created per
           user, not admin-managed. -->
      <div class="sv-header-actions">
        <KindTabs
          v-model="kindTab"
          :shared-count="sharedSpaceCount"
          :personal-count="personalSpaceCount"
        />
        <button
          v-if="kindTab === 'shared'"
          type="button"
          class="sv-action"
          @click="showCreate = true"
        >
          <span class="material-symbols-outlined">create_new_folder</span>
          <span>创建新空间</span>
        </button>
      </div>
    </header>

    <div v-if="loadError" class="sv-error">{{ loadError }}</div>

    <!-- 1.12: 个人空间管理语义区别 — 顶部 banner 解释 admin 不参与
         成员 / 协作管理,因为个人空间是用户的私有草稿区,只读查看就够。
         个人空间 tab 始终显示,跟 grid / empty state 都能搭配 —— 空态
         那条「自动创建」提示跟 banner 是同一信息的两面,叠加不冗余反而
         强化。团队空间 tab 不显示。 -->
    <div v-if="kindTab === 'personal'" class="sv-personal-info">
      <span class="material-symbols-outlined sv-personal-info-icon">cottage</span>
      <span class="sv-personal-info-text">
        <strong>个人空间是用户的私有草稿区</strong>
        · 由用户首次登录自动创建 · 管理员只读查看所有者和页面,无法管理成员或协作设置
      </span>
    </div>

    <div v-if="showCreate" class="create-panel">
      <h2 class="cp-title">创建空间</h2>

      <div v-if="createError" class="cp-error">{{ createError }}</div>

      <div class="cp-grid">
        <label class="field">
          <span class="field-label">名称</span>
          <input
            v-model="createName"
            type="text"
            class="field-input"
            placeholder="例如:工程文档"
            :disabled="creating"
            maxlength="64"
            autofocus
          />
        </label>
        <label class="field">
          <span class="field-label">描述(可选)</span>
          <input
            v-model="createDesc"
            type="text"
            class="field-input"
            placeholder="一句话说明这个空间的用途"
            :disabled="creating"
            maxlength="200"
          />
        </label>
      </div>

      <div class="cp-color-row">
        <span class="field-label">颜色</span>
        <div class="color-swatches">
          <button
            v-for="c in SPACE_COLOR_PALETTE"
            :key="c.value as string"
            type="button"
            class="cs-swatch"
            :class="{ 'cs-swatch-active': createColor === c.value }"
            :style="{ background: c.value as string }"
            :title="c.name"
            :disabled="creating"
            @click="createColor = c.value!"
          />
        </div>
      </div>

      <div class="cp-actions">
        <button type="button" class="btn ghost" :disabled="creating" @click="closeCreate">取消</button>
        <button type="button" class="btn primary" :disabled="creating" @click="onSubmitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </div>
    </div>

    <!-- 5.14 active filter chip — 跟 PeopleView active filter chips 一致:
         显示当前生效的 ?filter= 值,点 × 移除 query 参数(用 router.replace
         不留历史记录,避免「清除」也变成「后退」按一次才能撤)。 -->
    <div v-if="activeFilter" class="sv-active-filters" aria-label="已应用的筛选">
      <span class="sv-active-filters-label">筛选:</span>
      <button type="button" class="sv-filter-chip" @click="clearFilter">
        <span class="material-symbols-outlined sv-filter-chip-icon">
          {{ activeFilter === 'empty' ? 'inbox' : 'lock' }}
        </span>
        <span>{{ filterChipLabel }}</span>
        <span class="material-symbols-outlined sv-filter-chip-close">close</span>
      </button>
      <span class="sv-filter-result-count">
        {{ filteredVisibleSpaces.length }} 个匹配
      </span>
    </div>

    <div v-if="loading && spaces.length === 0" class="sv-loading">加载中…</div>
    <EmptyState
      v-else-if="spaces.length === 0"
      icon="folder_open"
      title="还没有空间"
      hint="创建空间以按团队 / 项目组织页面,并通过用户组控制访问权限。"
      size="sm"
    >
      <button
        v-if="kindTab === 'shared'"
        type="button"
        class="btn primary"
        @click="showCreate = true"
      >
        <span class="material-symbols-outlined">create_new_folder</span>
        <span>创建新空间</span>
      </button>
    </EmptyState>
    <EmptyState
      v-else-if="filteredVisibleSpaces.length === 0 && activeFilter"
      :icon="activeFilter === 'empty' ? 'inbox' : 'lock'"
      :title="`当前筛选下没有${filterChipLabel}`"
      :hint="`「${filterChipLabel}」筛选在该 tab 下没有匹配项。`"
      variant="no-results"
      size="sm"
    >
      <button type="button" class="btn ghost" @click="clearFilter">
        <span class="material-symbols-outlined">filter_alt_off</span>
        <span>清除筛选</span>
      </button>
    </EmptyState>
    <EmptyState
      v-else-if="filteredVisibleSpaces.length === 0"
      :icon="kindTab === 'shared' ? 'workspaces' : 'cottage'"
      :title="kindTab === 'shared' ? '还没有团队空间' : '还没有个人空间'"
      :hint="kindTab === 'shared'
        ? '创建空间以按团队 / 项目组织页面,并通过用户组控制访问权限。'
        : '每个用户首次登录时会自动创建个人空间(草稿区)。这里没有可供管理员创建的个人空间。'"
      variant="no-results"
      size="sm"
    />
    <div v-else class="sv-grid">
      <div
        v-for="s in filteredVisibleSpaces"
        :key="s.id"
        class="sv-card"
        :class="{ 'is-archived': s.archivedAt }"
        role="button"
        tabindex="0"
        @click="openSpace(s)"
        @keydown.enter="openSpace(s)"
      >
        <div class="sc-head">
          <span
            class="sc-avatar"
            :style="{ background: s.color }"
            aria-hidden="true"
          >
            <span v-if="s.icon" class="material-symbols-outlined sc-icon">{{ s.icon }}</span>
            <span v-else class="sc-initials">{{ s.name.slice(0, 2) }}</span>
          </span>
          <div class="sc-text">
            <div class="sc-name-row">
              <span class="sc-name">{{ s.name }}</span>
              <span
                v-if="s.kind === 'personal'"
                class="sc-kind-badge sc-kind-badge-personal"
                title="个人空间:只有所有者可见,管理员只读"
              >个人</span>
              <span
                v-else
                class="sc-kind-badge sc-kind-badge-shared"
                title="团队空间:授权组成员可见"
              >团队</span>
              <span
                v-if="s.archivedAt"
                class="sc-kind-badge sc-kind-badge-archived"
                title="已归档:页面可读,禁止新增和编辑"
              >已归档</span>
            </div>
            <!-- Owner row only meaningful on personal cards — team spaces
                 have no ownerId (it's null in the schema). -->
            <div v-if="s.kind === 'personal' && s.ownerId" class="sc-owner">
              <span class="material-symbols-outlined sco-icon">person</span>
              <span class="sco-label">所有者:</span>
              <span class="sco-name">{{ ownerNameById[s.ownerId] ?? s.ownerId }}</span>
            </div>
            <div v-if="s.description" class="sc-desc">{{ s.description }}</div>
          </div>
        </div>

        <div class="sc-stats">
          <div class="sc-stat">
            <span class="scs-value">{{ s.pageCount ?? 0 }}</span>
            <span class="scs-label">页面</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ s.childPageCount ?? 0 }}</span>
            <span class="scs-label">子页</span>
          </div>
          <!-- 1.12: 团队空间才显示「授权组 / 授权用户」 — 个人空间没有
               access control(仅所有者可见),这两项恒为 0,显示出来只在
               视觉上重复 owner row。 -->
          <template v-if="s.kind === 'shared'">
            <div class="sc-stat">
              <span class="scs-value">{{ s.accessGroupIds?.length ?? 0 }}</span>
              <span class="scs-label">授权组</span>
            </div>
            <div class="sc-stat">
              <span class="scs-value">{{ s.accessGrants?.users.length ?? 0 }}</span>
              <span class="scs-label">授权用户</span>
            </div>
          </template>
          <div class="sc-stat">
            <span class="scs-value">{{ s.lastPageUpdatedAt ? relativeTime(s.lastPageUpdatedAt) : '—' }}</span>
            <span class="scs-label">最近更新</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ formatDate(s.createdAt) }}</span>
            <span class="scs-label">创建</span>
          </div>
        </div>

        <!-- 1.12: 团队空间才显示「授权范围」行 — 个人空间只读无 access
             control,授权范围恒为「仅所有者可见」,跟 owner row 信息重复,
             隐藏省垂直空间并视觉强化 personal ≠ team。授权范围 = 授权组 ∪
             个人授权用户;空状态只在两者都 0 时触发,显示「无授权」。 -->
        <div v-if="s.kind === 'shared'" class="sc-access">
          <span class="sc-access-label">授权范围:</span>
          <template v-if="accessSummary(s).groupIds.length + accessSummary(s).users.length === 0">
            <span class="sc-access-empty">无授权 — 只有管理员可访问</span>
          </template>
          <div v-else class="sc-access-avatars">
            <span
              v-for="gid in accessSummary(s).groupIds.slice(0, 3)"
              :key="`g-${gid}`"
              class="sc-access-avatar sc-access-avatar-group"
              :title="`组:${groupById[gid]?.name ?? gid}`"
            >
              {{ (groupById[gid]?.name ?? gid).slice(0, 1) }}
            </span>
            <span
              v-for="u in accessSummary(s).users.slice(0, Math.max(0, 5 - accessSummary(s).groupIds.slice(0, 3).length))"
              :key="`u-${u.id}`"
              class="sc-access-avatar sc-access-avatar-user"
              :title="u.name"
            >
              <UserAvatar
                :size="20"
                :label="u.name"
                :color="u.color ?? null"
                :avatar-kind="u.avatarKind ?? null"
                :avatar-ref="u.avatarRef ?? null"
                :user-id="u.id"
              />
            </span>
            <span
              v-if="accessSummary(s).groupIds.length + accessSummary(s).users.length > 5"
              class="sc-access-more"
            >+{{ accessSummary(s).groupIds.length + accessSummary(s).users.length - 5 }}</span>
          </div>
        </div>

        <div class="sc-actions">
          <!-- 左侧:归档时间元信息(仅归档卡片显示)。把"什么时候归档的"放在底部动作区,
               让归档状态一眼可读,不靠颜色滤镜判断。 -->
          <span v-if="s.archivedAt" class="sc-archived-meta">
            <span class="material-symbols-outlined">inventory_2</span>
            <span>归档于 {{ relativeTime(s.archivedAt) }}</span>
          </span>
          <span v-else class="sc-spacer" />

          <!-- 右侧:管理操作组(归档/删除)+ 进入箭头。两块物理分隔:
               管理操作用 hover 才显色的低调图标,箭头永远可见作为主操作入口。 -->
          <div class="sc-actions-group">
            <button
              v-if="s.kind !== 'personal' && !s.archivedAt"
              type="button"
              class="ra-btn"
              title="归档"
              @click.stop="onArchive(s)"
            >
              <span class="material-symbols-outlined">archive</span>
            </button>
            <button
              v-if="s.kind !== 'personal' && s.archivedAt"
              type="button"
              class="ra-btn"
              title="恢复"
              @click.stop="onUnarchive(s)"
            >
              <span class="material-symbols-outlined">unarchive</span>
            </button>
            <!-- 删除 — pageCount > 0 时 client-side disable(server 也会 409
                 兜底,见 adminSpaces.ts:302),tooltip 给出明确指引。归档空间
                 仍允许删除(归档案本身是降级冗余态,无需强制 unarchive→delete
                 两步);只是当 pageCount > 0 时同样 disable,因为空间里有活页
                 就跟活跃空间一样需要先清理。 -->
            <button
              v-if="s.kind !== 'personal'"
              type="button"
              class="ra-btn ra-btn-danger"
              :disabled="(s.pageCount ?? 0) > 0"
              :title="(s.pageCount ?? 0) > 0
                ? `还有 ${s.pageCount} 个页面,请先移走或删除`
                : '删除空间'"
              @click.stop="onDelete(s)"
            >
              <span class="material-symbols-outlined">delete</span>
            </button>
            <span v-else class="sc-locked" title="个人空间不可由管理员删除">
              <span class="material-symbols-outlined">lock</span>
            </span>
            <!-- 进入箭头 = 主操作,跟次级管理操作隔一段间距 -->
            <span class="sc-open" aria-hidden="true">
              <span class="material-symbols-outlined">arrow_forward</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="currentKindHasMore" class="load-more-row">
      <button
        type="button"
        class="btn ghost load-more-btn"
        :disabled="currentKindLoading"
        @click="loadMoreSpaces"
      >
        {{ currentKindLoading ? '加载中…' : '加载更多' }}
      </button>
    </div>
    </div>
  </div>
</template>

<style scoped>
.spaces-view { width: 100%; }
/* The card grid below auto-fills the available width — 2K shows
   4-5 columns, small viewports 1-2. No global max-width so manager
   lists can use the full main column. */
.view-content-wide { width: 100%; }

.sv-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.sv-header-text { min-width: 0; }
.sv-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.sv-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0; }
.sv-sub { font-size: 13px; color: var(--text-3); margin: 4px 0 0 0; }
.sv-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-sans, inherit);
  color: #FFFFFF;
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-md, 4px);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
  white-space: nowrap;
  flex-shrink: 0;
}
.sv-action:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.sv-action .material-symbols-outlined { font-size: 18px; }

.sv-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius-md, 4px);
  font-size: 14px;
  margin-bottom: 16px;
}

/* 1.12: 个人空间 tab 顶部 banner — 跟 SpaceEditView.se-info 同款视觉
   语言(accent-soft 底 + accent 文字 + subtle border)。让 admin 一进
   personal tab 立即看到「这里不能管理成员」,避免去找团队空间专用的
   功能按钮(归档 / 授权 / 成员)。`cottage` icon 跟空态 icon 保持一致,
   视觉上锚定个人空间主题。 */
.sv-personal-info {
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
  margin-bottom: 16px;
}
.sv-personal-info-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.sv-personal-info-text strong { font-weight: 600; }

/* 5.14 active filter chip — 跟 PeopleView active filters 区视觉一致 */
.sv-active-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding: 10px 14px;
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.sv-active-filters-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sv-filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill, 999px);
  color: var(--accent);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: filter var(--duration-fast) var(--ease-out);
}
.sv-filter-chip:hover {
  filter: brightness(0.96);
}
.sv-filter-chip:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.sv-filter-chip-icon { font-size: 14px; }
.sv-filter-chip-close {
  font-size: 14px;
  margin-left: 2px;
  color: var(--accent);
  opacity: 0.65;
}
.sv-filter-chip:hover .sv-filter-chip-close { opacity: 1; }
.sv-filter-result-count {
  font-size: 12px;
  color: var(--text-3);
  margin-left: auto;
}

.sv-loading {
  padding: 60px 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}

/* ─── Create panel ─── */
.create-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 20px 24px;
  margin-bottom: 16px;
}
.cp-title { font-size: 16px; font-weight: 600; color: var(--text-1); margin: 0 0 12px 0; }
.cp-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 8px 12px;
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  margin: 0 0 12px 0;
}
.cp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 14px;
}
.cp-color-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
.field-input {
  height: 36px;
  padding: 0 10px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: var(--bg);
  border: 2px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.field-input:focus { border-color: var(--accent); }

.color-swatches { display: flex; gap: 6px; }
.cs-swatch {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}
.cs-swatch:hover { transform: scale(1.1); }
.cs-swatch-active { border-color: var(--text-1); }

.cp-actions { display: flex; gap: 8px; justify-content: flex-end; }

/* ─── Card grid ─── */
.sv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}
.sv-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 16px 20px;
  cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
  display: flex;
  flex-direction: column;
  gap: 12px;
  outline: none;
  position: relative;
}
.sv-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md, 0 4px 8px -2px rgba(9, 30, 66, 0.10), 0 0 1px rgba(9, 30, 66, 0.08));
  transform: translateY(-2px);
}
.sv-card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
/* P1-1: 归档卡片视觉降级 —— 让 admin 一眼扫到未归档/已归档的边界。
   - 整卡透明度降低(content 仍可读)
   - 左侧加一条 3px 暖灰色竖条作 "archived" ribbon
   - 头像 / 名字 颜色降饱和
   - 整张卡 hover 不再 translateY(避免给"可操作"暗示) */
.sv-card.is-archived {
  background: var(--bg-canvas);
  border-color: var(--border);
}
.sv-card.is-archived:hover {
  transform: none;
  box-shadow: none;
}
.sv-card.is-archived .sc-avatar {
  filter: grayscale(0.5);
  opacity: 0.65;
}
.sv-card.is-archived .sc-name {
  color: var(--text-3);
  text-decoration: line-through;
  text-decoration-color: var(--text-3);
  text-decoration-thickness: 1px;
}

.sc-head { display: flex; gap: 12px; align-items: flex-start; }
.sc-avatar {
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
.sc-icon { font-size: 22px !important; }
.sc-initials { letter-spacing: 0.5px; text-transform: uppercase; }
.sc-text { min-width: 0; }
.sc-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sc-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-kind-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 700;
  border-radius: 9px;
  letter-spacing: 0.02em;
}
.sc-kind-badge-personal {
  background: var(--accent-soft);
  color: var(--accent);
}
.sc-kind-badge-shared {
  background: var(--bg-canvas);
  color: var(--text-3);
}
.sc-kind-badge-archived {
  background: #856404;
  color: #fff;
  border: 1px solid #6b4f00;
  box-shadow: 0 0 0 2px rgba(133, 100, 4, 0.08);
}
.sc-desc { font-size: 13px; color: var(--text-3); margin-top: 2px; line-height: 1.4; }
.sc-owner {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.sco-icon { font-size: 14px !important; color: var(--text-3); }
.sco-label { color: var(--text-3); }
.sco-name { color: var(--text-2); font-weight: 600; }

.sc-stats { display: flex; gap: 20px; flex-wrap: wrap; }
.sc-stat { display: flex; flex-direction: column; min-width: 56px; }
.scs-value { font-size: 14px; font-weight: 600; color: var(--text-1); }
.scs-label { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }

.sc-access {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.sc-access-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.sc-access-empty {
  font-size: 12px;
  color: var(--danger);
  font-weight: 500;
}
.sc-access-avatars {
  display: flex;
  align-items: center;
  gap: 0;
}
/* 共享基础类:叠层叠圈效果(margin-left 负值 + bg 边框)。group
   单字母头像 / user 真实头像都用同一套尺寸 + 边框,视觉一致。
   22px content + 2px border = 26px 总尺寸。 */
.sc-access-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 2px solid var(--bg);
  margin-left: -6px;
  overflow: hidden;
}
.sc-access-avatar:first-child { margin-left: 0; }
.sc-access-avatar-group {
  background: var(--accent);
  color: #FFFFFF;
  font-size: 11px;
  font-weight: 700;
}
/* user 头像 wrapper,包 UserAvatar。UserAvatar 内部 size-20 设了 20×20
   (scoped CSS 优先级高于这里,无法覆盖),所以 wrapper 是 22×22 content,
   UserAvatar 居中即可,视觉上跟 group 头像同尺寸(20+1px×2+2px×2
   border 看起来一致)。背景由 UserAvatar 自身决定(image / initials),
   wrapper 不强制 background。 */
.sc-access-avatar-user {
  padding: 0;
}
.sc-access-more {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-3);
  font-weight: 600;
}

.sc-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /* 顶部加细分隔线,跟 stats 区视觉分组 */
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
/* 占位 spacer:无归档时间时让 actions-group 仍右对齐 */
.sc-spacer { flex: 1; }
/* 归档时间元信息 — 跟主操作分两侧,左侧打底色 + 小图标 */
.sc-archived-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #856404;
  flex: 1;
  min-width: 0;
}
.sc-archived-meta .material-symbols-outlined { font-size: 14px !important; }
/* 管理操作 + 进入箭头 —— 物理分隔:管理操作互贴(共同组合),
   进入箭头独立 margin-left,表达"主操作 vs 次操作"层级 */
.sc-actions-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.sc-actions-group .sc-open { margin-left: 6px; padding-left: 8px; border-left: 1px solid var(--border); }
.sc-locked {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-3);
  opacity: 0.5;
}
.sc-locked .material-symbols-outlined { font-size: 16px; }
.ra-btn {
  width: 28px;
  height: 28px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  cursor: pointer;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
/* 中性 hover — 归档/恢复走这条 */
.ra-btn:hover { background: var(--bg-subtle); color: var(--text-2); }
/* 危险 hover — 仅 delete 走这条(.ra-btn-danger)。原版本所有 .ra-btn 都
   走 danger 色,把"归档"和"删除"的视觉权重拉平,导致归档看起来比实际更
   危险。Modifier 把颜色绑到真正不可逆的动作上,跟 .btn.danger 的视觉
   约定对齐。 */
.ra-btn.ra-btn-danger:hover { background: var(--danger-soft); color: var(--danger); }
/* disabled 状态 —— 不允许 hover 跳色、整按钮半透明、cursor 改 not-allowed,
   跟 button reset 一致(:disabled 仍接收 :hover 事件,故需要 :hover override
   一并覆盖回中性 — 否则 hover 仍会变红,但 click 已 dead,体验更糟)。 */
.ra-btn:disabled,
.ra-btn:disabled:hover {
  opacity: 0.4;
  cursor: not-allowed;
  background: transparent;
  color: var(--text-3);
}
.ra-btn .material-symbols-outlined { font-size: 18px; }
/* 进入箭头 = 主操作入口,跟左侧管理按钮(归档/删除)分隔开。
   hover 时变 accent 色块,跟卡片整体 hover 联动。 */
.sc-open {
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm, 3px);
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.sc-open .material-symbols-outlined { font-size: 18px; }
.sv-card:hover .sc-open { background: var(--accent-soft); color: var(--accent); }

/* "Load more" footer (Stage B.1) — shared with PeopleView. */
.load-more-row {
  display: flex;
  justify-content: center;
  padding: 24px 0 8px;
}
.load-more-btn {
  min-width: 200px;
  height: 36px;
  padding: 0 18px;
}
.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
