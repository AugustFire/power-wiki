<script setup lang="ts">
/**
 * PeopleView — Stage 5d.
 *
 * Combined "人员" (people) page that hosts both users and user-groups
 * behind a top tab bar. Replaces the separate /manager/users and
 * /manager/groups pages; the old paths redirect to ?tab=users|groups
 * (see router/index.ts) for back-compat.
 *
 * M17: users tab 的 search(name/email) + 状态 + 角色走服务端筛选。
 *   `users.value` 是当前筛选下的分页结果,`usersTotal` 是命中总数；
 *   `usersSystemStats` 保持系统级口径,供标题与右侧概览使用。Groups tab
 *   不挂 filter(状态/角色概念不适用)。
 *
 * Implementation note: the two tabs are inlined rather than factored
 * into sub-components because the existing UsersView / GroupsView
 * each lean on module-level refs from `useManagerActions()` for
 * cross-component create-form toggling, which is awkward to refactor
 * into props. The duplication is bounded and the two halves are
 * independent (different data shape, different columns).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useManagerActions } from '@/composables/useManagerActions'
import { useManagerStats } from '@/composables/useManagerStats'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import type { User, UserGroup } from '@power-wiki/shared'

const route = useRoute()
const router = useRouter()
const uiStore = useUiStore()
const pagesStore = usePagesStore()
const { confirm: askConfirm } = useConfirm()
useDocumentTitle(() => '成员管理')

/* ─── Tab routing ───────────────────────────────────────────────────── */
type Tab = 'users' | 'groups'
const activeTab = computed<Tab>(() =>
  route.query.tab === 'groups' ? 'groups' : 'users',
)
function switchTab(t: Tab) {
  void router.replace({ name: 'manager-people', query: { tab: t } })
}

/* ─── Shared data (Stage B.3) ─────────────────────────────────────────
 * Both this view's main table AND the right-side PeopleContextPanel
 * read from `useManagerStats()`. Module-level singleton + promise-
 * cached fetch: first caller triggers the request, the second caller's
 * await resolves against the same in-flight promise. Net effect:
 * /manager/people mount fires `users?limit=200` + `groups?limit=200`
 * exactly ONCE total — no per-component fanout.
 *
 * `loadMore` chains onto the same array with offset management; the
 * "load more" button at the bottom of each table uses it. CRUD ops
 * upsert in-place via the sync helpers so both consumers stay aligned.
 */
const {
  users,
  groups,
  usersLoading,
  groupsLoading,
  usersHasMore,
  groupsHasMore,
  usersTotal,
  usersSystemStats,
  userFilters,
  hasActiveFilter,
  clearUserFilters,
  ensureUsersLoaded,
  ensureGroupsLoaded,
  loadMoreUsers,
  loadMoreGroups,
  upsertUser,
  removeUser,
  upsertGroup,
  removeGroup,
} = useManagerStats()

/* ─── User state ───────────────────────────────────────────────────── */
const { showCreateUser } = useManagerActions()
const createUserEmail = ref('')
const createUserName = ref('')
const createUserRole = ref<'admin' | 'user'>('user')
const creatingUser = ref(false)
const createUserError = ref<string | null>(null)
const userLoadError = ref<string | null>(null)

const otpPassword = ref<string | null>(null)
const otpUser = ref<User | null>(null)
const otpCopied = ref(false)
const resettingUserId = ref<string | null>(null)

onMounted(() => { showCreateUser.value = false })
watch(showCreateUser, (next, prev) => {
  if (next && !prev) {
    createUserEmail.value = ''
    createUserName.value = ''
    createUserRole.value = 'user'
    createUserError.value = null
  }
})

async function submitCreateUser() {
  if (creatingUser.value) return
  if (!createUserEmail.value.trim() || !createUserName.value.trim()) {
    createUserError.value = '邮箱和姓名不能为空'
    return
  }
  creatingUser.value = true
  createUserError.value = null
  try {
    const { user, initialPassword } = await api.admin.users.create({
      email: createUserEmail.value.trim(),
      name: createUserName.value.trim(),
      role: createUserRole.value,
    })
    upsertUser(user)
    otpUser.value = user
    otpPassword.value = initialPassword
    otpCopied.value = false
    showCreateUser.value = false
  } catch (e) {
    if (e instanceof ApiError && e.code === 'email_taken') {
      createUserError.value = '该邮箱已被使用'
    } else if (e instanceof ApiError) {
      createUserError.value = e.message
    } else {
      createUserError.value = '创建失败,请重试'
    }
  } finally {
    creatingUser.value = false
  }
}

