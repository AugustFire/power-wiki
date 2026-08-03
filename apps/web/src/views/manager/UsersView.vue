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
 * M17: server-side filter — toolbar 直接 v-model 到 `useManagerStats.userFilters`,
 *   composable 内部 300ms debounce 触发 server refetch。后端 ILIKE / enum 精确匹配,
 *   命中后第 N 行的用户也能搜出来,不再受限于「默认 200 limit」瓶颈。
 *   `users.value` 现在是「filter + paginated」结果(已不再保留全量第一页),
 *   `usersTotal` 是 filter-matching 总行数,`usersSystemStats` 是 system-wide 概览。
 *
 * Edit form (name, color, role) lives in /manager/users/:id → UserEditView.
 */
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useManagerActions } from '@/composables/useManagerActions'
import { useManagerStats } from '@/composables/useManagerStats'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import type { User } from '@power-wiki/shared'

const router = useRouter()
const uiStore = useUiStore()
const { confirm: askConfirm } = useConfirm()
const {
  users,
  usersLoading,
  usersTotal,
  usersSystemStats,
  userFilters,
  hasActiveFilter,
  clearUserFilters,
  ensureUsersLoaded,
  upsertUser,
  /* P1-13 · 分页状态 + 动作 —— 从 composable 暴露的派生 computed
   * 直接消费。currentPage 是 1-based 显示值,totalPages 是页码上
   * 限。goToPageUsers 接收 1-based UI 输入,内部 floor-convert。*/
  usersCurrentPage,
  usersTotalPages,
  usersPageSize,
  usersPageStart,
  usersPageEnd,
  usersHasPrevPage,
  usersHasNextPage,
  nextPageUsers,
  prevPageUsers,
  goToPageUsers,
} = useManagerStats()

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
  loadError.value = null
  try {
    await ensureUsersLoaded()
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '加载用户列表失败'
    uiStore.setError(loadError.value)
  }
}

onMounted(() => { void load() })

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
    upsertUser(user)
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
    upsertUser(updated)
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

/**
 * 行级直接注销:不进编辑页就能完成(M16 起跟编辑页内的内联面板行为
 * 等价,同一 API、同样的 sweep)。useConfirm 危险对话框 + 强文案,
 * 不再要求 typed-name —— 内部 R&D 工具够用,用户名已在 confirm message
 * 里显眼展示。
 */
async function deregisterUser(u: User) {
  const ok = await askConfirm({
    title: '注销用户',
    message:
      `确定要注销「${u.name}」吗?该操作不可撤销 —— \n` +
      '· 清除姓名、邮箱、密码、头像\n' +
      '· 清除该用户的所有组成员关系、关注、点赞与未读通知\n' +
      '· 移除该用户的直接空间授权与页面级限制\n' +
      '· 已创建的页面与评论保留,署名变为「已注销用户」',
    requireText: u.name,
    confirmText: '确认注销',
    cancelText: '取消',
    danger: true,
  })
  if (!ok) return
  try {
    const updated = await api.admin.users.anonymize(u.id)
    upsertUser(updated)
    uiStore.notify(`已注销用户「${u.name}」`)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'last_admin') {
      uiStore.setError('不能注销最后一个管理员')
    } else if (e instanceof ApiError && e.code === 'self_anonymize') {
      uiStore.setError('不能注销自己的账号')
    } else {
      uiStore.setError(e instanceof ApiError ? e.message : '注销失败,请重试')
    }
  }
}

function openEdit(u: User) {
  void router.push(`/manager/users/${u.id}`)
}

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
    case 'anonymized': return { text: '已注销', tone: 'muted' }
  }
}

function roleLabel(r: User['role']): string {
  return r === 'admin' ? '管理员' : '普通用户'
}

