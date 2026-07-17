<script setup lang="ts">
/**
 * GroupEditView — edit a single user-group (name, description, members).
 *
 * Stage 5d: member management is now a two-panel TRANSFER LIST.
 *   - Left: 已添加成员 (currently in the group) — each row has a remove (X) button
 *   - Right: 可添加用户 (not in the group) — each row has an add (+) button
 *   - Each panel has its own search input
 *
 * Why: a single mixed list of N users (with toggleable state on each row)
 * doesn't scale — you can't tell who is a member without scanning every row.
 * Two panels make the "current state" obvious at a glance and let you search
 * independently on either side.
 *
 * Per-row action is still the same API: addMember / removeMember, optimistic
 * with rollback on failure.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { api, ApiError } from '@/lib/api'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
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

/** 浏览器 tab 标题:"编辑组: <name>";group 没拉到时退 BASE。 */
useDocumentTitle(() => (group.value ? `编辑组: ${group.value.name}` : null))

const editName = ref('')
const editDesc = ref('')
const saving = ref(false)
const dirty = ref(false)

// Two search inputs — one for each panel — so the admin can find a user in
// either side independently (e.g. remove a specific member, OR add a specific
// non-member).
const memberSearch = ref('')
const availableSearch = ref('')

const pendingUserId = ref<string | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [g, usersP] = await Promise.all([
      api.admin.groups.get(groupId.value),
      // B.3: ?limit=200 caps the payload. Full user list is needed for
      // the "available users" transfer list. Real orgs have < 200 users.
      api.admin.users.list({ limit: 200 }),
    ])
    group.value = g
    memberIds.value = new Set(g.memberIds ?? [])
    allUsers.value = usersP.items
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

/* ─── Partition users by membership + per-panel search filter ─── */
function matches(u: User, q: string): boolean {
  if (!q) return true
  return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
}

const memberUsers = computed(() =>
  allUsers.value.filter((u) => memberIds.value.has(u.id) && matches(u, memberSearch.value)),
)
const availableUsers = computed(() =>
  allUsers.value.filter((u) => !memberIds.value.has(u.id) && matches(u, availableSearch.value)),
)

async function addMember(u: User) {
  if (pendingUserId.value || !group.value) return
  pendingUserId.value = u.id
  // Optimistic
  memberIds.value.add(u.id)
  memberIds.value = new Set(memberIds.value)
  try {
    const updated = await api.admin.groups.addMember(group.value.id, u.id)
    memberIds.value = new Set(updated.memberIds ?? [])
  } catch (e) {
    // Rollback
    memberIds.value.delete(u.id)
    memberIds.value = new Set(memberIds.value)
    uiStore.setError(e instanceof ApiError ? e.message : '添加失败')
  } finally {
    pendingUserId.value = null
  }
}