function dismissOtp() {
  otpPassword.value = null
  otpUser.value = null
  otpCopied.value = false
}

async function copyOtp() {
  if (!otpPassword.value) return
  try {
    await navigator.clipboard.writeText(otpPassword.value)
    otpCopied.value = true
  } catch {
    const input = document.getElementById('pv-otp-input') as HTMLInputElement | null
    input?.select()
  }
}

async function toggleDisableUser(u: User) {
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

async function resetUserPassword(u: User) {
  const ok = await askConfirm({
    title: '重置密码',
    message: `确定要将 ${u.name} 的密码重置为新的初始密码吗?该用户将被强制退出并需要重新设置密码。`,
    confirmText: '重置',
    danger: true,
  })
  if (!ok) return
  resettingUserId.value = u.id
  try {
    const initialPassword = await api.admin.users.resetPassword(u.id)
    otpUser.value = u
    otpPassword.value = initialPassword
    otpCopied.value = false
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '重置失败')
  } finally {
    resettingUserId.value = null
  }
}

/**
 * 行级直接注销:不进编辑页就能完成。M16 起跟编辑页内的内联面板
 * 行为等价(同一 API、同样的 sweep),只是确认方式用 useConfirm
 * 危险对话框 + 强文案,不再要求 typed-name(内部 R&D 工具够用,且
 * 用户名已在 confirm message 里显眼展示)。
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

function openUserEdit(u: User) {
  void router.push(`/manager/people/users/${u.id}`)
}

function formatLastLogin(ts: number | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

function userStatusLabel(s: User['status']): { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' } {
  switch (s) {
    case 'active': return { text: '正常', tone: 'good' }
    case 'must_reset_password': return { text: '需重置', tone: 'warn' }
    case 'disabled': return { text: '已禁用', tone: 'bad' }
    case 'anonymized': return { text: '已注销', tone: 'muted' }
  }
}

function userRoleLabel(r: User['role']): string {
  return r === 'admin' ? '管理员' : '普通用户'
}

/* ─── Group state ──────────────────────────────────────────────────── */
const { showCreateGroup } = useManagerActions()
const createGroupName = ref('')
const createGroupDesc = ref('')
const creatingGroup = ref(false)
const createGroupError = ref<string | null>(null)
const groupLoadError = ref<string | null>(null)

onMounted(() => { showCreateGroup.value = false })
watch(showCreateGroup, (next, prev) => {
  if (next && !prev) {
    createGroupName.value = ''
    createGroupDesc.value = ''
    createGroupError.value = null
  }
})

async function submitCreateGroup() {
  if (creatingGroup.value) return
  if (!createGroupName.value.trim()) {
    createGroupError.value = '名称不能为空'
    return
  }
  creatingGroup.value = true
  createGroupError.value = null
  try {
    const created = await api.admin.groups.create({
      name: createGroupName.value.trim(),
      description: createGroupDesc.value.trim() || undefined,
    })
    upsertGroup(created)
    showCreateGroup.value = false
  } catch (e) {
    createGroupError.value = e instanceof ApiError ? e.message : '创建失败'
  } finally {
    creatingGroup.value = false
  }
}

