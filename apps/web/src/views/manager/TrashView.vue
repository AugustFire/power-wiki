<script setup lang="ts">
/**
 * TrashView — Stage 5d.
 *
 * Soft-deleted pages for a chosen space, with restore / permanent-delete
 * per row AND batch operations. New in 5d:
 *   - Top toolbar: title search, 删除者 filter, sort, refresh
 *   - Checkbox column with select-all; selection drives a floating
 *     bottom action bar (批量恢复 / 批量永久删除)
 *   - Filtered / sorted client-side from the loaded trash list
 *
 * Single-component route (no right context panel) because the toolbar
 * + table is the action surface.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { debounce } from '@/lib/debounce'
import { api, ApiError } from '@/lib/api'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { useConfirm } from '@/composables/useConfirm'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import KindTabs from '@/components/manager/KindTabs.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import type { PageNode, User } from '@power-wiki/shared'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const uiStore = useUiStore()
const { confirm } = useConfirm()
useDocumentTitle(() => '回收站')

/* ─── P1-8: 回收站保留期设置 ─────────────────────────────────────
 *   拉一次 GET /admin/settings/trash_retention_days,挂在 trash 列表上方
 *   一张「自动清理策略」卡片,admin 可改;改完下一次 GET /pages/trash
 *   就照新值清理(后端 lazy purge)。
 *
 *   v2 交互打磨:
 *     - 记 originalDays(服务端当前值);retentionDays !== originalDays 时
 *       才算 dirty,保存按钮会自动 disable,点也走 short-circuit 不发请求。
 *       替代"按钮永远能点 → 用户随手点一下也中 reset"那个老 bug。
 *     - justSaved 在请求成功后置位 ~1.8s:按钮变绿 + 「✓ 已保存」,
 *       给用户离按钮最近的反馈,不再只靠右下 toast。超时后回落到「保存」。
 *     - dirty 时旁边出「尚未保存」提示,引导用户下一步。 */
type RetentionPreset = 0 | 7 | 30 | 90 | 180
const RETENTION_PRESETS: { value: RetentionPreset; label: string }[] = [
  { value: 0, label: '永不清' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 180, label: '180 天' },
]
const retentionDays = ref<number | null>(null)
const originalDays = ref<number | null>(null)
const retentionLoaded = ref(false)
const retentionSaving = ref(false)
const retentionCustom = ref<string>('')
const justSaved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

async function loadRetention() {
  try {
    const s = await api.admin.settings.get('trash_retention_days')
    retentionDays.value = Number(s.value)
    retentionCustom.value = retentionDays.value === 0 ? '' : String(retentionDays.value)
    originalDays.value = retentionDays.value
    retentionLoaded.value = true
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      // 未知 key,把它视作 30 天(默认值)
      retentionDays.value = 30
      retentionCustom.value = '30'
      originalDays.value = 30
      retentionLoaded.value = true
    } else {
      // 网络错误不阻塞主流程,卡片留 loading 状态
      console.warn('[trash] load retention failed', e)
    }
  }
}

function applyPreset(v: RetentionPreset) {
  retentionDays.value = v
  retentionCustom.value = v === 0 ? '' : String(v)
}

function onCustomInput() {
  // 解析 custom 数字 → 写回 retentionDays。空 / 非法 → 不动。
  // v-model 配 type="number" 会把值转成 number,所以要 String() 包一下。
  const t = String(retentionCustom.value ?? '').trim()
  if (t === '') {
    // 留空 = 视作 0(永不清),但只在点击保存时才落定
    retentionDays.value = 0
    return
  }
  const n = Number(t)
  if (Number.isInteger(n) && n >= 0 && n <= 36500) {
    retentionDays.value = n
  }
}

const dirty = computed(
  () =>
    retentionDays.value != null &&
    originalDays.value != null &&
    retentionDays.value !== originalDays.value,
)

async function saveRetention() {
  // 防御性 short-circuit:即便按钮被外部强制 enabled,也不打无意义的 PATCH,
  // 也不出没意义的 toast。
  if (retentionSaving.value) return
  if (!dirty.value || retentionDays.value == null) return
  retentionSaving.value = true
  try {
    await api.admin.settings.update('trash_retention_days', {
      value: retentionDays.value,
    })
    // 写 baseline,触发 dirty → false,按钮自动变回 disabled 状态
    originalDays.value = retentionDays.value
    // 不出 toast — justSaved 按钮态(绿底「✓ 已保存」1.8s)已是反馈,
    // 见 `docs/loading-ux.md` 第 17 节「反馈通道规约」。
    if (savedTimer != null) clearTimeout(savedTimer)
    justSaved.value = true
    savedTimer = setTimeout(() => {
      justSaved.value = false
      savedTimer = null
    }, 1800)
  } catch (e) {
    // 失败走 banner(阻塞性错误,admin 必须看到)而非 toast —
    // 对齐其他 admin 视图(PeopleView / SpacesView / SpaceEditView 等)。
    uiStore.setError(e instanceof ApiError ? `保存失败: ${e.code}` : '保存失败')
  } finally {
    retentionSaving.value = false
  }
}

