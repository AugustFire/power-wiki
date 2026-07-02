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
import { api, ApiError } from '@/lib/api'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { useConfirm } from '@/composables/useConfirm'
import { formatRelativeTime } from '@/lib/relativeTime'
import KindTabs from '@/components/manager/KindTabs.vue'
import type { PageNode, User } from '@power-wiki/shared'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const uiStore = useUiStore()
const { confirm } = useConfirm()

type KindTab = 'shared' | 'personal'
const kindTab = ref<KindTab>('shared')

// Space list filtered by the active tab — drives both the count badges on
// the tabs and the `<select>` dropdown. admins see both kinds, but the UX
// cleanly partitions them so they aren't sifting through every user's draft
// space to find a shared one.
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
async function loadTrashFor(id: string) {
  if (id) await pagesStore.loadTrash(id)
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
})

watch(kindTab, () => {
  // Switching tab invalidates the previous space selection (it was scoped
  // to the other kind). Pick the first space of the new tab if available.
  if (!tabSpaces.value.some((s) => s.id === selectedSpaceId.value)) {
    selectedSpaceId.value = tabSpaces.value[0]?.id ?? ''
  }
})

watch(selectedSpaceId, (id) => {
  // Skip the initial fire — onMounted already loaded trash for whatever
  // selectedSpaceId resolved to. Subsequent changes (tab switch, user
  // picker change) DO trigger reload.
  if (id) void loadTrashFor(id)
})

/* ─── Filtered + sorted view of the store's trashed list ─── */
const rows = computed(() => {
  const all = pagesStore.trashed
  const q = searchText.value.trim().toLowerCase()
  const filtered = all.filter((p) => {
    if (q && !(p.title || '').toLowerCase().includes(q)) return false
    if (deletedByFilter.value === 'unknown') {
      if (p.deletedBy != null) return false
    } else if (deletedByFilter.value !== 'all') {
      if (p.deletedBy !== deletedByFilter.value) return false
    }
    return true
  })
  const sorted = [...filtered]
  switch (sortKey.value) {
    case 'newest':
      sorted.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      break
    case 'oldest':
      sorted.sort((a, b) => (a.deletedAt ?? 0) - (b.deletedAt ?? 0))
      break
    case 'title-asc':
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'))
      break
    case 'title-desc':
      sorted.sort((a, b) => (b.title || '').localeCompare(a.title || '', 'zh-CN'))
      break
  }
  return sorted
})

/* Row-level busy state. A row is busy if it has a pending restore/purge
   request in flight (so we can disable the buttons + dim the row). */
function parentIsTrashed(node: { parentId: string | null }): boolean {
  if (node.parentId == null) return false
  const parent = pagesStore.getPage(node.parentId)
  return parent != null && parent.deletedAt != null
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
    danger: true,
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

    <div v-if="rows.length === 0" class="empty">
      <span class="material-symbols-outlined empty-icon">delete_sweep</span>
      <h2>{{ searchText || deletedByFilter !== 'all' ? '没有匹配的页面' : '该空间没有已删除的页面' }}</h2>
      <p>{{ searchText || deletedByFilter !== 'all' ? '试试清除筛选条件。' : '用户删除的页面会出现在这里。' }}</p>
    </div>
    <div v-else-if="tabSpaces.length === 0" class="empty">
      <span class="material-symbols-outlined empty-icon">
        {{ kindTab === 'shared' ? 'workspaces' : 'cottage' }}
      </span>
      <h2>{{ kindTab === 'shared' ? '还没有团队空间' : '还没有个人空间' }}</h2>
      <p v-if="kindTab === 'shared'">创建空间以按团队 / 项目组织页面。</p>
      <p v-else>每个用户在第一次登录时会自动创建一个个人空间(草稿区)。当前还没有任何用户。</p>
    </div>

    <table v-else class="trash-table">
      <thead>
        <tr>
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
          :class="{ busy: busy.has(row.id) }"
        >
          <td class="col-title">
            <div class="title-cell">
              <span class="material-symbols-outlined doc-icon" style="font-size:18px">description</span>
              <span class="title-text">{{ row.title || '未命名' }}</span>
              <span v-if="row.parentId" class="parent-hint" :title="row.parentId">
                <span class="material-symbols-outlined" style="font-size:14px">subdirectory_arrow_right</span>
                <span v-if="parentIsTrashed(row)" class="parent-trashed">父级已删除</span>
                <span v-else>已挂载</span>
              </span>
            </div>
          </td>
          <td class="col-by">{{ deletedByLabel(row.deletedBy) }}</td>
          <td class="col-when">{{ row.deletedAt ? relativeTime(row.deletedAt) : '—' }}</td>
          <td class="col-actions">
            <button
              class="row-btn restore"
              :disabled="busy.has(row.id) || parentIsTrashed(row)"
              :title="parentIsTrashed(row) ? '请先恢复父级' : '恢复到原位置'"
              @click="onRestore(row.id)"
            >
              <span class="material-symbols-outlined icon-sm">restore</span>
              恢复
            </button>
            <button
              class="row-btn danger"
              :disabled="busy.has(row.id)"
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

    <div v-if="rows.length > 0" class="load-more-row">
      <button
        v-if="pagesStore.trashHasMore"
        type="button"
        class="btn ghost load-more-btn"
        :disabled="pagesStore.trashLoadingMore"
        @click="pagesStore.loadMoreTrash(selectedSpaceId)"
      >
        {{ pagesStore.trashLoadingMore ? '加载中…' : '加载更多' }}
      </button>
      <div v-else class="load-more-end">— 已加载全部 —</div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.trash-view { width: 100%; }
/* `margin: 0 auto` + max-width: 1680 matches the editor's
   `.content-inner` (components.css:431-435) so the manager content
   area is at the same X and width as the editor's content area. */
.view-content {
  max-width: 1680px;
  margin: 0 auto;
}

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

/* ─── Empty state ─── */
.empty {
  padding: 80px 0;
  text-align: center;
  color: var(--text-3);
}
.empty-icon { font-size: 56px; display: block; margin-bottom: 12px; color: var(--text-3); }
.empty h2 { font-size: 16px; font-weight: 500; color: var(--text-2); margin: 0 0 6px; }
.empty p { font-size: 13px; margin: 0; }

/* ─── Table ─── */
.trash-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  overflow: hidden;
}
.trash-table th, .trash-table td {
  padding: 10px 12px;
  text-align: left;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.trash-table th {
  background: var(--bg-subtle);
  color: var(--text-3);
  font-weight: 500;
  font-size: 12px;
  text-transform: none;
  letter-spacing: 0;
}
.trash-table tr:last-child td { border-bottom: none; }
.trash-table tr.busy { opacity: 0.6; }

.col-title { width: 48%; }
.col-by { width: 20%; color: var(--text-2); }
.col-when { width: 14%; color: var(--text-2); }
.col-actions { width: 18%; text-align: right; white-space: nowrap; }

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
.parent-trashed { color: var(--danger, #DE350B); font-weight: 500; }

.row-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  margin-left: 6px;
}
.row-btn:hover:not(:disabled) { background: var(--bg-subtle); color: var(--text-1); }
.row-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.row-btn.danger { color: var(--danger, #DE350B); border-color: var(--danger, #DE350B); }
.row-btn.danger:hover:not(:disabled) { background: var(--danger, #DE350B); color: white; }
.row-btn.restore { color: var(--accent); border-color: var(--accent); }
.row-btn.restore:hover:not(:disabled) { background: var(--accent-soft); }

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
</style>