async function deleteGroup(g: UserGroup) {
  const ok = await askConfirm({
    title: '删除用户组',
    message: `确定要删除用户组「${g.name}」吗?该组下的所有成员关系将一并删除,组内用户不会被删除。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.admin.groups.delete(g.id)
    removeGroup(g.id)
    void pagesStore.refresh()
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '删除失败')
  }
}

function openGroupEdit(g: UserGroup) {
  void router.push(`/manager/people/groups/${g.id}`)
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}

/* ─── Tab loading — Mount loads only the active tab; switching tabs
 *     triggers the other side on first switch. ensure*Loaded() is
 *     idempotent: if the cache already has data, it returns immediately
 *     and shares with the right-side PeopleContextPanel. ─── */
async function loadActiveTab() {
  if (activeTab.value === 'users') userLoadError.value = null
  else groupLoadError.value = null

  try {
    if (activeTab.value === 'users') await ensureUsersLoaded()
    else await ensureGroupsLoaded()
  } catch (e) {
    const message = e instanceof ApiError
      ? e.message
      : activeTab.value === 'users' ? '加载用户列表失败' : '加载用户组失败'
    if (activeTab.value === 'users') userLoadError.value = message
    else groupLoadError.value = message
    uiStore.setError(message)
  }
}

onMounted(() => {
  void loadActiveTab()
})

/** Switch tabs — fetch the other side on first activation. */
watch(activeTab, (t) => {
  void loadActiveTab()
})
</script>

<template>
  <div class="people-view">
    <div class="view-content">
    <header class="pv-header">
      <div class="pv-header-text">
        <h1 class="pv-title">人员</h1>
        <p class="pv-sub">
          <template v-if="activeTab === 'users' && hasActiveFilter()">
            找到 {{ usersTotal }} 个用户,系统共 {{ usersSystemStats?.totalCount ?? 0 }} 个用户、{{ usersSystemStats?.adminCount ?? 0 }} 个管理员 · {{ groups.length }} 个用户组
          </template>
          <template v-else>
            共 {{ usersSystemStats?.totalCount ?? usersTotal }} 个用户,{{ usersSystemStats?.adminCount ?? 0 }} 个管理员 · {{ groups.length }} 个用户组
          </template>
        </p>
      </div>
      <!-- Active tab determines which create button shows. Showing both
           was confusing because the form opens inside the active tab's
           section — clicking "创建用户组" while on the users tab had
           no visible effect. -->
      <div class="pv-header-actions">
        <button
          v-if="activeTab === 'users'"
          type="button"
          class="pv-action pv-action-primary"
          @click="showCreateUser = true"
        >
          <span class="material-symbols-outlined">person_add</span>
          <span>创建新用户</span>
        </button>
        <button
          v-if="activeTab === 'groups'"
          type="button"
          class="pv-action pv-action-primary"
          @click="showCreateGroup = true"
        >
          <span class="material-symbols-outlined">group_add</span>
          <span>创建新用户组</span>
        </button>
      </div>
    </header>

    <!-- Tab bar: keeps ?tab= in URL so refresh / deep-link land on the right pane -->
    <nav class="pv-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="pv-tab"
        :class="{ active: activeTab === 'users' }"
        :aria-selected="activeTab === 'users'"
        @click="switchTab('users')"
      >
        <span class="material-symbols-outlined">person</span>
        <span>用户</span>
        <span class="pv-tab-count">{{ usersSystemStats?.totalCount ?? usersTotal }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="pv-tab"
        :class="{ active: activeTab === 'groups' }"
        :aria-selected="activeTab === 'groups'"
        @click="switchTab('groups')"
      >
        <span class="material-symbols-outlined">workspaces</span>
        <span>用户组</span>
        <span class="pv-tab-count">{{ groups.length }}</span>
      </button>
    </nav>

    <!-- ─── Users pane ─── -->
    <section v-show="activeTab === 'users'" class="pv-pane">
      <div v-if="activeTab === 'users' && userLoadError" class="uv-error">{{ userLoadError }}</div>

      <div v-if="otpPassword" class="otp-banner" role="alert">
        <div class="otp-row">
          <span class="material-symbols-outlined otp-icon">key</span>
          <div class="otp-text">
            <div class="otp-title">{{ otpUser?.name }} 的初始密码</div>
            <div class="otp-hint">请将以下密码复制给用户。该密码仅显示一次,关闭后无法再次查看。</div>
          </div>
        </div>
        <div class="otp-password-row">
          <input
            id="pv-otp-input"
            class="otp-input"
            readonly
            :value="otpPassword"
            @focus="(e) => (e.target as HTMLInputElement).select()"
          />
          <button type="button" class="btn" @click="copyOtp">
            <span class="material-symbols-outlined btn-icon">{{ otpCopied ? 'check' : 'content_copy' }}</span>
            <span>{{ otpCopied ? '已复制' : '复制' }}</span>
          </button>
        </div>
        <div class="otp-actions">
          <button type="button" class="btn primary" @click="dismissOtp">我已安全保存</button>
        </div>
      </div>

      <div v-if="showCreateUser" class="create-panel">
        <h2 class="cp-title">创建用户</h2>
        <p class="cp-hint">新用户创建后必须使用初始密码登录并设置新密码。</p>
        <div v-if="createUserError" class="cp-error">{{ createUserError }}</div>
        <div class="cp-grid">
          <label class="field">
            <span class="field-label">姓名</span>
            <input v-model="createUserName" type="text" class="field-input" placeholder="例如:张三" :disabled="creatingUser" autofocus />
          </label>
          <label class="field">
            <span class="field-label">邮箱</span>
            <input v-model="createUserEmail" type="email" class="field-input" placeholder="user@example.com" :disabled="creatingUser" />
          </label>
          <label class="field">
            <span class="field-label">角色</span>
            <select v-model="createUserRole" class="field-input" :disabled="creatingUser">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </label>
        </div>
        <div class="cp-actions">
          <button type="button" class="btn ghost" :disabled="creatingUser" @click="showCreateUser = false">取消</button>
          <button type="button" class="btn primary" :disabled="creatingUser" @click="submitCreateUser">
            {{ creatingUser ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>

      <div v-if="usersLoading && users.length === 0" class="uv-loading">加载中…</div>
      <template v-else>
      <!-- Filter toolbar (M17) — 仅 users tab 显示,groups tab 不适用
           状态/角色概念。视觉上跟下面的表格连成一体:工具栏底边去掉,
           表格顶边内嵌,搜索框宽度按内容自适应而不是 1 1 280。-->
      <!-- Filter toolbar (M17) — 搜索框做成「主输入框」:无外部 label,
           icon + placeholder 自带语义;两个 select 跟搜索框之间用 24px
           间距 + 1px 分隔线分组;整组左 padding 24px,「搜索」字样从
           左侧框线往里收。 -->
      <div v-if="users.length > 0 || hasActiveFilter()" class="users-shell">
        <div class="filter-group filter-group-search">
          <div class="search-input-wrap">
            <span class="material-symbols-outlined search-icon">search</span>
            <input
              id="pv-search"
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
            <label class="filter-label" for="pv-status">状态</label>
            <select id="pv-status" v-model="userFilters.status" class="select">
              <option :value="undefined">全部状态</option>
              <option value="active">正常</option>
              <option value="must_reset_password">需重置密码</option>
              <option value="disabled">已禁用</option>
              <option value="anonymized">已注销</option>
            </select>
          </div>
          <div class="filter-group filter-group-select">
            <label class="filter-label" for="pv-role">角色</label>
            <select id="pv-role" v-model="userFilters.role" class="select">
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
      <div v-if="users.length > 0 || hasActiveFilter()" class="users-shell">
        <table class="users-table">
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
            <td><span class="role-pill" :class="u.role">{{ userRoleLabel(u.role) }}</span></td>
            <td><span class="status-pill" :class="userStatusLabel(u.status).tone">{{ userStatusLabel(u.status).text }}</span></td>
            <td class="last-login">{{ formatLastLogin(u.lastLoginAt) }}</td>
            <td>
              <div class="row-actions">
                <!-- 禁用/启用 — anonymized 是终态,整按钮隐藏(后端 enable
                     端点也会拒,见 adminUsers.ts M16)。 -->
                <button v-if="u.status !== 'anonymized'" type="button" class="ra-btn" :title="u.status === 'disabled' ? '启用' : '禁用'" @click="toggleDisableUser(u)">
                  <span class="material-symbols-outlined">{{ u.status === 'disabled' ? 'lock_open' : 'lock' }}</span>
                </button>
                <button type="button" class="ra-btn" :disabled="resettingUserId === u.id" title="重置密码" @click="resetUserPassword(u)">
                  <span class="material-symbols-outlined">lock_reset</span>
                </button>
                <button type="button" class="ra-btn" title="编辑" @click="openUserEdit(u)">
                  <span class="material-symbols-outlined">edit</span>
                </button>
                <!-- 注销 — 不可逆的破坏性操作,直接列在列表就能用,
                     不必绕编辑页。useConfirm 危险对话框阻击误点。 -->
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
      </div>
      <EmptyState v-else-if="!hasActiveFilter() && !usersLoading" icon="group" title="还没有用户" hint="用户首次登录后会出现在这里。" size="sm" />
      <EmptyState
        v-else
        icon="search_off"
        title="没有匹配的用户"
        hint="试着调整搜索关键词或清空筛选条件"
        size="sm"
      >
        <button type="button" class="btn ghost" @click="clearUserFilters">清空筛选</button>
      </EmptyState>
      </template>

      <!-- Load-more 跟 table 同生死 — filter 空匹配时上方已是 EmptyState,
           再叠一个「已加载全部」footer 没意义。 -->
      <div v-if="users.length > 0" class="load-more-row">
        <button
          v-if="usersHasMore"
          type="button"
          class="btn ghost load-more-btn"
          :disabled="usersLoading"
          @click="loadMoreUsers"
        >
          {{ usersLoading ? '加载中…' : '加载更多' }}
        </button>
        <div v-else class="load-more-end">— 已加载全部 —</div>
      </div>
    </section>

    <!-- ─── Groups pane ─── -->
    <section v-show="activeTab === 'groups'" class="pv-pane">
      <div v-if="activeTab === 'groups' && groupLoadError" class="uv-error">{{ groupLoadError }}</div>

      <div v-if="showCreateGroup" class="create-panel">
        <h2 class="cp-title">创建用户组</h2>
        <div v-if="createGroupError" class="cp-error">{{ createGroupError }}</div>
        <div class="cp-grid">
          <label class="field">
            <span class="field-label">名称</span>
            <input v-model="createGroupName" type="text" class="field-input" placeholder="例如:工程组" :disabled="creatingGroup" maxlength="64" autofocus />
          </label>
          <label class="field">
            <span class="field-label">描述(可选)</span>
            <input v-model="createGroupDesc" type="text" class="field-input" placeholder="一句话说明这个组的用途" :disabled="creatingGroup" maxlength="200" />
          </label>
        </div>
        <div class="cp-actions">
          <button type="button" class="btn ghost" :disabled="creatingGroup" @click="showCreateGroup = false">取消</button>
          <button type="button" class="btn primary" :disabled="creatingGroup" @click="submitCreateGroup">
            {{ creatingGroup ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>

      <div v-if="groupsLoading && groups.length === 0" class="uv-loading">加载中…</div>
      <EmptyState v-else-if="groups.length === 0" icon="workspaces" title="还没有用户组" hint="创建用户组以批量管理用户的空间访问权限。" size="sm" />
      <div v-else class="gv-grid">
        <div
          v-for="g in groups"
          :key="g.id"
          class="gv-card"
          role="button"
          tabindex="0"
          @click="openGroupEdit(g)"
          @keydown.enter="openGroupEdit(g)"
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
              <span class="gcs-value">{{ g.memberCount ?? 0 }}</span>
              <span class="gcs-label">成员</span>
            </div>
            <div class="gc-stat">
              <span class="gcs-value">{{ formatDate(g.createdAt) }}</span>
              <span class="gcs-label">创建时间</span>
            </div>
          </div>
          <div class="gc-actions">
            <button type="button" class="ra-btn" title="删除" @click.stop="deleteGroup(g)">
              <span class="material-symbols-outlined">delete</span>
            </button>
            <span class="gc-open"><span class="material-symbols-outlined">arrow_forward</span></span>
          </div>
        </div>
      </div>

      <div v-if="groups.length > 0" class="load-more-row">
        <button
          v-if="groupsHasMore"
          type="button"
          class="btn ghost load-more-btn"
          :disabled="groupsLoading"
          @click="loadMoreGroups"
        >
          {{ groupsLoading ? '加载中…' : '加载更多' }}
        </button>
        <div v-else class="load-more-end">— 已加载全部 —</div>
      </div>
    </section>
    </div>
  </div>
</template>

<style scoped>
/* Self-constraining container. `margin: 0 auto` centers it in the
   main column — same pattern as the editor's `.content-inner` in
   components.css:431-435. With subnav=280 (matches --sidebar-w) and
   view-content max-width=1680 (matches .content-inner), the manager
   content area is at the same X and width as the editor's content
   area, modulo the difference in the right column width (320 vs
   the editor's ToC 240) which shifts the centering by ~40px on 2K. */
.people-view { width: 100%; }
.view-content {
  max-width: 1680px;
  margin: 0 auto;
}

.pv-header { margin-bottom: 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.pv-header-text { min-width: 0; }
.pv-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0; }
.pv-sub { font-size: 13px; color: var(--text-3); margin: 4px 0 0 0; }
.pv-header-actions { display: flex; gap: 8px; flex-shrink: 0; }
.pv-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-sans, inherit);
  color: var(--text-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
  white-space: nowrap;
}
.pv-action:hover { background: var(--bg-subtle); color: var(--text-1); }
.pv-action-primary {
  background: var(--accent);
  color: #FFFFFF;
  border-color: var(--accent);
}
.pv-action-primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: #FFFFFF;
}
.pv-action .material-symbols-outlined { font-size: 18px; }

.pv-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}
.pv-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 12px;
  font-size: 14px;
  font-weight: 500;
  font-family: var(--font-sans, inherit);
  color: var(--text-3);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
  margin-bottom: -1px;
  user-select: none;
}
.pv-tab:hover { color: var(--text-1); }
.pv-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.pv-tab .material-symbols-outlined {
  font-size: 18px;
}
.pv-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  background: var(--bg-subtle);
  color: var(--text-3);
  border-radius: var(--radius-pill, 999px);
}
.pv-tab.active .pv-tab-count {
  background: var(--accent-soft);
  color: var(--accent);
}

.pv-pane { padding-top: 4px; }

/* Reused style tokens from the old UsersView / GroupsView — kept locally
   to keep this view self-contained. Same class names so future refactors
   can promote these to components.css. */

.uv-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius-md, 4px);
  font-size: 14px;
  margin-bottom: 16px;
}

.uv-loading {
  padding: 48px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}

/* OTP banner */
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

/* Create form */
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

/* Users table */
.users-table {
  width: 100%;
  background: var(--bg);
  border-collapse: separate;
  border-spacing: 0;
  font-size: 14px;
}
.users-table th {
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
.user-name { font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.user-email { font-size: 12px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.role-pill {
  display: inline-block;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-pill, 999px);
  background: var(--bg-subtle);
  color: var(--text-2);
}
.role-pill.admin { background: var(--purple-soft); color: var(--purple); }

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
/* 注销(不可逆破坏性操作)— 默认 danger token,鼠标悬停加深 */
.ra-btn-danger { color: var(--danger); }
.ra-btn-danger:hover { background: var(--danger-soft); color: var(--danger); }

/* ─── Filter toolbar (M17) — 工具栏跟表格合并到同一个 card shell,
 *     视觉上是一个整体。工具栏底边去掉,表格顶边内嵌。Input/Select
 *     跟 AuditView / 其他管理页的 .toolbar.card 保持 token 一致:
 *     bg-canvas 底色、radius-md 圆角、focus 加 2px accent-soft 光环;
 *     label 不强行 uppercase,留 inline 友好样式。 ─── */
.users-shell {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  overflow: hidden;
  box-shadow: var(--shadow-sm, 0 1px 1px rgba(9, 30, 66, 0.13), 0 0 1px rgba(9, 30, 66, 0.13));
}
.users-shell .toolbar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 16px 24px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.users-shell .users-table-wrap { background: var(--bg); }
.users-shell .users-table {
  border: 0;
  border-radius: 0;
}
/* 三段式工具栏:左侧大块搜索(主输入,无外部 label),中间分组的状态/角色,
   右侧清空筛选。两段之间用 1px 20px 高的分隔线分开,跟 Atlas section
   风格一致。 */
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

/* Group cards */

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
.gv-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm, 0 1px 1px rgba(9, 30, 66, 0.13)); }
.gv-card:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

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
.gc-open { color: var(--text-3); display: inline-flex; }
.gc-open .material-symbols-outlined { font-size: 18px; }

/* "Load more" footer (Stage B.1) — shared between users tab + groups tab.
 * Centered button + end-of-list marker. Tokens from tokens.css. */
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