type KindTab = 'shared' | 'personal'
const kindTab = ref<KindTab>('shared')

// Space list filtered by the active tab — drives both the count badges on
// the tabs and the `<select>` dropdown. admins see both kinds, but the UX
// cleanly partitions them so they aren't sifting through every user's
// personal space to find a shared one.
const sharedSpaces = computed(() => spacesStore.spaces.value.filter((s) => s.kind === 'shared'))
const personalSpaces = computed(() => spacesStore.spaces.value.filter((s) => s.kind === 'personal'))
const tabSpaces = computed(() =>
  kindTab.value === 'shared' ? sharedSpaces.value : personalSpaces.value,
)

const selectedSpaceId = ref<string>(spacesStore.activeSpaceId.value ?? '')
const busy = ref<Set<string>>(new Set())

/* ─── Toolbar state ─── */
const searchText = ref('')
const deletedByFilter = ref<string>('all') // 'all' | userId | 'unknown'
type SortKey = 'newest' | 'oldest' | 'title-asc' | 'title-desc'
const sortKey = ref<SortKey>('newest')

const allUsers = ref<User[]>([])
/** Lazy-load all users for the 删除者 filter on first focus — admins
 *  rarely need this list, so we skip the round-trip when the dropdown
 *  is never opened. */
const allUsersLoaded = ref(false)
async function ensureAllUsersLoaded() {
  if (allUsersLoaded.value) return
  allUsersLoaded.value = true
  try {
    // B.3: ?limit=200 caps the payload (no real team has 200+ users
    // — admin-side UI users are a small set). The full admin user
    // list is needed for the "filter by delete-r" dropdown.
    allUsers.value = (await api.admin.users.list({ limit: 200 })).items
  } catch {
    /* non-fatal — filter dropdown will just show "all" */
  }
}

// Trash loads exactly once per selectedSpaceId change. We don't use
// `watch(..., { immediate: true })` because at mount time `selectedSpaceId`
// may be the stale localStorage activeSpaceId (often admin's personal space)
// — the onMounted hook below then re-picks the first shared space, and
// the watch fires AGAIN. That's 2 redundant /api/pages/trash calls.
// Instead: loadTrash runs only from onMounted + kindTab/space-id watchers.
// P1-15 · loadTrash 现在透传 trashFilterParams(search / filter / sort);
// 未改动时 = 全空对象 ≡ 不过滤(服务端 router 把空 q / undefined 视为不过滤)。
async function loadTrashFor(id: string) {
  if (id) await pagesStore.loadTrash(id, trashFilterParams.value)
}

onMounted(async () => {
  if (!spacesStore.loaded) await spacesStore.init()
  // Default the space picker to a shared-space id (kind='shared') — the
  // active tab defaults to 'shared'. Falls back to the first space of
  // any kind if shared is empty.
  if (!selectedSpaceId.value || !tabSpaces.value.some((s) => s.id === selectedSpaceId.value)) {
    selectedSpaceId.value = tabSpaces.value[0]?.id ?? spacesStore.spaces.value[0]?.id ?? ''
  }
  // Run the initial load exactly once.
  void loadTrashFor(selectedSpaceId.value)
  // P1-8: 拉一次保留期设置(不阻塞主加载)
  void loadRetention()
})

watch(kindTab, () => {
  // Switching tab invalidates the previous space selection (it was scoped
  // to the other kind). Pick the first space of the new tab if available.
  if (!tabSpaces.value.some((s) => s.id === selectedSpaceId.value)) {
    selectedSpaceId.value = tabSpaces.value[0]?.id ?? ''
  }
  // 5.9: 同步 reset 其他 filter — shared tab 选「工程」+ 输入「草稿」+ 选
  // 删除者后切到 personal tab,前 3 个 filter 仍生效但无数据,用户会以为
  // 是 bug。Reset 到 default 让「切 tab = 看全部」语义可预测。
  searchText.value = ''
  deletedByFilter.value = 'all'
  sortKey.value = 'newest'
})

