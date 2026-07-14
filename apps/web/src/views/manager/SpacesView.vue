<script setup lang="ts">
/**
 * SpacesView — admin space list + create.
 *
 *   - List spaces as cards with color/icon, page count, access-group count.
 *   - Inline create form (name, description, color, optional icon).
 *   - Click card → /manager/spaces/:id (SpaceEditView) for member-of-groups +
 *     rename/delete.
 *   - Delete is gated by the server: refuses if the space still has pages.
 *
 * Stage 7 cleanup: 个人空间和团队空间分两个 tab (`KindTabs`),默认 团队。
 * 在 `个人` tab 上**不**显示创建 / 删除按钮 — admin 不主动管理 personal space,
 * 那是用户的私有草稿区,只读查看就够了。个人空间卡上额外显示"所有者"列
 * (lookup users 表),方便 admin 知道某人的草稿空间属于谁。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
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
import type { Space, UserGroup } from '@power-wiki/shared'
import type { User } from '@power-wiki/shared'

const router = useRouter()
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
 * Stage B.3: both auxiliary lists come from `useManagerStats()` —
 * shared with PeopleView / PeopleContextPanel via the module-level
 * singleton + promise-cache. First caller fires the request; subsequent
 * callers (including SpacesView mounted later in the same SPA session)
 * await the in-flight promise instead of starting a second request.
 */
const {
  items: spaces,
  hasMore: spacesHasMore,
  loading: spacesListLoading,
  error: spacesListError,
  loadMore: loadMoreSpaces,
  reset: resetSpaces,
} = usePaginatedList<Space>(
  (q) => api.admin.spaces.list(q),
  { pageSize: 50 },
)
const {
  groups,
  users: statsUsers,
  ensureGroupsLoaded,
  ensureUsersLoaded,
} = useManagerStats()
const loading = ref(false)
const loadError = ref<string | null>(null)
/**
 * `users` here is the legacy reactive view-local alias for the panel —
 * each row in the table needs to look up `ownerName` by ownerId. The
 * composable already serves the data via `statsUsers`, so this view
 * just forwards it.
 */
const users = statsUsers

type KindTab = 'shared' | 'personal'
const kindTab = ref<KindTab>('shared')

// Tab-filtered lists drive both the card grid and the count badges on the
// tabs themselves (admin gets an at-a-glance sense of how much is on each
// side without forcing a click).
const sharedSpaces = computed(() => spaces.value.filter((s) => s.kind === 'shared'))
const personalSpaces = computed(() => spaces.value.filter((s) => s.kind === 'personal'))
const visibleSpaces = computed(() =>
  kindTab.value === 'shared' ? sharedSpaces.value : personalSpaces.value,
)

const { showCreateSpace: showCreate } = useManagerActions()
const createName = ref('')
const createDesc = ref('')
const createColor = ref('#0052CC')
const creating = ref(false)
const createError = ref<string | null>(null)

// Reset form fields when the panel button transitions closed → open.
// Also reset `showCreate` on mount so stale open state doesn't carry over.
onMounted(() => { showCreate.value = false })
watch(showCreate, (next, prev) => {
  if (next && !prev) {
    createName.value = ''
    createDesc.value = ''
    createColor.value = '#0052CC'
    createError.value = null
  }
})

const COLOR_PALETTE = [
  '#0052CC', '#00875A', '#FF5630', '#FFAB00',
  '#403294', '#0065FF', '#36B37E', '#6554C0',
]

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
    // Phase 1 (parallel): paginated spaces + group set (always needed
    // for the access-group avatar preview). Per-space stats now come
    // inside the spaces DTO, so no per-space stat fetch is needed.
    // `ensureGroupsLoaded` is shared with PeopleView / PeopleContextPanel
    // — first caller fires the request, subsequent await reuses the
    // same in-flight promise.
    const [, ] = await Promise.all([
      resetSpaces(),
      ensureGroupsLoaded(),
    ])
    if (spacesListError.value) {
      throw spacesListError.value
    }
    groupById.value = Object.fromEntries(groups.value.map((grp) => [grp.id, grp]))

    // Phase 2 (conditional): the user set is only needed when admin
    // actually views personal-space cards (the "所有者" column needs
    // owner display names). Skip entirely if no personal spaces exist.
    // plan §B7.7. Also shared with PeopleView / PeopleContextPanel.
    if (spaces.value.some((s) => s.kind === 'personal')) {
      await ensureUsersLoaded()
    }
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
    spaces.value.push(created)
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