/* P1-13 · 跳页输入框 —— 受控字符串 + Enter 提交,避免每次按数字
 * 都触发 goToPageUsers(连续按 1 + 2 + 3 只想跳到 123,不是先 1 再 12
 * 再 123)。失焦时如果 value 跟 currentPage 一致就不动,否则兜底
 * 提交。校验:输入必须是 1..totalPages 整数,否则回写合法值。*/
const jumpPageInput = ref('')
watch(usersCurrentPage, (page) => {
  /* 服务端响应回填:如果 input 失焦时仍为空 / 跟当前不一致,
   * 把合法值塞回去。watch 是 lazy flush,所以用户输入期间不闪烁。*/
  if (document.activeElement !== document.getElementById('uv-jump-page')) {
    jumpPageInput.value = String(page)
  }
}, { immediate: true })
function submitJumpPage(): void {
  const trimmed = jumpPageInput.value.trim()
  const target = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(target)) {
    jumpPageInput.value = String(usersCurrentPage.value)
    return
  }
  const clamped = Math.max(1, Math.min(target, usersTotalPages.value))
  if (clamped !== target) {
    jumpPageInput.value = String(clamped)
  }
  if (clamped !== usersCurrentPage.value) {
    void goToPageUsers(clamped)
  }
}
</script>