watch(selectedSpaceId, (id) => {
  // P1-15 · 切空间时清空选中 + 透传 filter 给后端(loadTrashFor
  // 现在内部用 trashFilterParams,filter 由 watch search/dele/sort
  // 别的 watch 触发,不需要每次重传)。
  if (id) {
    clearSelection()
    void pagesStore.loadTrash(id, trashFilterParams.value)
  }
})

/* ─── Filtered + sorted view of the store's trashed list ─── */
const rows = computed(() => pagesStore.trashed)
/* P1-15 · 服务端化筛选 + 批量操作。rows 直接是 store.trashed
 * (跟 store source of truth 同源),`pagesStore.trashTotal` 是
 * 筛后总行数,`selectedIds` 跨页持续(切页 / 刷新清空)。
 * searchText / deletedBy / sortKey 改动 → debouncedReloadTrash
 * 250ms 后重新拉第一页。*/
const totalTrash = computed(() => pagesStore.trashTotal || rows.value.length)
const selectedIds = ref<Set<string>>(new Set())
const batchBusy = ref(false)
const selectedCount = computed(() => selectedIds.value.size)
const allOnPageSelected = computed(() =>
  rows.value.length > 0 && rows.value.every((r) => selectedIds.value.has(r.id)),
)
const someOnPageSelected = computed(() =>
  rows.value.length > 0 && rows.value.some((r) => selectedIds.value.has(r.id)),
)
function toggleSelected(id: string): void {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}
function toggleSelectAll(): void {
  const next = new Set(selectedIds.value)
  const ids = rows.value.map((r) => r.id)
  const allSelected = ids.every((id) => next.has(id))
  if (allSelected) {
    for (const id of ids) next.delete(id)
  } else {
    for (const id of ids) next.add(id)
  }
  selectedIds.value = next
}
function clearSelection(): void {
  selectedIds.value = new Set()
}
const trashFilterParams = computed(() => {
  const sk = sortKey.value
  const sb: 'deletedAt' | 'title' =
    sk === 'title-asc' || sk === 'title-desc' ? 'title' : 'deletedAt'
  const di: 'asc' | 'desc' =
    sk === 'oldest' || sk === 'title-asc' ? 'asc' : 'desc'
  return {
    q: searchText.value.trim() || undefined,
    deletedBy: deletedByFilter.value === 'all' ? undefined : deletedByFilter.value,
    sortBy: sb,
    dir: di,
  }
})
const debouncedReloadTrash = debounce(() => {
  if (!selectedSpaceId.value) return
  void pagesStore.loadTrash(selectedSpaceId.value, trashFilterParams.value)
}, 250)
watch(searchText, () => debouncedReloadTrash())
watch([deletedByFilter, sortKey], () => {
  if (!selectedSpaceId.value) return
  void pagesStore.loadTrash(selectedSpaceId.value, trashFilterParams.value)
})

function parentRow(node: { parentId: string | null }) {
  if (!node.parentId) return null
  return rows.value.find((row) => row.id === node.parentId) ?? pagesStore.getPage(node.parentId) ?? null
}

function parentIsTrashed(node: { parentId: string | null }): boolean {
  return parentRow(node)?.deletedAt != null
}

function relativeTime(ts: number): string {
  return formatRelativeTime(ts)
}

function deletedByLabel(id: string | null | undefined): string {
  if (!id) return '未知'
  if (id === 'me') return '旧数据'
  const u = allUsers.value.find((x) => x.id === id)
  return u ? `${u.name} (${u.email})` : id
}

async function onRestore(id: string) {
  const next = new Set(busy.value)
  next.add(id)
  busy.value = next
  try {
    await pagesStore.restorePage(id)
    uiStore.clearError()
  } catch {
    /* banner handled by store */
  } finally {
    const after = new Set(busy.value)
    after.delete(id)
    busy.value = after
  }
}

async function onPurge(id: string, title: string) {
  const ok = await confirm({
    title: `永久删除「${title}」?`,
    message: '此操作不可恢复,将从数据库中物理删除该页面及其所有已删除的子页面。',
    details: [
      '页面版本、标签、限制、分享、评论和附件关联会一并清理。',
      '删除后的页面不能恢复。',
    ],
    danger: true,
    size: 'wide',
    confirmText: '永久删除',
    cancelText: '取消',
  })
  if (!ok) return
  const next = new Set(busy.value)
  next.add(id)
  busy.value = next
  try {
    await pagesStore.purgePage(id)
  } catch {
    /* banner handled by store */
  } finally {
    const after = new Set(busy.value)
    after.delete(id)
    busy.value = after
  }
}

