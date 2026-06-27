<script setup lang="ts">
/**
 * GroupEditView — edit a single user-group (name, description, members).
 *
 * Stage 4b:
 *   - Edit form: name, description
 *   - Members: search + toggleable list of all users. Clicking a row toggles
 *     membership. Optimistic add/remove with rollback on failure.
 *   - Delete group (with confirm; CASCADE removes memberships)
 *
 * The user list shows all users, with current members marked. Disabled users
 * are still toggleable — admin can choose to keep them in a group or remove.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { api, ApiError } from '@/lib/api'
import type { User, UserGroup } from '@power-wiki/shared'

const route = useRoute()
const router = useRouter()
const uiStore = useUiStore()
const pagesStore = usePagesStore()
const { confirm: askConfirm } = useConfirm()

const groupId = computed(() => String(route.params.id ?? ''))

const group = ref<UserGroup | null>(null)
const allUsers = ref<User[]>([])
const memberIds = ref<Set<string>>(new Set())
const loading = ref(false)
const loadError = ref<string | null>(null)

const editName = ref('')
const editDesc = ref('')
const saving = ref(false)
const dirty = ref(false)
const search = ref('')

const pendingUserId = ref<string | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [g, u] = await Promise.all([
      api.admin.groups.get(groupId.value),
      api.admin.users.list(),
    ])
    group.value = g
    memberIds.value = new Set(g.memberIds ?? [])
    allUsers.value = u
    syncFormFromGroup()
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      loadError.value = '用户组不存在'
    } else {
      loadError.value = e instanceof ApiError ? e.message : '加载失败'
    }
  } finally {
    loading.value = false
  }
}

function syncFormFromGroup() {
  if (!group.value) return
  editName.value = group.value.name
  editDesc.value = group.value.description ?? ''
  dirty.value = false
}

watch(groupId, () => {
  if (groupId.value) void load()
})

onMounted(load)

const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return allUsers.value
  return allUsers.value.filter(
    (u) =>
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q),
  )
})

function isMember(userId: string): boolean {
  return memberIds.value.has(userId)
}

async function toggleMembership(u: User) {
  if (pendingUserId.value || !group.value) return
  const wasMember = isMember(u.id)
  // Optimistic update
  if (wasMember) {
    memberIds.value.delete(u.id)
  } else {
    memberIds.value.add(u.id)
  }
  // Trigger reactivity on Set — Vue tracks Set mutations since 3.0 but assigning
  // back to a ref makes it clearer.
  memberIds.value = new Set(memberIds.value)
  pendingUserId.value = u.id

  try {
    if (wasMember) {
      await api.admin.groups.removeMember(group.value.id, u.id)
    } else {
      const updated = await api.admin.groups.addMember(group.value.id, u.id)
      memberIds.value = new Set(updated.memberIds ?? [])
    }
  } catch (e) {
    // Rollback
    if (wasMember) {
      memberIds.value.add(u.id)
    } else {
      memberIds.value.delete(u.id)
    }
    memberIds.value = new Set(memberIds.value)
    uiStore.setError(e instanceof ApiError ? e.message : '操作失败')
  } finally {
    pendingUserId.value = null
  }
}

function markDirty() {
  dirty.value = true
}

async function onSave() {
  if (!group.value || !dirty.value || saving.value) return
  saving.value = true
  try {
    const updated = await api.admin.groups.update(group.value.id, {
      name: editName.value.trim(),
      description: editDesc.value.trim() || undefined,
    })
    group.value = { ...group.value, ...updated, memberIds: Array.from(memberIds.value) }
    dirty.value = false
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function onReset() {
  syncFormFromGroup()
}

async function onDelete() {
  if (!group.value) return
  const g = group.value
  const ok = await askConfirm({
    title: '删除用户组',
    message: `确定要删除用户组「${g.name}」吗?所有成员关系将一并删除。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.admin.groups.delete(g.id)
    // Group delete cascades to spaceGroupAccess; affected users' visible
    // space set may have shrunk — re-fetch pages so the sidebar matches.
    void pagesStore.refresh()
    void router.push('/manager/groups')
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '删除失败')
  }
}

function statusLabel(s: User['status']): string {
  switch (s) {
    case 'active': return '正常'
    case 'must_reset_password': return '需重置'
    case 'disabled': return '已禁用'
  }
}

function statusTone(s: User['status']): 'good' | 'warn' | 'bad' {
  switch (s) {
    case 'active': return 'good'
    case 'must_reset_password': return 'warn'
    case 'disabled': return 'bad'
  }
}
</script>

<template>
  <div v-if="loading" class="ge-loading">加载中…</div>

  <div v-else-if="loadError" class="ge-error">
    <p>{{ loadError }}</p>
    <button type="button" class="btn ghost" @click="router.push('/manager/groups')">返回列表</button>
  </div>

  <div v-else-if="group" class="group-edit">
    <nav class="ge-breadcrumb" aria-label="面包屑导航">
      <RouterLink to="/manager/groups">用户组</RouterLink>
      <span class="ge-bc-sep" aria-hidden="true">/</span>
      <span class="ge-bc-current">{{ group.name }}</span>
    </nav>

    <header class="ge-header">
      <div class="ge-header-text">
        <h1 class="ge-title">{{ group.name }}</h1>
        <p class="ge-sub">{{ memberIds.size }} 个成员</p>
      </div>
    </header>

    <div class="ge-grid">
      <!-- Edit form -->
      <section class="ge-card">
        <h2 class="ge-card-title">基本信息</h2>
        <div class="ge-fields">
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
        </div>
        <div class="ge-card-actions">
          <button type="button" class="btn ghost" :disabled="!dirty || saving" @click="onReset">取消</button>
          <button type="button" class="btn primary" :disabled="!dirty || saving" @click="onSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="ge-danger-zone">
          <h3 class="ge-danger-title">危险操作</h3>
          <button type="button" class="btn danger" @click="onDelete">
            <span class="material-symbols-outlined btn-icon">delete</span>
            <span>删除用户组</span>
          </button>
        </div>
      </section>

      <!-- Member list -->
      <section class="ge-card ge-card-members">
        <h2 class="ge-card-title">成员 ({{ memberIds.size }})</h2>
        <div class="ge-search-row">
          <span class="material-symbols-outlined ge-search-icon">search</span>
          <input
            v-model="search"
            type="text"
            class="ge-search"
            placeholder="按姓名或邮箱搜索"
          />
        </div>
        <div v-if="filteredUsers.length === 0" class="ge-empty-members">
          没有匹配的用户
        </div>
        <ul v-else class="member-list">
          <li
            v-for="u in filteredUsers"
            :key="u.id"
            class="member-row"
            :class="{ 'is-pending': pendingUserId === u.id, 'is-disabled': u.status === 'disabled' }"
          >
            <UserAvatar :size="32" :label="u.name" :color="u.color" />
            <div class="member-text">
              <div class="member-name">{{ u.name }}</div>
              <div class="member-email">{{ u.email }}</div>
            </div>
            <span class="status-pill" :class="statusTone(u.status)">{{ statusLabel(u.status) }}</span>
            <button
              type="button"
              class="member-toggle"
              :class="{ 'in-group': isMember(u.id) }"
              :disabled="pendingUserId === u.id"
              :title="isMember(u.id) ? '从组中移除' : '加入组'"
              @click="toggleMembership(u)"
            >
              <span class="material-symbols-outlined">
                {{ isMember(u.id) ? 'check_circle' : 'add_circle' }}
              </span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.group-edit { max-width: 1200px; }

/* ─── Breadcrumb ─── */
.ge-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 12px;
}
.ge-breadcrumb a {
  color: var(--accent);
  text-decoration: none;
}
.ge-breadcrumb a:hover { text-decoration: underline; }
.ge-bc-sep { color: var(--text-3); }
.ge-bc-current { color: var(--text-2); font-weight: 500; }

