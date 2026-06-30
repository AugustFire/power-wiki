<script setup lang="ts">
/**
 * UsersView — admin user list + create.
 *
 * Stage 4b scope:
 *   - List all users in a table (avatar, name, email, role, status, lastLogin)
 *   - Inline create form (email, name, role)
 *   - One-time initialPassword display after create
 *   - Quick actions: 禁用/启用, 重置密码
 *
 * Edit form (name, color, role) lives in /manager/users/:id → UserEditView.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useManagerActions } from '@/composables/useManagerActions'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import type { User } from '@power-wiki/shared'

const router = useRouter()
const uiStore = useUiStore()
const { confirm: askConfirm } = useConfirm()

const users = ref<User[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

const { showCreateUser: showCreate } = useManagerActions()
const createEmail = ref('')
const createName = ref('')
const createRole = ref<'admin' | 'user'>('user')
const creating = ref(false)
const createError = ref<string | null>(null)

// Reset the form fields every time the panel button transitions the form
// from closed → open. Also reset `showCreate` on mount so stale open state
// from a previous visit doesn't carry over.
onMounted(() => { showCreate.value = false })
watch(showCreate, (next, prev) => {
  if (next && !prev) {
    createEmail.value = ''
    createName.value = ''
    createRole.value = 'user'
    createError.value = null
  }
})

const oneTimePassword = ref<string | null>(null)
const oneTimeUser = ref<User | null>(null)
const copied = ref(false)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    users.value = (await api.admin.users.list()).items
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '加载用户列表失败'
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
  if (!createEmail.value.trim() || !createName.value.trim()) {
    createError.value = '邮箱和姓名不能为空'
    return
  }
  creating.value = true
  createError.value = null
  try {
    const { user, initialPassword } = await api.admin.users.create({
      email: createEmail.value.trim(),
      name: createName.value.trim(),
      role: createRole.value,
    })
    users.value.push(user)
    // Show the one-time password banner — close the create form only after
    // the admin acknowledges the password.
    oneTimeUser.value = user
    oneTimePassword.value = initialPassword
    copied.value = false
    showCreate.value = false
  } catch (e) {
    if (e instanceof ApiError && e.code === 'email_taken') {
      createError.value = '该邮箱已被使用'
    } else if (e instanceof ApiError) {
      createError.value = e.message
    } else {
      createError.value = '创建失败,请重试'
    }
  } finally {
    creating.value = false
  }
}

function dismissOneTime() {
  oneTimePassword.value = null
  oneTimeUser.value = null
  copied.value = false
}

async function copyPassword() {
  if (!oneTimePassword.value) return
  try {
    await navigator.clipboard.writeText(oneTimePassword.value)
    copied.value = true
  } catch {
    // Fallback: select the input for manual copy.
    const input = document.getElementById('otp-input') as HTMLInputElement | null
    input?.select()
  }
}

async function toggleDisable(u: User) {
  const ok = await askConfirm({
    title: u.status === 'disabled' ? '启用用户' : '禁用用户',
    message: u.status === 'disabled'
      ? `确定要启用 ${u.name} 吗?该用户将能够重新登录。`
      : `确定要禁用 ${u.name} 吗?该用户将无法登录。`,
    confirmText: u.status === 'disabled' ? '启用' : '禁用',
    danger: u.status !== 'disabled',
  })
  if (!ok) return
  try {
    const updated = u.status === 'disabled'
      ? await api.admin.users.enable(u.id)
      : await api.admin.users.disable(u.id)
    replaceUser(updated)
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '操作失败')
  }
}

const resettingUser = ref<string | null>(null)
async function resetPassword(u: User) {
  const ok = await askConfirm({
    title: '重置密码',
    message: `确定要将 ${u.name} 的密码重置为新的初始密码吗?该用户将被强制退出并需要重新设置密码。`,
    confirmText: '重置',
    danger: true,
  })
  if (!ok) return
  resettingUser.value = u.id
  try {
    const initialPassword = await api.admin.users.resetPassword(u.id)
    oneTimeUser.value = u
    oneTimePassword.value = initialPassword
    copied.value = false
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '重置失败')
  } finally {
    resettingUser.value = null
  }
}

function replaceUser(u: User) {
  const idx = users.value.findIndex((x) => x.id === u.id)
  if (idx >= 0) users.value[idx] = u
}

function openEdit(u: User) {
  void router.push(`/manager/users/${u.id}`)
}

const adminCount = computed(() => users.value.filter((u) => u.role === 'admin' && u.status !== 'disabled').length)

function formatLastLogin(ts: number | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

function statusLabel(s: User['status']): { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' } {
  switch (s) {
    case 'active': return { text: '正常', tone: 'good' }
    case 'must_reset_password': return { text: '需重置', tone: 'warn' }
    case 'disabled': return { text: '已禁用', tone: 'bad' }
  }
}

function roleLabel(r: User['role']): string {
  return r === 'admin' ? '管理员' : '普通用户'
}
</script>

<template>
  <div class="users-view">
    <header class="uv-header">
      <div>
        <h1 class="uv-title">用户</h1>
        <p class="uv-sub">共 {{ users.length }} 个用户,{{ adminCount }} 个管理员</p>
      </div>
    </header>

    <div v-if="loadError" class="uv-error">{{ loadError }}</div>

    <!-- One-time password banner — shown after create or admin-initiated reset. -->
    <div v-if="oneTimePassword" class="otp-banner" role="alert">
      <div class="otp-row">
        <span class="material-symbols-outlined otp-icon">key</span>
        <div class="otp-text">
          <div class="otp-title">
            {{ oneTimeUser?.name }} 的初始密码
          </div>
          <div class="otp-hint">
            请将以下密码复制给用户。该密码仅显示一次,关闭后无法再次查看。
          </div>
        </div>
      </div>
      <div class="otp-password-row">
        <input
          id="otp-input"
          class="otp-input"
          readonly
          :value="oneTimePassword"
          @focus="(e) => (e.target as HTMLInputElement).select()"
        />
        <button type="button" class="btn" @click="copyPassword">
          <span class="material-symbols-outlined btn-icon">{{ copied ? 'check' : 'content_copy' }}</span>
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
      </div>
      <div class="otp-actions">
        <button type="button" class="btn primary" @click="dismissOneTime">我已安全保存</button>
      </div>
    </div>

    <!-- Create form — inline panel. -->
    <div v-if="showCreate" class="create-panel">
      <h2 class="cp-title">创建用户</h2>
      <p class="cp-hint">新用户创建后必须使用初始密码登录并设置新密码。</p>

      <div v-if="createError" class="cp-error">{{ createError }}</div>

      <div class="cp-grid">
        <label class="field">
          <span class="field-label">姓名</span>
          <input
            v-model="createName"
            type="text"
            class="field-input"
            placeholder="例如:张三"
            :disabled="creating"
            autofocus
          />
        </label>
        <label class="field">
          <span class="field-label">邮箱</span>
          <input
            v-model="createEmail"
            type="email"
            class="field-input"
            placeholder="user@example.com"
            :disabled="creating"
          />
        </label>
        <label class="field">
          <span class="field-label">角色</span>
          <select v-model="createRole" class="field-input" :disabled="creating">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
      </div>
      <div class="cp-actions">
        <button type="button" class="btn ghost" :disabled="creating" @click="closeCreate">取消</button>
        <button type="button" class="btn primary" :disabled="creating" @click="onSubmitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </div>
    </div>

    <!-- User table -->
    <div v-if="loading && users.length === 0" class="uv-loading">加载中…</div>
    <table v-else-if="users.length > 0" class="users-table">
      <thead>
        <tr>
          <th class="col-user">用户</th>
          <th>角色</th>
          <th>状态</th>
          <th>最后登录</th>
          <th class="col-actions">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id" :class="{ 'is-disabled': u.status === 'disabled' }">
          <td>
            <div class="user-cell">
              <UserAvatar :size="32" :label="u.name" :color="u.color" />
              <div class="user-cell-text">
                <div class="user-name">{{ u.name }}</div>
                <div class="user-email">{{ u.email }}</div>
              </div>
            </div>
          </td>
          <td>
            <span class="role-pill" :class="u.role">{{ roleLabel(u.role) }}</span>
          </td>
          <td>
            <span class="status-pill" :class="statusLabel(u.status).tone">{{ statusLabel(u.status).text }}</span>
          </td>
          <td class="last-login">{{ formatLastLogin(u.lastLoginAt) }}</td>
          <td>
            <div class="row-actions">
              <button
                type="button"
                class="ra-btn"
                :title="u.status === 'disabled' ? '启用' : '禁用'"
                @click="toggleDisable(u)"
              >
                <span class="material-symbols-outlined">
                  {{ u.status === 'disabled' ? 'check_circle' : 'block' }}
                </span>
              </button>
              <button
                type="button"
                class="ra-btn"
                :disabled="resettingUser === u.id"
                title="重置密码"
                @click="resetPassword(u)"
              >
                <span class="material-symbols-outlined">lock_reset</span>
              </button>
              <button type="button" class="ra-btn" title="编辑" @click="openEdit(u)">
                <span class="material-symbols-outlined">edit</span>
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="uv-empty">还没有用户。</div>
  </div>
</template>

<style scoped>
.users-view { max-width: 1600px; }

/* ─── Header ─── */
.uv-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.uv-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-1);
  margin: 0;
}
.uv-sub {
  font-size: 13px;
  color: var(--text-3);
  margin: 4px 0 0 0;
}