/* ─── P1-15 · 批量恢复 / 批量永久删除 ──────────────────────────────
 * 没有 bulk 端点(避免后端事务化复杂度 + N 节点删除原子性边界 case)——
 * 沿用单点 API,但在小批次内并发执行:
 *   - restore:每页 / 每行的恢复都是独立 200/parent_trashed 响应,
 *     Promise.allSettled 拿全部结果,failures 收集弹 toast。
 *   - purge:循环调用 pagesStore.purgePage(id),admin 已确认意图
 *     (用 confirm-dialog 集中确认),不再单条 confirm。
 *
 * 进度反馈:batchBusy 锁 UI,batchProgress 走 toast 文本(进/总)。
 * 选中跨页持续,所以「选 N 个删 M 个」是分页敏感——只要后端真删了
 * 前端本地 set 自然清理已删 ids(通过 pagesStore trash 列表刷新)。*/
async function batchRestore(): Promise<void> {
  if (selectedCount.value === 0 || batchBusy.value) return
  batchBusy.value = true
  const ids = [...selectedIds.value]
  let ok = 0, fail = 0
  const failedIds: string[] = []
  // 串行:parent_trashed(409) 错乱序并发会互相阻塞;串行保证依赖链稳定。
  for (const id of ids) {
    try {
      await pagesStore.restorePage(id)
      ok++
      const next = new Set(selectedIds.value)
      next.delete(id)
      selectedIds.value = next
    } catch (e) {
      fail++
      failedIds.push(id)
      const msg = e instanceof ApiError && e.code === 'parent_trashed'
        ? '父页面尚未恢复'
        : e instanceof Error ? e.message : '操作失败'
      console.warn(`[trash] batch restore ${id} failed: ${msg}`)
    }
  }
  batchBusy.value = false
  uiStore.notify(
    fail === 0
      ? `已批量恢复 ${ok} 个页面`
      : `批量恢复完成:${ok} 成功 / ${fail} 失败(可能是父级未恢复)`,
  )
  // 成功后 reload 一次拉最新服务端状态(rows 跟 trashTotal)
  if (selectedSpaceId.value) {
    await pagesStore.loadTrash(selectedSpaceId.value, trashFilterParams.value)
  }
}

async function batchPurge(): Promise<void> {
  if (selectedCount.value === 0 || batchBusy.value) return
  // 列出可能受影响的范围:选中 ids + 它们的子页(被 purge 时一并消失)。
  // 实际上子页不会出现在 trash 视图(只显示顶层),所以用户视角只有 N 个。
  // 这里只警告「不可恢复」就够,具体 scope 由后端实际清扫面积决定。
  const ok = await confirm({
    title: `永久删除 ${selectedCount.value} 个页面?`,
    message: '此操作不可恢复,将从数据库中物理删除这些页面及其所有已删除的子页面。',
    details: [
      '页面版本、标签、限制、分享、评论和附件关联会一并清理。',
      '选中项之间互相独立的子级(若有)也会一起删除。',
    ],
    requireText: selectedCount.value > 1 ? '确认删除' : undefined,
    confirmText: `永久删除 ${selectedCount.value} 个`,
    cancelText: '取消',
    danger: true,
    size: 'wide',
  })
  if (!ok) return
  batchBusy.value = true
  const ids = [...selectedIds.value]
  let okCount = 0, failCount = 0
  // 串行同样 — 减少行锁 + 后端 cascade 顺序错乱
  for (const id of ids) {
    try {
      await pagesStore.purgePage(id)
      okCount++
      const next = new Set(selectedIds.value)
      next.delete(id)
      selectedIds.value = next
    } catch (e) {
      failCount++
      const msg = e instanceof Error ? e.message : '操作失败'
      console.warn(`[trash] batch purge ${id} failed: ${msg}`)
    }
  }
  batchBusy.value = false
  uiStore.notify(
    failCount === 0
      ? `已批量永久删除 ${okCount} 个页面`
      : `批量删除完成:${okCount} 成功 / ${failCount} 失败`,
  )
  if (selectedSpaceId.value) {
    await pagesStore.loadTrash(selectedSpaceId.value, trashFilterParams.value)
  }
}
</script>

