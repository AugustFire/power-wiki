<script setup lang="ts">
/**
 * SpacesView — admin space list + create.
 *
 *   - List spaces as cards with color/icon, page count, access-group count.
 *   - Inline create form (name, description, color, optional icon).
 *   - Click card → /manager/spaces/:id (SpaceEditView) for member-of-groups +
 *     rename/delete.
 *   - Delete is gated by the server: refuses if the space still has pages.
 */
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { api, ApiError } from '@/lib/api'
import { useConfirm } from '@/composables/useConfirm'
import { useManagerActions } from '@/composables/useManagerActions'
import type { Space, UserGroup } from '@power-wiki/shared'

const router = useRouter()
const uiStore = useUiStore()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const { confirm: askConfirm } = useConfirm()

const spaces = ref<Space[]>([])
const groups = ref<UserGroup[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

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

const pageCountBySpace = ref<Record<string, number>>({})
const childCountBySpace = ref<Record<string, number>>({})
const lastUpdateBySpace = ref<Record<string, number>>({})
const accessGroupCountBySpace = ref<Record<string, number>>({})
const groupById = ref<Record<string, UserGroup>>({})

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const day = Math.floor(diff / 86_400_000)
  if (day < 7) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    // Single batch: spaces + groups, then per-space pages for the dense stats.
    // Previously each space triggered a per-space group fetch — now we use
    // accessGroupIds from the space response directly, plus one groups.list()
    // call to resolve group names/colors for the avatar preview.
    const [s, g] = await Promise.all([api.admin.spaces.list(), api.admin.groups.list()])
    spaces.value = s
    groups.value = g
    groupById.value = Object.fromEntries(g.map((grp) => [grp.id, grp]))

    const pageCounts: Record<string, number> = {}
    const childCounts: Record<string, number> = {}
    const lastUpdates: Record<string, number> = {}
    await Promise.all(
      s.map(async (sp) => {
        accessGroupCountBySpace.value[sp.id] = sp.accessGroupIds?.length ?? 0
        const pages = await api.pages.list({ space: sp.id }).catch(() => [])
        pageCounts[sp.id] = pages.length
        // Child pages = pages with a non-null parentId in this space.
        childCounts[sp.id] = pages.filter((p) => p.parentId != null).length
        // Last update = max(updatedAt) over pages in this space, or the
        // space's own updatedAt as a fallback.
        const pageMax = pages.reduce((m, p) => Math.max(m, p.updatedAt), 0)
        lastUpdates[sp.id] = pageMax || sp.updatedAt
      }),
    )
    pageCountBySpace.value = pageCounts
    childCountBySpace.value = childCounts
    lastUpdateBySpace.value = lastUpdates
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
    pageCountBySpace.value[created.id] = 0
    accessGroupCountBySpace.value[created.id] = 0
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
    delete pageCountBySpace.value[s.id]
    delete accessGroupCountBySpace.value[s.id]
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
</script>

<template>
  <div class="spaces-view">
    <div class="view-content-wide">
    <header class="sv-header">
      <div class="sv-header-text">
        <h1 class="sv-title">空间</h1>
        <p class="sv-sub">共 {{ spaces.length }} 个空间,用于按团队 / 项目组织页面并控制访问权限</p>
      </div>
      <!-- Create action lives in the main header, not the right context
           panel (which is read-only info / stats). -->
      <button
        type="button"
        class="sv-action"
        @click="showCreate = true"
      >
        <span class="material-symbols-outlined">create_new_folder</span>
        <span>创建新空间</span>
      </button>
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
    <div v-else-if="spaces.length === 0" class="sv-empty">
      <span class="material-symbols-outlined se-icon">folder_open</span>
      <h3>还没有空间</h3>
      <p>创建空间以按团队 / 项目组织页面,并通过用户组控制访问权限。</p>
    </div>
    <div v-else class="sv-grid">
      <div
        v-for="s in spaces"
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
            <div class="sc-name">{{ s.name }}</div>
            <div v-if="s.description" class="sc-desc">{{ s.description }}</div>
          </div>
        </div>

        <div class="sc-stats">
          <div class="sc-stat">
            <span class="scs-value">{{ pageCountBySpace[s.id] ?? 0 }}</span>
            <span class="scs-label">页面</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ childCountBySpace[s.id] ?? 0 }}</span>
            <span class="scs-label">子页</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ accessGroupCountBySpace[s.id] ?? 0 }}</span>
            <span class="scs-label">授权组</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ lastUpdateBySpace[s.id] ? relativeTime(lastUpdateBySpace[s.id]!) : '—' }}</span>
            <span class="scs-label">最近更新</span>
          </div>
          <div class="sc-stat">
            <span class="scs-value">{{ formatDate(s.createdAt) }}</span>
            <span class="scs-label">创建</span>
          </div>
        </div>

        <!-- Access group avatar preview. Empty state hints at the implication
             of having no groups (admin-only access). -->
        <div class="sc-access">
          <span class="sc-access-label">授权组:</span>
          <div v-if="(s.accessGroupIds?.length ?? 0) === 0" class="sc-access-empty">
            无授权 — 只有管理员可访问
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
          <button
            type="button"
            class="ra-btn"
            title="删除"
            @click.stop="onDelete(s)"
          >
            <span class="material-symbols-outlined">delete</span>
          </button>
          <span class="sc-open">
            <span class="material-symbols-outlined">arrow_forward</span>
          </span>
        </div>
      </div>
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

.sv-loading,
.sv-empty {
  padding: 60px 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.sv-empty .se-icon { font-size: 48px; color: var(--text-3); display: block; margin-bottom: 12px; }
.sv-empty h3 { font-size: 16px; font-weight: 600; color: var(--text-2); margin: 0 0 4px 0; }
.sv-empty p { margin: 0; }

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
.sc-name { font-size: 15px; font-weight: 600; color: var(--text-1); }
.sc-desc { font-size: 13px; color: var(--text-3); margin-top: 2px; line-height: 1.4; }

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
</style>