async function removeMember(u: User) {
  if (pendingUserId.value || !group.value) return
  pendingUserId.value = u.id
  // Optimistic
  memberIds.value.delete(u.id)
  memberIds.value = new Set(memberIds.value)
  try {
    await api.admin.groups.removeMember(group.value.id, u.id)
  } catch (e) {
    // Rollback
    memberIds.value.add(u.id)
    memberIds.value = new Set(memberIds.value)
    uiStore.setError(e instanceof ApiError ? e.message : '移除失败')
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
    void router.push({ name: 'manager-people', query: { tab: 'groups' } })
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
  <div class="group-edit">
    <nav class="ge-breadcrumb" aria-label="面包屑导航">
      <RouterLink :to="{ name: 'manager-people', query: { tab: 'groups' } }">用户组</RouterLink>
      <span class="ge-bc-sep" aria-hidden="true">/</span>
      <span class="ge-bc-current">
        <Skeleton v-if="loading" width="120px" height="14px" />
        <template v-else-if="group">{{ group.name }}</template>
        <template v-else>—</template>
      </span>
    </nav>

    <header class="ge-header">
      <div class="ge-header-text">
        <h1 class="ge-title">
          <Skeleton v-if="loading" width="180px" height="22px" />
          <template v-else-if="group">{{ group.name }}</template>
        </h1>
        <p class="ge-sub">
          <template v-if="group">{{ memberIds.size }} 个成员</template>
          <template v-else-if="loading"><Skeleton width="80px" height="12px" /></template>
        </p>
      </div>
    </header>

    <div v-if="loadError" class="ge-error">
      <p>{{ loadError }}</p>
      <button type="button" class="btn ghost" @click="router.push({ name: 'manager-people', query: { tab: 'groups' } })">返回列表</button>
    </div>

    <template v-else-if="loading">
      <div class="ge-grid">
        <section class="ge-card">
          <Skeleton width="100px" height="18px" />
          <div class="ge-fields">
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
          </div>
          <div class="ge-card-actions">
            <Skeleton width="80px" height="32px" />
            <Skeleton width="80px" height="32px" />
          </div>
        </section>
        <section class="ge-card ge-card-members">
          <Skeleton width="100px" height="18px" />
          <div class="ge-transfer">
            <div class="ge-panel">
              <Skeleton width="120px" height="14px" />
              <Skeleton height="32px" />
              <Skeleton :count="3" height="44px" />
            </div>
            <div class="ge-panel">
              <Skeleton width="120px" height="14px" />
              <Skeleton height="32px" />
              <Skeleton :count="3" height="44px" />
            </div>
          </div>
        </section>
      </div>
    </template>

    <div v-else-if="group" class="ge-grid">
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

      <!-- Member transfer list: two panels, each with own search -->
      <section class="ge-card ge-card-members">
        <h2 class="ge-card-title">成员管理</h2>

        <div class="ge-transfer">
          <!-- LEFT: current members -->
          <div class="ge-panel">
            <div class="ge-panel-head">
              <span class="ge-panel-title">已添加成员</span>
              <span class="ge-panel-count">{{ memberIds.size }}</span>
            </div>
            <div class="ge-search-row">
              <span class="material-symbols-outlined ge-search-icon">search</span>
              <input
                v-model="memberSearch"
                type="text"
                class="ge-search"
                placeholder="在成员中搜索"
              />
            </div>
            <ul v-if="memberUsers.length > 0" class="member-list">
              <li
                v-for="u in memberUsers"
                :key="u.id"
                class="member-row"
                :class="{ 'is-pending': pendingUserId === u.id, 'is-disabled': u.status === 'disabled' }"
              >
                <UserAvatar :size="28" :label="u.name" :color="u.color" :avatar-kind="u.avatarKind" :avatar-ref="u.avatarRef" :user-id="u.id" />
                <div class="member-text">
                  <div class="member-name">{{ u.name }}</div>
                  <div class="member-email">{{ u.email }}</div>
                </div>
                <span class="status-pill" :class="statusTone(u.status)">{{ statusLabel(u.status) }}</span>
                <button
                  type="button"
                  class="member-action remove"
                  :disabled="pendingUserId === u.id"
                  title="从组中移除"
                  @click="removeMember(u)"
                >
                  <span class="material-symbols-outlined">remove</span>
                </button>
              </li>
            </ul>
            <div v-else class="ge-empty-members">
              {{ memberSearch ? '没有匹配的成员' : '组里还没有成员' }}
            </div>
          </div>

          <!-- RIGHT: available users (not in group) -->
          <div class="ge-panel">
            <div class="ge-panel-head">
              <span class="ge-panel-title">可添加用户</span>
              <span class="ge-panel-count">{{ allUsers.length - memberIds.size }}</span>
            </div>
            <div class="ge-search-row">
              <span class="material-symbols-outlined ge-search-icon">search</span>
              <input
                v-model="availableSearch"
                type="text"
                class="ge-search"
                placeholder="在所有用户中搜索"
              />
            </div>
            <ul v-if="availableUsers.length > 0" class="member-list">
              <li
                v-for="u in availableUsers"
                :key="u.id"
                class="member-row"
                :class="{ 'is-pending': pendingUserId === u.id, 'is-disabled': u.status === 'disabled' }"
              >
                <UserAvatar :size="28" :label="u.name" :color="u.color" :avatar-kind="u.avatarKind" :avatar-ref="u.avatarRef" :user-id="u.id" />
                <div class="member-text">
                  <div class="member-name">{{ u.name }}</div>
                  <div class="member-email">{{ u.email }}</div>
                </div>
                <span class="status-pill" :class="statusTone(u.status)">{{ statusLabel(u.status) }}</span>
                <button
                  type="button"
                  class="member-action add"
                  :disabled="pendingUserId === u.id"
                  title="加入组"
                  @click="addMember(u)"
                >
                  <span class="material-symbols-outlined">add</span>
                </button>
              </li>
            </ul>
            <div v-else class="ge-empty-members">
              {{ availableSearch ? '没有匹配的用户' : '所有用户都已在组里' }}
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.group-edit { width: 100%; }

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
  grid-template-columns: 320px 1fr;
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

/* ─── Transfer list (two-panel member manager) ─── */
.ge-transfer {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.ge-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 12px;
}
.ge-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 8px;
}
.ge-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.ge-panel-count {
  font-size: 12px;
  color: var(--text-3);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill, 999px);
  padding: 1px 8px;
  font-weight: 500;
}

.ge-search-row {
  position: relative;
  margin-bottom: 10px;
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
  height: 32px;
  padding: 0 12px 0 32px;
  font-size: 13px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.ge-search:focus {
  border-color: var(--accent);
}

.ge-empty-members {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}

.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 460px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
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
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.member-email {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-pill {
  display: inline-block;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: var(--radius-pill, 999px);
  white-space: nowrap;
  flex-shrink: 0;
}
.status-pill.good { background: var(--success-soft); color: var(--success); }
.status-pill.warn { background: var(--warning-soft); color: var(--warning-text); }
.status-pill.bad { background: var(--danger-soft); color: var(--danger); }

.member-action {
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}
.member-action.add:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent);
}
.member-action.remove:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: var(--danger);
}
.member-action:disabled { cursor: wait; opacity: 0.5; }
.member-action .material-symbols-outlined { font-size: 18px; }
</style>