<template>
  <div class="trash-view">
    <div class="view-content">
    <header class="trash-header">
      <div class="title-block">
        <h1 class="title">回收站</h1>
        <p class="subtitle">软删除的页面。恢复会按原父级放回;父级也已被删除时,需要先恢复父级。</p>
      </div>
      <div class="controls">
        <KindTabs
          v-model="kindTab"
          :shared-count="sharedSpaces.length"
          :personal-count="personalSpaces.length"
        />
        <label class="select-wrap">
          <span>空间</span>
          <select v-model="selectedSpaceId">
            <option v-for="s in tabSpaces" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </label>
        <button
          class="refresh-btn"
          :disabled="pagesStore.trashLoading"
          @click="pagesStore.loadTrash(selectedSpaceId)"
        >
          <span
            class="material-symbols-outlined icon-md"
            :class="{ 'is-loading': pagesStore.trashLoading }"
          >refresh</span>
          刷新
        </button>
      </div>
    </header>

    <!-- Toolbar: search / filter / sort -->
    <div class="trash-toolbar">
      <div class="tt-search">
        <span class="material-symbols-outlined tt-search-icon">search</span>
        <input
          v-model="searchText"
          type="text"
          class="tt-search-input"
          placeholder="按标题搜索"
        />
      </div>
      <label class="tt-select">
        <span>删除者</span>
        <select v-model="deletedByFilter" @focus="ensureAllUsersLoaded">
          <option value="all">全部</option>
          <option value="unknown">未知</option>
          <option v-for="u in allUsers" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
      </label>
      <label class="tt-select">
        <span>排序</span>
        <select v-model="sortKey">
          <option value="newest">最近删除</option>
          <option value="oldest">最早删除</option>
          <option value="title-asc">标题 A→Z</option>
          <option value="title-desc">标题 Z→A</option>
        </select>
      </label>
      <div class="tt-count">
        共 {{ rows.length }} 项
      </div>
    </div>

    <!-- P1-8: 保留期策略 -->
    <section v-if="retentionLoaded" class="retention-card" aria-label="回收站保留期">
      <div class="retention-head">
        <span class="material-symbols-outlined ret-icon">schedule</span>
        <div class="ret-title-block">
          <h3 class="ret-title">自动清理策略</h3>
          <p class="ret-sub">
            <template v-if="retentionDays === 0">
              永不自动清理 — 需要 admin 手动永久删除。
            </template>
            <template v-else>
              软删除超过
              <strong>{{ retentionDays }}</strong>
              天的页面会在下次打开回收站时自动永久删除。
            </template>
          </p>
        </div>
      </div>
      <div class="ret-controls">
        <div class="ret-presets" role="radiogroup" aria-label="保留期预设">
          <button
            v-for="p in RETENTION_PRESETS"
            :key="p.value"
            type="button"
            class="ret-chip"
            :class="{ active: retentionDays === p.value }"
            role="radio"
            :aria-checked="retentionDays === p.value"
            @click="applyPreset(p.value)"
          >
            {{ p.label }}
          </button>
        </div>
        <label class="ret-custom">
          <span>自定义</span>
          <input
            v-model="retentionCustom"
            type="number"
            min="0"
            max="36500"
            step="1"
            placeholder="天数"
            @input="onCustomInput"
          />
          <span class="ret-unit">天</span>
        </label>
        <div class="ret-actions">
          <span v-if="dirty && !retentionSaving && !justSaved" class="ret-dirty-hint">
            <span class="material-symbols-outlined icon-sm">edit</span>
            尚未保存
          </span>
          <button
            class="ret-save"
            :class="{ 'is-saved': justSaved }"
            :disabled="retentionSaving || !dirty"
            @click="saveRetention"
          >
            <template v-if="retentionSaving">
              <span class="material-symbols-outlined icon-sm is-loading">progress_activity</span>
              保存中…
            </template>
            <template v-else-if="justSaved">
              <span class="material-symbols-outlined icon-sm">check</span>
              已保存
            </template>
            <template v-else>
              保存
            </template>
          </button>
        </div>
      </div>
    </section>

    <EmptyState
      v-if="rows.length === 0"
      icon="delete_sweep"
      :title="searchText || deletedByFilter !== 'all' ? '没有匹配的页面' : '该空间没有已删除的页面'"
      :hint="searchText || deletedByFilter !== 'all' ? '试试清除筛选条件。' : '用户删除的页面会出现在这里。'"
      :variant="searchText || deletedByFilter !== 'all' ? 'no-results' : 'no-data'"
      size="sm"
    />
    <EmptyState
      v-else-if="tabSpaces.length === 0"
      :icon="kindTab === 'shared' ? 'workspaces' : 'cottage'"
      :title="kindTab === 'shared' ? '还没有团队空间' : '还没有个人空间'"
      :hint="kindTab === 'shared'
        ? '创建空间以按团队 / 项目组织页面。'
        : '每个用户首次登录时会自动创建个人空间(草稿区),管理员无需手动创建。'"
      variant="no-data"
      size="sm"
    />

    <table v-else class="trash-table">
      <thead>
        <tr>
          <th class="col-check">
            <label class="trash-check">
              <input
                type="checkbox"
                :checked="allOnPageSelected"
                :indeterminate.prop="someOnPageSelected && !allOnPageSelected"
                :disabled="rows.length === 0"
                @change="toggleSelectAll"
              />
            </label>
          </th>
          <th class="col-title">页面</th>
          <th class="col-by">删除者</th>
          <th class="col-when">删除时间</th>
          <th class="col-actions">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          :class="{ busy: busy.has(row.id), selected: selectedIds.has(row.id) }"
        >
          <td class="col-check">
            <label class="trash-check">
              <input
                type="checkbox"
                :checked="selectedIds.has(row.id)"
                :disabled="batchBusy"
                @change="toggleSelected(row.id)"
              />
            </label>
          </td>
          <td class="col-title">
            <div class="title-cell">
              <span class="material-symbols-outlined doc-icon" style="font-size:18px">description</span>
              <span class="title-text">{{ row.title || '未命名' }}</span>
              <span v-if="row.parentId" class="parent-hint" :title="row.parentId">
                <span class="material-symbols-outlined" style="font-size:14px">subdirectory_arrow_right</span>
                <button
                  v-if="parentIsTrashed(row) && parentRow(row)"
                  type="button"
                  class="parent-restore-link"
                  @click="onRestore(parentRow(row)!.id)"
                >先恢复父级</button>
                <span v-else-if="parentIsTrashed(row)" class="parent-trashed">父级已删除</span>
                <span v-else>已挂载</span>
              </span>
            </div>
          </td>
          <td class="col-by">{{ deletedByLabel(row.deletedBy) }}</td>
          <td class="col-when">{{ row.deletedAt ? relativeTime(row.deletedAt) : '—' }}</td>
          <td class="col-actions">
            <button
              class="row-btn restore"
              :disabled="busy.has(row.id) || parentIsTrashed(row) || batchBusy"
              :title="parentIsTrashed(row) ? '请先恢复父级' : '恢复到原位置'"
              @click="onRestore(row.id)"
            >
              <span class="material-symbols-outlined icon-sm">restore</span>
              恢复
            </button>
            <button
              class="row-btn danger"
              :disabled="busy.has(row.id) || batchBusy"
              title="永久删除(不可恢复)"
              @click="onPurge(row.id, row.title)"
            >
              <span class="material-symbols-outlined icon-sm">delete_forever</span>
              永久删除
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- P1-15 · 选中计数 + 「加载更多」footer。counter 用 pagesStore.trashTotal
         (服务端筛后总行数),不再是「rows.length」(loaded only)。
         「加载更多」仍在(append,跟服务端的 cursor 一致,选中的 ids
         跨页持续 —— 选中一条「首页父级」、一条「已加载到第 3 页」是合法 UX)。-->
    <div v-if="rows.length > 0 || totalTrash > 0" class="load-more-row">
      <span class="trash-counter">
        显示 <strong>{{ rows.length }}</strong> / 共 <strong>{{ totalTrash }}</strong> 项
      </span>
      <button
        v-if="pagesStore.trashHasMore"
        type="button"
        class="btn ghost load-more-btn"
        :disabled="pagesStore.trashLoadingMore"
        @click="pagesStore.loadMoreTrash(selectedSpaceId, trashFilterParams)"
      >
        {{ pagesStore.trashLoadingMore ? '加载中…' : '加载更多' }}
      </button>
      <div v-else class="load-more-end">— 已加载全部 —</div>
    </div>

    <!-- P1-15 · batch action bar — fixed 底部,只在有选中时出现。
         选中 N 个 + 列表交互无冲突:单独行的恢复 / 永久删除按钮
         仍可用,这里只处理选中整批的快捷路径。整批恢复 / 删除 用
         confirm dialog 二次确认(批量永久删除 requireText='确认删除'
         强校验),防止误触。-->
    <Transition name="batchbar">
      <div v-if="selectedCount > 0" class="trash-batchbar" role="region" aria-label="批量操作">
        <div class="trash-batchbar-info">
          <span class="trash-batchbar-count">已选 <strong>{{ selectedCount }}</strong> 项</span>
          <button type="button" class="trash-batchbar-clear" @click="clearSelection">清空选择</button>
        </div>
        <div class="trash-batchbar-actions">
          <button
            type="button"
            class="batchbar-btn primary"
            :disabled="batchBusy"
            @click="batchRestore"
          >
            <span class="material-symbols-outlined icon-sm">restore</span>
            批量恢复 ({{ selectedCount }})
          </button>
          <button
            type="button"
            class="batchbar-btn danger"
            :disabled="batchBusy"
            @click="batchPurge"
          >
            <span class="material-symbols-outlined icon-sm">delete_forever</span>
            批量永久删除
          </button>
        </div>
      </div>
    </Transition>
    </div>
  </div>