.ge-loading,
.ge-error {
  padding: 48px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.ge-error { color: var(--danger); }
.ge-error .btn { margin-top: 12px; display: inline-flex; }

.ge-header { margin-bottom: 20px; }
.ge-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0; }
.ge-sub { font-size: 13px; color: var(--text-3); margin: 4px 0 0 0; }

.ge-grid {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 16px;
  align-items: start;
}
.ge-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 20px 24px;
}
.ge-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 16px 0;
}
.ge-fields { display: flex; flex-direction: column; gap: 14px; }
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
.ge-card-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

.ge-danger-zone {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.ge-danger-title { font-size: 12px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 10px 0; }

/* ─── Member list ─── */
.ge-search-row {
  position: relative;
  margin-bottom: 12px;
}
.ge-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 18px;
  color: var(--text-3);
  pointer-events: none;
}
.ge-search {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 36px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: var(--bg-canvas);
  border: 2px solid transparent;
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}
.ge-search:focus {
  background: var(--bg);
  border-color: var(--accent);
}

.ge-empty-members {
  padding: 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}

.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 480px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.member-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  transition: background var(--duration-fast) var(--ease-out);
}
.member-row:last-child { border-bottom: 0; }
.member-row:hover { background: var(--bg-canvas); }
.member-row.is-pending { opacity: 0.6; }
.member-row.is-disabled { opacity: 0.7; }

.member-text { min-width: 0; flex: 1; }
.member-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.member-email {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-pill {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: var(--radius-pill, 999px);
  white-space: nowrap;
}
.status-pill.good { background: var(--success-soft); color: var(--success); }
.status-pill.warn { background: var(--warning-soft); color: var(--warning-text); }
.status-pill.bad { background: var(--danger-soft); color: var(--danger); }

.member-toggle {
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 4px;
  border-radius: 50%;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color var(--duration-fast) var(--ease-out);
}
.member-toggle:hover:not(:disabled) { color: var(--accent); }
.member-toggle:disabled { cursor: wait; }
.member-toggle.in-group { color: var(--success); }
.member-toggle.in-group:hover:not(:disabled) { color: var(--danger); }
.member-toggle .material-symbols-outlined { font-size: 22px; }
</style>