.uv-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius-md, 4px);
  font-size: 14px;
  margin-bottom: 16px;
}

.uv-loading,
.uv-empty {
  padding: 48px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}

/* ─── One-time password banner ─── */
.otp-banner {
  background: var(--warning-soft);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md, 4px);
  padding: 16px 20px;
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.otp-row { display: flex; gap: 12px; align-items: flex-start; }
.otp-icon { font-size: 24px; color: var(--warning-text); flex-shrink: 0; }
.otp-text { flex: 1; }
.otp-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.otp-hint { font-size: 13px; color: var(--text-2); margin-top: 2px; }
.otp-password-row { display: flex; gap: 8px; }
.otp-input {
  flex: 1;
  height: 36px;
  padding: 0 12px;
  font-family: var(--font-mono, monospace);
  font-size: 14px;
  font-weight: 600;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  color: var(--text-1);
  outline: none;
}
.otp-input:focus { border-color: var(--accent); }
.otp-actions { display: flex; justify-content: flex-end; }

/* ─── Create form ─── */
.create-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 20px 24px;
  margin-bottom: 16px;
}
.cp-title { font-size: 16px; font-weight: 600; color: var(--text-1); margin: 0; }
.cp-hint { font-size: 13px; color: var(--text-3); margin: 4px 0 16px 0; }
.cp-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 8px 12px;
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  margin-bottom: 12px;
}
.cp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 200px;
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