</template>

<style scoped>
.trash-view { width: 100%; }
/* Fills the available .manager-main column on 2K. */
.view-content { width: 100%; }

.trash-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.title-block .title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 4px;
}
.title-block .subtitle {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
}

.controls { display: flex; align-items: center; gap: 12px; }
.select-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
}
.select-wrap select {
  height: 32px;
  padding: 0 24px 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.refresh-btn:hover { background: var(--bg-subtle); color: var(--text-1); }
.refresh-btn:disabled { opacity: 0.7; cursor: wait; }
.refresh-btn .icon-md.is-loading {
    animation: refresh-spin 0.9s linear infinite;
}
@keyframes refresh-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
}

/* ─── Toolbar ─── */
.trash-toolbar {
  display: grid;
  grid-template-columns: 1fr 180px 180px auto;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}
.tt-search {
  position: relative;
  display: flex;
  align-items: center;
}
.tt-search-icon {
  position: absolute;
  left: 10px;
  font-size: 18px;
  color: var(--text-3);
  pointer-events: none;
}
.tt-search-input {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 36px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.tt-search-input:focus { border-color: var(--accent); }

.tt-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
}
.tt-select select {
  flex: 1;
  height: 36px;
  padding: 0 24px 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  min-width: 0;
}
.tt-count {
  font-size: 13px;
  color: var(--text-3);
  white-space: nowrap;
  justify-self: end;
}

