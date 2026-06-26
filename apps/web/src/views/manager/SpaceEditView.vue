<script setup lang="ts">
/**
 * SpaceEditView — edit a single space (name, description, color, access groups).
 *
 *   - Edit form: name, description, color
 *   - Access groups: searchable list of all groups with toggles. The full set
 *     is sent on save (PUT /api/admin/spaces/:id/access replaces the entire set).
 *   - Delete space (with confirm; backend refuses if pages exist)
 *
 * Optimistic add/remove for group toggles — rollback on failure.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from '@/composables/useConfirm'
import { useUiStore } from '@/stores/ui'
import { api, ApiError } from '@/lib/api'
import type { Space, UserGroup } from '@power-wiki/shared'

const route = useRoute()
const router = useRouter()
const uiStore = useUiStore()
const { confirm: askConfirm } = useConfirm()

const spaceId = computed(() => String(route.params.id ?? ''))

const space = ref<Space | null>(null)
const allGroups = ref<UserGroup[]>([])
const accessGroupIds = ref<Set<string>>(new Set())
const loading = ref(false)
const loadError = ref<string | null>(null)

const editName = ref('')
const editDesc = ref('')
const editColor = ref('#0052CC')
const saving = ref(false)
const dirty = ref(false)
const search = ref('')

const COLOR_PALETTE = [
  '#0052CC', '#00875A', '#FF5630', '#FFAB00',
  '#403294', '#0065FF', '#36B37E', '#6554C0',
]

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [s, g] = await Promise.all([
      api.admin.spaces.get(spaceId.value),
      api.admin.groups.list(),
    ])
    space.value = s
    accessGroupIds.value = new Set(s.accessGroupIds ?? [])
    allGroups.value = g
    syncFormFromSpace()
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      loadError.value = '空间不存在'
    } else {
      loadError.value = e instanceof ApiError ? e.message : '加载失败'
    }
  } finally {
    loading.value = false
  }
}

function syncFormFromSpace() {
  if (!space.value) return
  editName.value = space.value.name
  editDesc.value = space.value.description ?? ''
  editColor.value = space.value.color
  dirty.value = false
}

watch(spaceId, () => {
  if (spaceId.value) void load()
})

onMounted(load)

const filteredGroups = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return allGroups.value
  return allGroups.value.filter(
    (g) =>
      g.name.toLowerCase().includes(q) ||
      (g.description ?? '').toLowerCase().includes(q),
  )
})

function isAuthorized(groupId: string): boolean {
  return accessGroupIds.value.has(groupId)
}

function toggleAccess(g: UserGroup) {
  // Pure local toggle — the actual server write happens on save.
  if (isAuthorized(g.id)) {
    accessGroupIds.value.delete(g.id)
  } else {
    accessGroupIds.value.add(g.id)
  }
  accessGroupIds.value = new Set(accessGroupIds.value)
}

function markDirty() {
  dirty.value = true
}

async function onSave() {
  if (!space.value || !dirty.value || saving.value) return
  saving.value = true
  try {
    const updated = await api.admin.spaces.update(space.value.id, {
      name: editName.value.trim(),
      description: editDesc.value.trim() || undefined,
      color: editColor.value,
    })
    // Persist the access group set as a separate PUT (replaces the entire set).
    const withAccess = await api.admin.spaces.setAccess(space.value.id, {
      groupIds: Array.from(accessGroupIds.value),
    })
    space.value = { ...updated, ...withAccess, accessGroupIds: withAccess.accessGroupIds }
    dirty.value = false
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function onReset() {
  syncFormFromSpace()
  if (space.value) {
    accessGroupIds.value = new Set(space.value.accessGroupIds ?? [])
  }
}

async function onDelete() {
  if (!space.value) return
  const s = space.value
  const ok = await askConfirm({
    title: '删除空间',
    message: `确定要删除空间「${s.name}」吗?该操作不可撤销。空间必须为空(没有页面)才能删除。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.admin.spaces.delete(s.id)
    void router.push('/manager/spaces')
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.code === 'space_not_empty') {
      const body = e.body as { pageCount?: number } | null
      uiStore.setError(`该空间下还有 ${body?.pageCount ?? ''} 个页面,请先删除或移动这些页面`)
    } else {
      uiStore.setError(e instanceof ApiError ? e.message : '删除失败')
    }
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}
</script>

<template>
  <div v-if="loading" class="se-loading">加载中…</div>

  <div v-else-if="loadError" class="se-error">
    <p>{{ loadError }}</p>
    <button type="button" class="btn ghost" @click="router.push('/manager/spaces')">返回列表</button>
  </div>

  <div v-else-if="space" class="space-edit">
    <header class="se-header">
      <div class="se-header-text">
        <div class="se-title-row">
          <span
            class="se-avatar"
            :style="{ background: space.color }"
            aria-hidden="true"
          >
            <span class="se-initials">{{ space.name.slice(0, 2) }}</span>
          </span>
          <h1 class="se-title">{{ space.name }}</h1>
        </div>
        <p class="se-sub">创建于 {{ formatDate(space.createdAt) }}</p>
      </div>
    </header>

    <div class="se-grid">
      <!-- Edit form -->
      <section class="se-card">
        <h2 class="se-card-title">基本信息</h2>
        <div class="se-fields">
          <label class="field">
            <span class="field-label">名称</span>
            <input
              v-model="editName"
              type="text"
              class="field-input"
              :disabled="saving"
              maxlength="64"
              @input="markDirty"
            />
          </label>
          <label class="field">
            <span class="field-label">描述</span>
            <input
              v-model="editDesc"
              type="text"
              class="field-input"
              :disabled="saving"
              maxlength="200"
              placeholder="可选"
              @input="markDirty"
            />
          </label>
          <div class="field">
            <span class="field-label">颜色</span>
            <div class="color-swatches">
              <button
                v-for="c in COLOR_PALETTE"
                :key="c"
                type="button"
                class="cs-swatch"
                :class="{ 'cs-swatch-active': editColor === c }"
                :style="{ background: c }"
                :disabled="saving"
                @click="editColor = c; markDirty()"
              />
            </div>
          </div>
        </div>
        <div class="se-card-actions">
          <button type="button" class="btn ghost" :disabled="!dirty || saving" @click="onReset">取消</button>
          <button type="button" class="btn primary" :disabled="!dirty || saving" @click="onSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="se-danger-zone">
          <h3 class="se-danger-title">危险操作</h3>
          <button type="button" class="btn danger" @click="onDelete">
            <span class="material-symbols-outlined btn-icon">delete</span>
            <span>删除空间</span>
          </button>
        </div>
      </section>

      <!-- Access groups -->
      <section class="se-card se-card-groups">
        <h2 class="se-card-title">访问组 ({{ accessGroupIds.size }})</h2>
        <p class="se-card-hint">
          勾选的用户组可访问此空间下的所有页面。未勾选任何组 = 仅有管理员可访问。
        </p>
        <div class="se-search-row">
          <span class="material-symbols-outlined se-search-icon">search</span>
          <input
            v-model="search"
            type="text"
            class="se-search"
            placeholder="按名称或描述搜索"
          />
        </div>
        <div v-if="allGroups.length === 0" class="se-empty-groups">
          还没有用户组,先去
          <router-link to="/manager/groups">用户组管理</router-link>
          创建。
        </div>
        <div v-else-if="filteredGroups.length === 0" class="se-empty-groups">
          没有匹配的用户组
        </div>
        <ul v-else class="group-list">
          <li
            v-for="g in filteredGroups"
            :key="g.id"
            class="group-row"
            :class="{ 'is-authorized': isAuthorized(g.id) }"
          >
            <span class="material-symbols-outlined gr-icon">workspaces</span>
            <div class="group-text">
              <div class="group-name">{{ g.name }}</div>
              <div v-if="g.description" class="group-desc">{{ g.description }}</div>
            </div>
            <button
              type="button"
              class="group-toggle"
              :class="{ 'in-group': isAuthorized(g.id) }"
              :title="isAuthorized(g.id) ? '取消授权' : '授权访问'"
              @click="toggleAccess(g)"
            >
              <span class="material-symbols-outlined">
                {{ isAuthorized(g.id) ? 'check_circle' : 'add_circle' }}
              </span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.space-edit { max-width: 1200px; }

.se-loading,
.se-error {
  padding: 48px;
  text-align: center;
  color: var(--text-3, #6B778C);
  font-size: 14px;
  background: var(--bg, #FFFFFF);
  border: 1px solid var(--border, #DFE1E6);
  border-radius: var(--radius-md, 4px);
}
.se-error { color: var(--danger, #FF5630); }
.se-error .btn { margin-top: 12px; display: inline-flex; }

.se-header { margin-bottom: 20px; }
.se-title-row { display: flex; align-items: center; gap: 12px; }
.se-avatar {
  width: 40px;
  height: 40px;
  border-radius: var(--radius, 3px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 700;
  font-size: 14px;
  flex-shrink: 0;
}
.se-initials { letter-spacing: 0.5px; text-transform: uppercase; }
.se-title { font-size: 22px; font-weight: 700; color: var(--text-1, #172B4D); margin: 0; }
.se-sub { font-size: 13px; color: var(--text-3, #6B778C); margin: 4px 0 0 52px; }

.se-grid {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 16px;
  align-items: start;
}
.se-card {
  background: var(--bg, #FFFFFF);
  border: 1px solid var(--border, #DFE1E6);
  border-radius: var(--radius-md, 4px);
  padding: 20px 24px;
}
.se-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1, #172B4D);
  margin: 0 0 12px 0;
}
.se-card-hint {
  font-size: 12px;
  color: var(--text-3, #6B778C);
  margin: -8px 0 14px 0;
  line-height: 1.5;
}
.se-fields { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--text-2, #44546F); }
.field-input {
  height: 36px;
  padding: 0 10px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1, #172B4D);
  background: var(--bg, #FFFFFF);
  border: 2px solid var(--border, #DFE1E6);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.field-input:focus { border-color: var(--accent, #0052CC); }

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
.cs-swatch:hover:not(:disabled) { transform: scale(1.1); }
.cs-swatch-active { border-color: var(--text-1, #172B4D); }

.se-card-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

.se-danger-zone {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border, #DFE1E6);
}
.se-danger-title { font-size: 12px; font-weight: 600; color: var(--text-3, #6B778C); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 10px 0; }

/* ─── Group list ─── */
.se-search-row {
  position: relative;
  margin-bottom: 12px;
}
.se-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 18px;
  color: var(--text-3, #6B778C);
  pointer-events: none;
}
.se-search {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 36px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1, #172B4D);
  background: var(--bg-canvas, #F4F5F7);
  border: 2px solid transparent;
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}
.se-search:focus {
  background: var(--bg, #FFFFFF);
  border-color: var(--accent, #0052CC);
}

.se-empty-groups {
  padding: 24px;
  text-align: center;
  color: var(--text-3, #6B778C);
  font-size: 13px;
  border: 1px dashed var(--border, #DFE1E6);
  border-radius: var(--radius-md, 4px);
}
.se-empty-groups a { color: var(--accent, #0052CC); text-decoration: none; }
.se-empty-groups a:hover { text-decoration: underline; }

.group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 480px;
  overflow-y: auto;
  border: 1px solid var(--border, #DFE1E6);
  border-radius: var(--radius-md, 4px);
}
.group-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, #DFE1E6);
  background: var(--bg, #FFFFFF);
  transition: background var(--duration-fast) var(--ease-out);
}
.group-row:last-child { border-bottom: 0; }
.group-row:hover { background: var(--bg-canvas, #F4F5F7); }
.group-row.is-authorized { background: var(--accent-soft, #DEEBFF); }
.group-row.is-authorized:hover { background: var(--accent-soft, #DEEBFF); }

.gr-icon { font-size: 22px; color: var(--accent, #0052CC); flex-shrink: 0; }
.group-text { min-width: 0; flex: 1; }
.group-name { font-size: 14px; font-weight: 500; color: var(--text-1, #172B4D); }
.group-desc { font-size: 12px; color: var(--text-3, #6B778C); margin-top: 2px; }

.group-toggle {
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 4px;
  border-radius: 50%;
  color: var(--text-3, #6B778C);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color var(--duration-fast) var(--ease-out);
}
.group-toggle:hover:not(:disabled) { color: var(--accent, #0052CC); }
.group-toggle.in-group { color: var(--success, #36B37E); }
.group-toggle.in-group:hover:not(:disabled) { color: var(--danger, #FF5630); }
.group-toggle .material-symbols-outlined { font-size: 22px; }
</style>