/* ─── Table ─── */
.users-table {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  border-collapse: separate;
  border-spacing: 0;
  font-size: 14px;
  overflow: hidden;
}
.users-table th {
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 10px 16px;
  background: var(--bg-canvas);
  border-bottom: 1px solid var(--border);
}
.users-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
  vertical-align: middle;
}
.users-table tr:last-child td { border-bottom: 0; }
.users-table tr.is-disabled td { opacity: 0.55; }

.col-user { min-width: 240px; }
.col-actions { width: 1%; white-space: nowrap; text-align: right; }

.user-cell { display: flex; align-items: center; gap: 12px; }
.user-cell-text { min-width: 0; }
.user-name {
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-email {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.role-pill {
  display: inline-block;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-pill, 999px);
  background: var(--bg-subtle);
  color: var(--text-2);
}
.role-pill.admin {
  background: var(--purple-soft);
  color: var(--purple);
}

.status-pill {
  display: inline-block;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-pill, 999px);
}
.status-pill.good { background: var(--success-soft); color: var(--success); }
.status-pill.warn { background: var(--warning-soft); color: var(--warning-text); }
.status-pill.bad { background: var(--danger-soft); color: var(--danger); }
.status-pill.muted { background: var(--bg-subtle); color: var(--text-3); }

.last-login { color: var(--text-3); font-size: 13px; }

.row-actions { display: flex; gap: 4px; justify-content: flex-end; }
.ra-btn {
  width: 32px;
  height: 32px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  cursor: pointer;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--duration-fast) var(--ease-out);
}
.ra-btn:hover { background: var(--bg-canvas); color: var(--text-1); }
.ra-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ra-btn .material-symbols-outlined { font-size: 18px; }
</style>