/* ─── Table ─── */
.trash-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  overflow: hidden;
  font-size: 14px;
}
.trash-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 10px 16px;
  background: var(--bg-canvas);
  border-bottom: 1px solid var(--border);
}
.trash-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
  vertical-align: middle;
  font-size: 13px;
}

/* ─── P1-8 retention policy card ─── */
.retention-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  margin-bottom: 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  box-shadow: var(--shadow-sm);
}
.retention-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.ret-icon {
  font-size: 20px;
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.ret-title-block { flex: 1; min-width: 0; }
.ret-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 2px;
}
.ret-sub {
  font-size: 12.5px;
  color: var(--text-3);
  margin: 0;
  line-height: 1.5;
}
.ret-sub strong { color: var(--text-1); font-weight: 600; }
.ret-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.ret-presets {
  display: inline-flex;
  gap: 6px;
}
.ret-chip {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill, 999px);
  background: var(--bg);
  color: var(--text-2);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.ret-chip:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.ret-chip.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 500;
}
.ret-custom {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-3);
}
.ret-custom input {
  width: 80px;
  height: 30px;
  padding: 0 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  text-align: right;
}
.ret-custom input:focus { border-color: var(--accent); }
.ret-unit { color: var(--text-3); }
.ret-save {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-md, 4px);
  background: var(--accent);
  color: var(--text-invert);
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background-color var(--duration-fast, 120ms) var(--ease-out, ease-out);
}
.ret-save:hover:not(:disabled) { filter: brightness(0.95); }
.ret-save:disabled { opacity: 0.5; cursor: not-allowed; }
.ret-save.is-saved {
  /* 已保存短暂确认色 — 用 Atlassian 绿,跟「创建」chip 同色,
     跟蓝主按钮拉开,减少「成功 vs 蓝主按钮」混淆 */
  background: var(--success);
}
.ret-save.is-saved:hover:not(:disabled) { filter: brightness(0.95); }
.ret-save .icon-sm.is-loading {
  animation: retention-spin 0.9s linear infinite;
}
.ret-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.ret-dirty-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-3);
  font-style: italic;
}
.ret-dirty-hint .icon-sm { font-size: 14px; }
@keyframes retention-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.trash-table tr:last-child td { border-bottom: none; }
.trash-table tr.busy { opacity: 0.6; }
/* P1-15 · 选中行视觉 —— 跟原 Atlassian admin 表格「选中态」一致:
 * accent-soft 浅蓝底 + 左侧 2px accent 竖线 + 表内全部 *-check checkbox
 * 维持 accent 主色。hover 在选中行也覆盖默认底色,防止 hover 看起来像
 * 取消选中(tr.tbody tr:hover:bg 太朴素)。*/
.trash-table tr.selected {
  background: var(--accent-soft);
}
.trash-table tr.selected:hover { background: var(--accent-soft); }
.trash-table tr.selected td.col-check { position: relative; }
.trash-table tr.selected td.col-check::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--accent);
}

/* P1-15 · checkbox 列 —— 32px 定宽,vertical center,跟后面 col-title
 * 共享同一基线。checkbox 14×14 比 nav checkbox 略小,跟表格行高匹配。*/