<template>
  <div class="users-view">
    <header class="uv-header">
      <div>
        <h1 class="uv-title">用户</h1>
        <p class="uv-sub">
          <template v-if="hasActiveFilter()">
            找到 {{ usersTotal }} 个用户,系统共 {{ usersSystemStats?.totalCount ?? 0 }} 个用户、{{ usersSystemStats?.adminCount ?? 0 }} 个管理员
          </template>
          <template v-else>
            共 {{ usersSystemStats?.totalCount ?? usersTotal }} 个用户,{{ usersSystemStats?.adminCount ?? 0 }} 个管理员
          </template>
        </p>
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

    <!-- Filter toolbar + 表格合并到同一个 card shell,视觉上一体。
         工具栏底边 1px 切到表头,搜索框做成「主输入框」无外部 label,
         icon + placeholder 自带语义;两个 select 跟搜索框之间用
         1px 分隔线分组。 -->
    <div v-if="users.length > 0 || hasActiveFilter()" class="users-shell">
      <div class="filter-group filter-group-search">
        <div class="search-input-wrap">
          <span class="material-symbols-outlined search-icon">search</span>
          <input
            id="uv-search"
            v-model="userFilters.q"
            type="text"
            class="input search-input"
            placeholder="按姓名或邮箱搜索…"
            autocomplete="off"
          />
          <button
            v-if="userFilters.q"
            type="button"
            class="search-clear"
            title="清空搜索"
            @click="userFilters.q = ''"
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>
      <div class="filter-group-select-wrapper">
        <div class="filter-group filter-group-select">
          <label class="filter-label" for="uv-status">状态</label>
          <select id="uv-status" v-model="userFilters.status" class="select">
            <option :value="undefined">全部状态</option>
            <option value="active">正常</option>
            <option value="must_reset_password">需重置密码</option>
            <option value="disabled">已禁用</option>
            <option value="anonymized">已注销</option>
          </select>
        </div>
        <div class="filter-group filter-group-select">
          <label class="filter-label" for="uv-role">角色</label>
          <select id="uv-role" v-model="userFilters.role" class="select">
            <option :value="undefined">全部角色</option>
            <option value="admin">管理员</option>
            <option value="user">普通用户</option>
          </select>
        </div>
      </div>
      <button
        v-if="hasActiveFilter()"
        type="button"
        class="clear-filters"
        @click="clearUserFilters"
      >
        <span class="material-symbols-outlined">filter_alt_off</span>
        <span>清空筛选</span>
      </button>
    </div>

    <!-- User table — 三态:加载中 / 表格 / 空(分有用户无匹配 vs 无用户)。 -->
    <div v-if="usersLoading && users.length === 0" class="uv-loading">加载中…</div>
    <template v-else>
      <table v-if="users.length > 0" class="users-table-shell">
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
          <tr v-for="u in users" :key="u.id" :class="{ 'is-disabled': u.status === 'disabled' || u.status === 'anonymized' }">
          <td>
            <div class="user-cell">
              <UserAvatar :size="32" :label="u.name" :color="u.color" :avatar-kind="u.avatarKind" :avatar-ref="u.avatarRef" :user-id="u.id" />
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
              <!-- 禁用/启用 — anonymized 是终态,后端 enable 端点也会拒。
                   整按钮隐藏代替 disabled,避免「点了没反应」的 dead-end 体验。 -->
              <button
                v-if="u.status !== 'anonymized'"
                type="button"
                class="ra-btn"
                :title="u.status === 'disabled' ? '启用' : '禁用'"
                @click="toggleDisable(u)"
              >
                <span class="material-symbols-outlined">
                  {{ u.status === 'disabled' ? 'lock_open' : 'lock' }}
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
              <!-- 注销 — 不可逆的破坏性操作,直接列在列表就能用。
                   useConfirm 危险对话框阻击误点;anonymized 行不再显示。 -->
              <button
                v-if="u.status !== 'anonymized'"
                type="button"
                class="ra-btn ra-btn-danger"
                title="注销用户"
                @click="deregisterUser(u)"
              >
                <span class="material-symbols-outlined">person_off</span>
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- P1-13 · 分页 footer —— table 下方独立一行。左侧 counter(显
         示区间 + 总数;空状态写「—」、loading 写「加载中…」),中部跳页
         input + 总页数,右侧 prev / next 两个 icon button。整块视觉重
         量轻于 table row(14px 文本、text-3 底色),不抢表头。
         hasMore 不再用 —— 改用 totalPages 派生。v-if users.length 让
         「当前页没数据」也展示出来给管理员「哦,翻过头了」反馈。-->
    <div v-if="usersTotal > 0 || usersLoading" class="users-pagination">
      <div class="users-pagination-counter">
        <template v-if="usersLoading && users.length === 0">
          加载中…
        </template>
        <template v-else-if="usersTotal === 0">
          共 0 条
        </template>
        <template v-else>
          显示 <strong>{{ usersPageStart }}-{{ usersPageEnd }}</strong>
          · 共 <strong>{{ usersTotal }}</strong> 条
        </template>
      </div>

      <div class="users-pagination-jump">
        <button
          type="button"
          class="pag-btn"
          :disabled="!usersHasPrevPage || usersLoading"
          title="上一页"
          @click="prevPageUsers"
        >
          <span class="material-symbols-outlined">chevron_left</span>
        </button>
        <label class="pag-jump">
          第 <input
            id="uv-jump-page"
            v-model="jumpPageInput"
            type="text"
            inputmode="numeric"
            class="pag-jump-input"
            :disabled="usersLoading"
            @keydown.enter="submitJumpPage"
            @blur="submitJumpPage"
          /> 页 · 共 <strong>{{ usersTotalPages }}</strong> 页
        </label>
        <button
          type="button"
          class="pag-btn"
          :disabled="!usersHasNextPage || usersLoading"
          title="下一页"
          @click="nextPageUsers"
        >
          <span class="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
    </div>
    </div>
    <div v-else-if="!hasActiveFilter() && !usersLoading" class="uv-empty">还没有用户。</div>
    <EmptyState
      v-else
      icon="search_off"
      title="没有匹配的用户"
      hint="试着调整搜索关键词或清空筛选条件"
      size="md"
    >
      <button type="button" class="btn ghost" @click="clearUserFilters">清空筛选</button>
    </EmptyState>
    </template>
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
/* keep table class around for the EmptyState fallback only */
.users-table { display: none; }

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
/* 注销(不可逆破坏性操作)— danger token,鼠标悬停加深 */
.ra-btn-danger { color: var(--danger); }
.ra-btn-danger:hover { background: var(--danger-soft); color: var(--danger); }