async function onDelete(s: Space) {
  const ok = await askConfirm({
    title: '删除空间',
    message: `确定要删除空间「${s.name}」吗?该操作不可撤销。空间必须为空(没有页面)才能删除 — 否则请先移动或删除页面。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.admin.spaces.delete(s.id)
    spaces.value = spaces.value.filter((x) => x.id !== s.id)
    // Mirror to the sidebar store — if the deleted space was the active one,
    // the store already auto-shifts; otherwise just drop it.
    await spacesStore.refresh()
    // Delete cascades to the space's pages; drop them from the in-memory tree.
    void pagesStore.refresh()
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
  void router.push(`/manager/spaces/${s.id}`)
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
</script>

<template>
  <div class="spaces-view">
    <div class="view-content-wide">
    <header class="sv-header">
      <div class="sv-header-text">
        <h1 class="sv-title">空间</h1>
        <p class="sv-sub">共 {{ sharedSpaces.length }} 个团队空间、{{ personalSpaces.length }} 个个人空间 — 用于按团队 / 项目组织页面并控制访问权限</p>
      </div>
      <!-- Create action lives in the main header, not the right context
           panel (which is read-only info / stats). Personal-space tab
           doesn't expose create — personal spaces are auto-created per
           user, not admin-managed. -->
      <div class="sv-header-actions">
        <KindTabs
          v-model="kindTab"
          :shared-count="sharedSpaces.length"
          :personal-count="personalSpaces.length"
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
            v-for="c in COLOR_PALETTE"
            :key="c"
            type="button"
            class="cs-swatch"
            :class="{ 'cs-swatch-active': createColor === c }"
            :style="{ background: c }"
            :title="c"
            :disabled="creating"
            @click="createColor = c"
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
      v-else-if="visibleSpaces.length === 0"
      :icon="kindTab === 'shared' ? 'workspaces' : 'cottage'"
      :title="kindTab === 'shared' ? '还没有团队空间' : '还没有个人空间'"
      :hint="kindTab === 'shared'
        ? '创建空间以按团队 / 项目组织页面,并通过用户组控制访问权限。'
        : '每个用户在第一次登录时会自动创建一个个人空间(草稿区)。当前还没有任何用户。'"
      variant="no-results"
      size="sm"
    />
    <div v-else class="sv-grid">
      <div
        v-for="s in visibleSpaces"
        :key="s.id"
        class="sv-card"
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
          <div class="sc-stat">
            <span class="scs-value">{{ s.accessGroupIds?.length ?? 0 }}</span>
            <span class="scs-label">授权组</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ s.lastPageUpdatedAt ? relativeTime(s.lastPageUpdatedAt) : '—' }}</span>
            <span class="scs-label">最近更新</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ formatDate(s.createdAt) }}</span>
            <span class="scs-label">创建</span>
          </div>
        </div>

        <!-- Access group avatar preview. Empty state hints at the implication
             of having no groups (admin-only access). For personal spaces the
             only authorized "group" is the auto-created `pg-<userId>` group,
             which adminSpaces.ts filters out of `accessGroupIds` — so this
             row always renders the empty state on personal cards. -->
        <div class="sc-access">
          <span class="sc-access-label">授权组:</span>
          <div v-if="(s.accessGroupIds?.length ?? 0) === 0" class="sc-access-empty">
            {{ s.kind === 'personal' ? '仅所有者可见' : '无授权 — 只有管理员可访问' }}
          </div>
          <div v-else class="sc-access-avatars">
            <span
              v-for="gid in (s.accessGroupIds ?? []).slice(0, 5)"
              :key="gid"
              class="sc-access-avatar"
              :title="groupById[gid]?.name ?? gid"
            >
              {{ (groupById[gid]?.name ?? gid).slice(0, 1) }}
            </span>
            <span
              v-if="(s.accessGroupIds?.length ?? 0) > 5"
              class="sc-access-more"
            >+{{ (s.accessGroupIds?.length ?? 0) - 5 }}</span>
          </div>
        </div>

        <div class="sc-actions">
          <!-- Delete is only allowed on team spaces — personal spaces are
               owned by users and shouldn't be admin-removable. The space
               is auto-cleaned when the user is disabled via the users API. -->
          <button
            v-if="s.kind !== 'personal'"
            type="button"
            class="ra-btn"
            title="删除"
            @click.stop="onDelete(s)"
          >
            <span class="material-symbols-outlined">delete</span>
          </button>
          <span v-else class="sc-locked" title="个人空间不可由管理员删除">
            <span class="material-symbols-outlined">lock</span>
          </span>
          <span class="sc-open">
            <span class="material-symbols-outlined">arrow_forward</span>
          </span>
        </div>
      </div>
    </div>

    <div v-if="visibleSpaces.length > 0" class="load-more-row">
      <button
        v-if="spacesHasMore"
        type="button"
        class="btn ghost load-more-btn"
        :disabled="spacesListLoading"
        @click="loadMoreSpaces"
      >
        {{ spacesListLoading ? '加载中…' : '加载更多' }}
      </button>
      <div v-else class="load-more-end">— 已加载全部 —</div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.spaces-view { width: 100%; }
/* Centered (`margin: 0 auto`) and max-width: 1680 to match the
   editor's `.content-inner` so the manager content area is at the same
   X and width as the editor's content area. The card grid auto-fills
   the available width — 2K shows 4-5 columns, small viewports 1-2. */
.view-content-wide {
  max-width: 1680px;
  margin: 0 auto;
}

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
  background: var(--accent-soft, #E9F2FF);
  color: var(--accent, #0052CC);
}
.sc-kind-badge-shared {
  background: var(--bg-canvas, #F4F5F7);
  color: var(--text-3, #6B778C);
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
  color: var(--danger, #DE350B);
  font-weight: 500;
}
.sc-access-avatars {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sc-access-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent);
  color: #FFFFFF;
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 2px solid var(--bg);
  margin-left: -6px;
}
.sc-access-avatar:first-child { margin-left: 0; }
.sc-access-more {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-3);
  font-weight: 600;
}

.sc-actions { display: flex; align-items: center; justify-content: space-between; }
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
.ra-btn:hover { background: var(--danger-soft); color: var(--danger); }
.ra-btn .material-symbols-outlined { font-size: 18px; }
.sc-open { color: var(--text-3); display: inline-flex; }
.sc-open .material-symbols-outlined { font-size: 18px; }

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
.load-more-end {
  font-size: 12px;
  color: var(--text-3);
  padding: 24px 0 8px;
}
</style>