.col-check {
  width: 32px;
  text-align: center;
  vertical-align: middle;
  padding-left: 12px !important;
  padding-right: 0 !important;
}
.trash-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.trash-check input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.col-title { width: auto; }
.col-by { width: 200px; color: var(--text-2); }
.col-when { width: 160px; color: var(--text-2); }
.col-actions { width: 200px; text-align: right; white-space: nowrap; }

/* P1-15 · counter + load more footer —— counter 显示「已加载 X / 共 N」,
 * 用 server 真实筛后总行数;load more 仍可点,append 后 counter 立即刷新
 * (pagesStore.trashed 长度变化自动触发)。*/
.trash-counter {
  font-size: 13px;
  color: var(--text-3);
}
.trash-counter strong {
  color: var(--text-1);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.title-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-1);
  font-weight: 500;
}
.title-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.parent-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}
.parent-trashed { color: var(--danger); font-weight: 500; }
.parent-restore-link {
  border: 0;
  padding: 0;
  color: var(--accent);
  background: transparent;
  cursor: pointer;
  font: inherit;
}
.parent-restore-link:hover { text-decoration: underline; }

.row-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  margin-left: 6px;
  transition: background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.row-btn:hover:not(:disabled) { background: var(--bg-subtle); color: var(--text-1); }
.row-btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* 行级动作按钮 —— 用文字色 + hover 软底色,边框走中性色。
 * 比「彩色边框」轻得多:复选框选中行底色已是 accent-soft,如果再
 * 给按钮叠 accent 边框就会跟选中态视觉打架,看起来像 2 个选中标记。*/
.row-btn.danger { color: var(--danger); }
.row-btn.danger:hover:not(:disabled) {
  background: var(--danger-soft, rgba(215, 58, 58, 0.1));
  border-color: var(--danger-soft, rgba(215, 58, 58, 0.2));
}
.row-btn.restore { color: var(--accent); }
.row-btn.restore:hover:not(:disabled) {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
}

/* "Load more" footer (Stage B.1) — shared with PeopleView / SpacesView. */
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
.load-more-end {
  font-size: 12px;
  color: var(--text-3);
  padding: 24px 0 8px;
}

/* P1-15 · batch action bar —— fixed 底部,sticky 在 footer 上方。
 * 选中 N 项时滑入(Transition),无选中时折叠恢复视区,
 * 不浪费空间。
 *
 * 视觉权衡:之前的 1px accent 边框 + 中性背景 太重(整个 admin
 * 后台只有这一个 accent 边框,会显得「这条 bar 在抢戏」)。改成
 * 中性边框 + 略深的 canvas 背景 + elevation,让 bar 看起来像「
 * 工具栏浮在内容上」,而不是「带描边的强调卡片」。按钮升级为
 * filled primary / filled danger,正好对应「这是 CTA 级别动作」
 * 的视觉权重。*/
.trash-batchbar {
  position: sticky;
  bottom: 16px;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  margin: 16px 24px;
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  box-shadow: var(--shadow-md);
  font-size: 13px;
  color: var(--text-1);
}
.trash-batchbar-info {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.trash-batchbar-count {
  color: var(--text-2);
}
.trash-batchbar-count strong {
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.trash-batchbar-clear {
  border: 0;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm, 3px);
  transition: color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.trash-batchbar-clear:hover {
  color: var(--text-1);
  background: var(--bg-subtle);
}
.trash-batchbar-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 底部 batch 按钮 —— 实心填充 primary / danger,跟行级 row-btn
 * (描边 + 软底)区分开。CTA 级别动作必须有明确的「可点」视觉,
 * 否则 30px 的高度 + 中性边框会被误认为 info chip。*/
.batchbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out),
    filter var(--duration-fast) var(--ease-out);
}
.batchbar-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.batchbar-btn.primary {
  background: var(--accent);
  color: var(--text-invert);
}
.batchbar-btn.primary:hover:not(:disabled) { filter: brightness(0.94); }
.batchbar-btn.danger {
  background: var(--danger);
  color: var(--text-invert);
}
.batchbar-btn.danger:hover:not(:disabled) { filter: brightness(0.94); }

/* batchbar Transition — 滑入 + 淡入,跟 Vue 默认 .<name>-enter / -leave-to
 * 规则对齐。*/
.batchbar-enter-active,
.batchbar-leave-active {
  transition: transform 180ms var(--ease-out, ease),
    opacity 180ms var(--ease-out, ease);
}
.batchbar-enter-from,
.batchbar-leave-to {
  transform: translateY(8px);
  opacity: 0;
}
.batchbar-enter-to,
.batchbar-leave-from {
  transform: translateY(0);
  opacity: 1;
}
</style>