/* ─── Filter toolbar + 表格合并到同一个 card shell ─── */
.users-shell {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  overflow: hidden;
  box-shadow: var(--shadow-sm, 0 1px 1px rgba(9, 30, 66, 0.13), 0 0 1px rgba(9, 30, 66, 0.13));
}
.users-shell > .toolbar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 16px 24px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.users-table-shell {
  width: 100%;
  background: var(--bg);
  border-collapse: separate;
  border-spacing: 0;
  font-size: 14px;
}
.users-table-shell th {
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
.users-table-shell td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
  vertical-align: middle;
}
.users-table-shell tr:last-child td { border-bottom: 0; }
.users-table-shell tr.is-disabled td { opacity: 0.55; }
.filter-group {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 0 0 auto;
  position: relative;
  padding-right: 28px;
}
.filter-group:not(:last-child)::after {
  content: '';
  display: block;
  width: 1px;
  height: 20px;
  background: var(--border);
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
}
.filter-group:last-child { padding-right: 0; }
.filter-group-search { width: 400px; flex-shrink: 0; }
.filter-group-select { flex: 0 0 auto; }
.filter-group-select-wrapper {
  display: inline-flex;
  align-items: center;
  gap: 28px;
  padding-right: 28px;
  position: relative;
}
.filter-group-select-wrapper::after {
  content: '';
  display: block;
  width: 1px;
  height: 20px;
  background: var(--border);
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
}
.filter-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  flex-shrink: 0;
  user-select: none;
}
.input, .select {
  height: 32px;
  padding: 0 10px;
  font-size: 13px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.input:hover, .select:hover { border-color: var(--border-strong); }
.input:focus, .select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.select { padding-right: 28px; cursor: pointer; }
.filter-group .select { min-width: 156px; }

.search-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 10px;
  font-size: var(--icon-md, 16px);
  color: var(--text-3);
  pointer-events: none;
}
.search-input { padding-left: 32px; padding-right: 28px; width: 100%; }
.search-clear {
  position: absolute;
  right: 4px;
  width: 22px;
  height: 22px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.search-clear:hover { background: var(--bg-subtle); color: var(--text-1); }
.search-clear .material-symbols-outlined { font-size: var(--icon-sm, 14px); }

.clear-filters {
  margin-left: auto;
  height: 32px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-radius: var(--radius-md, 4px);
  cursor: pointer;
}
.clear-filters:hover { background: var(--bg-subtle); color: var(--text-1); }
.clear-filters .material-symbols-outlined { font-size: var(--icon-md, 16px); }

/* ─── P1-13 · 分页 footer ──────────────────────────────────────────
 * 视觉节奏:跟 table 平接,border-top 跟上方 thead 同 1px,内 padding
 * 12 / 16 跟 td 一致,让视觉是「table 的延伸」而非额外控件区。布局
 * flex space-between:左 counter,右 jump + prev / next。loading
 * 态 counter 写「加载中…」,hover/focus 样式跟现有 ra-btn 同款。
 * 「第 N 页」input 是 controlled string(不是 number),允许用户临时清
 * 空后重新填,Enter / blur 才 commit。*/
.users-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-canvas);
  font-size: 13px;
  color: var(--text-2);
}
.users-pagination-counter strong,
.users-pagination-jump strong {
  color: var(--text-1);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.users-pagination-jump {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pag-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 3px);
  background: var(--bg);
  color: var(--text-2);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.pag-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-1);
}
.pag-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pag-btn .material-symbols-outlined {
  font-size: 18px !important;
  line-height: 1;
}
.pag-jump {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 13px;
}
.pag-jump-input {
  width: 44px;
  height: 28px;
  padding: 0 6px;
  text-align: center;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 3px);
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.pag-jump-input:hover { border-color: var(--border-strong); }
.pag-jump-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.pag-jump-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>