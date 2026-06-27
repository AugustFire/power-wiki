<script setup lang="ts">
/**
 * GroupsView — admin user-group list + create.
 *
 * Stage 4b scope:
 *   - List groups (name, description, member count) as clickable cards
 *   - Inline create form (name, description)
 *   - Click card → /manager/groups/:id (GroupEditView)
 *
 * Member management happens in GroupEditView. Here we only show a count.
 */
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { api, ApiError } from '@/lib/api'
import { useConfirm } from '@/composables/useConfirm'
import { useManagerActions } from '@/composables/useManagerActions'
import type { UserGroup, User } from '@power-wiki/shared'

const router = useRouter()
const uiStore = useUiStore()
const pagesStore = usePagesStore()
const { confirm: askConfirm } = useConfirm()

const groups = ref<UserGroup[]>([])
const users = ref<User[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

const { showCreateGroup: showCreate } = useManagerActions()
const createName = ref('')
const createDesc = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

// Reset form fields when the panel button transitions closed → open.
// Also reset `showCreate` on mount so stale open state doesn't carry over.
onMounted(() => { showCreate.value = false })
watch(showCreate, (next, prev) => {
  if (next && !prev) {
    createName.value = ''
    createDesc.value = ''
    createError.value = null
  }
})

const memberCountByGroup = ref<Record<string, number>>({})

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [g, u] = await Promise.all([api.admin.groups.list(), api.admin.users.list()])
    groups.value = g
    users.value = u
    // Fetch member counts in parallel — small N (groups), safe.
    const counts: Record<string, number> = {}
    await Promise.all(
      g.map(async (grp) => {
        const full = await api.admin.groups.get(grp.id)
        counts[grp.id] = full.memberIds?.length ?? 0
      }),
    )
    memberCountByGroup.value = counts
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '加载用户组失败'
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
    const created = await api.admin.groups.create({
      name: createName.value.trim(),
      description: createDesc.value.trim() || undefined,
    })
    groups.value.push(created)
    memberCountByGroup.value[created.id] = 0
    showCreate.value = false
  } catch (e) {
    createError.value = e instanceof ApiError ? e.message : '创建失败'
  } finally {
    creating.value = false
  }
}

async function onDelete(g: UserGroup) {
  const ok = await askConfirm({
    title: '删除用户组',
    message: `确定要删除用户组「${g.name}」吗?该组下的所有成员关系将一并删除,组内用户不会被删除。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.admin.groups.delete(g.id)
    groups.value = groups.value.filter((x) => x.id !== g.id)
    delete memberCountByGroup.value[g.id]
    // Group delete cascades to spaceGroupAccess; affected users' visible
    // space set may have shrunk — re-fetch pages so the sidebar matches.
    void pagesStore.refresh()
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '删除失败')
  }
}

function openGroup(g: UserGroup) {
  void router.push(`/manager/groups/${g.id}`)
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}
</script>

<template>
  <div class="groups-view">
    <header class="gv-header">
      <div>
        <h1 class="gv-title">用户组</h1>
        <p class="gv-sub">共 {{ groups.length }} 个用户组,用于批量管理用户对空间的访问权限</p>
      </div>
    </header>

    <div v-if="loadError" class="gv-error">{{ loadError }}</div>

    <div v-if="showCreate" class="create-panel">
      <h2 class="cp-title">创建用户组</h2>

      <div v-if="createError" class="cp-error">{{ createError }}</div>

      <div class="cp-grid">
        <label class="field">
          <span class="field-label">名称</span>
          <input
            v-model="createName"
            type="text"
            class="field-input"
            placeholder="例如:工程组"
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
            placeholder="一句话说明这个组的用途"
            :disabled="creating"
            maxlength="200"
          />
        </label>
      </div>
      <div class="cp-actions">
        <button type="button" class="btn ghost" :disabled="creating" @click="closeCreate">取消</button>
        <button type="button" class="btn primary" :disabled="creating" @click="onSubmitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </div>
    </div>

    <div v-if="loading && groups.length === 0" class="gv-loading">加载中…</div>
    <div v-else-if="groups.length === 0" class="gv-empty">
      <span class="material-symbols-outlined ge-icon">workspaces</span>
      <h3>还没有用户组</h3>
      <p>创建用户组以批量管理用户的空间访问权限。</p>
    </div>
    <div v-else class="gv-grid">
      <div
        v-for="g in groups"
        :key="g.id"
        class="gv-card"
        role="button"
        tabindex="0"
        @click="openGroup(g)"
        @keydown.enter="openGroup(g)"
      >
        <div class="gc-head">
          <span class="material-symbols-outlined gc-icon">workspaces</span>
          <div class="gc-text">
            <div class="gc-name">{{ g.name }}</div>
            <div v-if="g.description" class="gc-desc">{{ g.description }}</div>
          </div>
        </div>
        <div class="gc-stats">
          <div class="gc-stat">
            <span class="gcs-value">{{ memberCountByGroup[g.id] ?? 0 }}</span>
            <span class="gcs-label">成员</span>
          </div>
          <div class="gc-stat">
            <span class="gcs-value">{{ formatDate(g.createdAt) }}</span>
            <span class="gcs-label">创建时间</span>
          </div>
        </div>
        <div class="gc-actions">
          <button
            type="button"
            class="ra-btn"
            title="删除"
            @click.stop="onDelete(g)"
          >
            <span class="material-symbols-outlined">delete</span>
          </button>
          <span class="gc-open">
            <span class="material-symbols-outlined">arrow_forward</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.groups-view { max-width: 1400px; }

.gv-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.gv-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0; }
.gv-sub { font-size: 13px; color: var(--text-3); margin: 4px 0 0 0; }

.gv-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius-md, 4px);
  font-size: 14px;
  margin-bottom: 16px;
}

.gv-loading,
.gv-empty {
  padding: 60px 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.gv-empty .ge-icon { font-size: 48px; color: var(--text-3); display: block; margin-bottom: 12px; }
.gv-empty h3 { font-size: 16px; font-weight: 600; color: var(--text-2); margin: 0 0 4px 0; }
.gv-empty p { margin: 0; }

/* ─── Create panel ─── */
.create-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 20px 24px;
  margin-bottom: 16px;
}
.cp-title { font-size: 16px; font-weight: 600; color: var(--text-1); margin: 0; }
.cp-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 8px 12px;
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  margin: 12px 0;
}
.cp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
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
.cp-actions { display: flex; gap: 8px; justify-content: flex-end; }

/* ─── Card grid ─── */
.gv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.gv-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 16px 20px;
  cursor: pointer;
  transition: box-shadow var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
  display: flex;
  flex-direction: column;
  gap: 12px;
  outline: none;
}
.gv-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm, 0 1px 1px rgba(9, 30, 66, 0.13));
}
.gv-card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.gc-head { display: flex; gap: 12px; align-items: flex-start; }
.gc-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; }
.gc-text { min-width: 0; }
.gc-name { font-size: 15px; font-weight: 600; color: var(--text-1); }
.gc-desc { font-size: 13px; color: var(--text-3); margin-top: 2px; line-height: 1.4; }

.gc-stats { display: flex; gap: 24px; }
.gc-stat { display: flex; flex-direction: column; }
.gcs-value { font-size: 14px; font-weight: 600; color: var(--text-1); }
.gcs-label { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }

.gc-actions { display: flex; align-items: center; justify-content: space-between; }
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
.gc-open { color: var(--text-3); display: inline-flex; }
.gc-open .material-symbols-outlined { font-size: 18px; }
</style>