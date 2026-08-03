<script setup lang="ts">
/**
 * UserEditView — edit a single user (name, color, role) + admin actions.
 *
 * Stage 4b: PATCH name/color/role; quick actions for 禁用/启用 and 重置密码
 * (重置密码 reuses the one-time-password banner UX from UsersView).
 *
 * Read-only fields: email (immutable post-create), id, createdAt, lastLoginAt.
 * Role change is exposed but is admin-only — non-admins never see this page
 * thanks to the route guard.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import { useConfirm } from '@/composables/useConfirm'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import type { SpaceAccessSource, User, Space } from '@power-wiki/shared'

/* P1-14 · SpaceMembership 类型从 API 响应 derive —— 后端已经把 `sources`
 * (SpaceAccessSource[]) 接在了 /admin/users/:id/spaces 响应里,这里
 * 自动继承,前端无需手写 type。SpaceAvatar 接受完整 Space,但这个
 * 端点只返 id/name/color/kind,视觉上只用到前 4 个字段。补
 * createdAt / updatedAt 占位以满足类型。*/
type SpaceMembership = Awaited<ReturnType<typeof api.admin.users.spaces>>['items'][number]
function asSpaceAvatarSource(m: SpaceMembership): Space {
  return {
    id: m.id,
    name: m.name,
    color: m.color,
    kind: m.kind,
    createdAt: 0,
    updatedAt: 0,
  }
}

const route = useRoute()
const router = useRouter()
const uiStore = useUiStore()
const { confirm: askConfirm } = useConfirm()

const userId = computed(() => String(route.params.id ?? ''))

const user = ref<User | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const memberships = ref<SpaceMembership[]>([])
const membershipsLoading = ref(false)

/** 浏览器 tab 标题:"编辑成员: <name>";user 没拉到时退 BASE。 */
useDocumentTitle(() => (user.value ? `编辑成员: ${user.value.name}` : null))

const editName = ref('')
const editColor = ref('#0052CC')
const editRole = ref<'admin' | 'user'>('user')
const saving = ref(false)

/** 面包屑:人员(链回 /manager/people)/ <user.name>。loading 阶段末段
 *  退 Skeleton,走 #current 插槽。 */
const breadcrumbSegments = computed(() => {
  const cur = user.value?.name ?? '—'
  return [
    { label: '人员', to: '/manager/people' },
    { label: cur },
  ]
})

const oneTimePassword = ref<string | null>(null)
const copied = ref(false)

/* ─── Anonymize inline confirm state ───
 * `useConfirm` is just a Promise<boolean> dialog — we need a typed-name
 * confirmation for irreversible actions (Confluence-style), so we run
 * an inline confirmation panel right inside this card instead. Two
 * pieces of state:
 *   - anonymizeOpen: panel expanded? (false by default to keep the card tidy)
 *   - anonymizeConfirm: typed input, must === user.value.name to enable button */
const anonymizeOpen = ref(false)
const anonymizeConfirm = ref('')
const anonymizing = ref(false)
const anonymizeError = ref<string | null>(null)
const anonymizeImpact = ref<Awaited<ReturnType<typeof api.admin.users.anonymizeImpact>> | null>(null)

const canAnonymize = computed(
  () =>
    !!user.value &&
    anonymizeConfirm.value.trim() === user.value.name &&
    !anonymizing.value,
)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    user.value = await api.admin.users.get(userId.value)
    syncFormFromUser()
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      loadError.value = '用户不存在'
    } else {
      loadError.value = e instanceof ApiError ? e.message : '加载用户失败'
    }
  } finally {
    loading.value = false
  }
  // 5.11: 5.11: 加载该用户的「所在空间 + 角色」。失败不阻塞主表单
  // (顶部已有 loadError),单独 inline 显示。
  void loadMemberships()
}

async function loadMemberships() {
  membershipsLoading.value = true
  try {
    const r = await api.admin.users.spaces(userId.value)
    memberships.value = r.items
  } catch {
    memberships.value = []
  } finally {
    membershipsLoading.value = false
  }
}

function syncFormFromUser() {
  if (!user.value) return
  editName.value = user.value.name
  editColor.value = user.value.color
  editRole.value = user.value.role
}

watch(userId, () => {
  if (userId.value) void load()
})

onMounted(load)

const dirty = computed(
  () =>
    user.value !== null &&
    (editName.value !== user.value.name ||
      editColor.value.toUpperCase() !== user.value.color.toUpperCase() ||
      editRole.value !== user.value.role),
)

async function onSave() {
  if (!user.value || !dirty.value || saving.value) return
  saving.value = true
  try {
    const updated = await api.admin.users.update(user.value.id, {
      name: editName.value.trim(),
      color: editColor.value,
    })
    user.value = updated
    syncFormFromUser()
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function onReset() {
  syncFormFromUser()
}

async function toggleDisable() {
  if (!user.value) return
  const u = user.value
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
    user.value = u.status === 'disabled'
      ? await api.admin.users.enable(u.id)
      : await api.admin.users.disable(u.id)
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '操作失败')
  }
}

async function resetPassword() {
  if (!user.value) return
  const u = user.value
  const ok = await askConfirm({
    title: '重置密码',
    message: `确定要将 ${u.name} 的密码重置为新的初始密码吗?该用户将被强制退出并需要重新设置密码。`,
    confirmText: '重置',
    danger: true,
  })
  if (!ok) return
  try {
    const initialPassword = await api.admin.users.resetPassword(u.id)
    oneTimePassword.value = initialPassword
    copied.value = false
    // Status flips to must_reset_password on the server.
    user.value = await api.admin.users.get(u.id)
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '重置失败')
  }
}

async function copyPassword() {
  if (!oneTimePassword.value) return
  try {
    await navigator.clipboard.writeText(oneTimePassword.value)
    copied.value = true
  } catch {
    const input = document.getElementById('ue-otp-input') as HTMLInputElement | null
    input?.select()
  }
}

function dismissOneTime() {
  oneTimePassword.value = null
  copied.value = false
}

async function openAnonymize() {
  anonymizeOpen.value = true
  anonymizeConfirm.value = ''
  anonymizeError.value = null
  anonymizeImpact.value = null
  if (user.value) {
    try {
      anonymizeImpact.value = await api.admin.users.anonymizeImpact(user.value.id)
    } catch {
      anonymizeImpact.value = null
    }
  }
}
function cancelAnonymize() {
  anonymizeOpen.value = false
  anonymizeConfirm.value = ''
  anonymizeError.value = null
}
async function confirmAnonymize() {
  if (!user.value || !canAnonymize.value) return
  anonymizing.value = true
  anonymizeError.value = null
  try {
    // Returns the anonymized User row (name=已注销用户, status=anonymized).
    const anonymized = await api.admin.users.anonymize(user.value.id)
    user.value = anonymized
    syncFormFromUser()
    anonymizeOpen.value = false
    anonymizeConfirm.value = ''
  } catch (e) {
    if (e instanceof ApiError) {
      anonymizeError.value =
        e.code === 'last_admin'
          ? '不能注销最后一个管理员'
          : e.code === 'self_anonymize'
          ? '不能注销自己的账号'
          : e.message
    } else {
      anonymizeError.value = '注销失败,请重试'
    }
  } finally {
    anonymizing.value = false
  }
}

function formatDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function statusLabel(s: User['status']): string {
  switch (s) {
    case 'active': return '正常'
    case 'must_reset_password': return '需重置密码'
    case 'disabled': return '已禁用'
    case 'anonymized': return '已注销'
  }
}

function statusTone(s: User['status']): 'good' | 'warn' | 'bad' {
  switch (s) {
    case 'active': return 'good'
    case 'must_reset_password': return 'warn'
    case 'disabled': return 'bad'
    case 'anonymized': return 'bad'
  }
}

/* 5.11: 所在空间 section 视觉对齐 PersonalHomeView「共享空间与角色」。
   个人空间在 kind==='personal' 时显示「所有者」;共享空间按 SpaceRole 渲
   染(与 SpaceMembersTab ROLE_INFO 一致)。 */
function spaceRoleLabel(m: SpaceMembership): string {
  if (m.kind === 'personal') return '所有者'
  switch (m.role) {
    case 'admin': return '管理'
    case 'editor': return '编辑'
    case 'viewer': return '只读'
  }
}
function spaceRoleTone(m: SpaceMembership): 'accent' | 'purple' | 'good' | 'neutral' {
  if (m.kind === 'personal') return 'accent'
  switch (m.role) {
    case 'admin': return 'purple'
    case 'editor': return 'good'
    case 'viewer': return 'neutral'
  }
}

function openSpace(spaceId: string) {
  void router.push(`/manager/spaces/${spaceId}`)
}

/* P1-14 · 来源 chip 视觉与跳转目标 ── group / legacy_group 跳
 * GroupEditView(让 admin 直接到「组成员 + 角色授权」面板,能改组的
 * 角色或 remove user);direct / owner 跳 SpaceEditView(那里改授权)。*/
interface SourceChip {
  label: string
  title: string
  to: string | null
  tone: 'direct' | 'group' | 'legacy_group' | 'owner'
}
function sourceLabel(s: SpaceAccessSource): string {
  switch (s.kind) {
    case 'direct': return '直接授权'
    case 'owner': return '所有者'
    case 'group':
    case 'legacy_group': return s.groupName?.trim() || s.groupId?.slice(0, 6) || '用户组'
  }
}
function sourceChipsFor(m: SpaceMembership): SourceChip[] {
  return (m.sources ?? []).map((s) => {
    let title = ''
    if (s.kind === 'direct') title = `直接在「${m.name}」空间授权 ${roleLabelFromKind(s.role)}`
    else if (s.kind === 'owner') title = '该空间为用户本人所有'
    else title = `通过用户组「${s.groupName || s.groupId}」获得 ${roleLabelFromKind(s.role)} 角色`
    return {
      label: sourceLabel(s),
      title,
      to: s.kind === 'group' || s.kind === 'legacy_group'
        ? `/manager/groups/${s.groupId}`
        : `/manager/spaces/${m.id}`,
      tone: s.kind,
    }
  })
}
/** 从 raw SpaceAccessSource 拿角色显示 —— 跟 spaceRoleLabel 重复,
 * 这里独立出来是为了 sourceChipsFor 不依赖 SpaceMembership.role(可能
 * 比 source.role 强,但显示「这一条 source 给了什么角色」更准)。*/
function roleLabelFromKind(r: SpaceAccessSource['role']): string {
  switch (r) {
    case 'admin': return '管理'
    case 'editor': return '编辑'
    case 'viewer': return '只读'
  }
}

const colorPresets = [
  '#0052CC', '#36B37E', '#FF5630', '#FFAB00',
  '#403294', '#00B8D9', '#6554C0', '#FF8B00',
]
</script>

<template>
  <div class="user-edit">
    <Breadcrumb variant="inline" :segments="breadcrumbSegments">
      <template #current="{ segment }">
        <span class="crumb-item current">
          <Skeleton v-if="loading" width="120px" height="14px" />
          <template v-else>{{ segment.label }}</template>
        </span>
      </template>
    </Breadcrumb>

    <header class="ue-header">
      <Skeleton v-if="loading" width="56px" height="56px" radius="50%" />
      <UserAvatar v-else-if="user" :size="56" :label="user.name" :color="user.color" :avatar-kind="user.avatarKind" :avatar-ref="user.avatarRef" :user-id="user.id" />
      <div class="ue-header-text">
        <h1 class="ue-title">
          <Skeleton v-if="loading" width="180px" height="22px" />
          <template v-else-if="user">{{ user.name }}</template>
        </h1>
        <div class="ue-meta">
          <template v-if="user">
            <span class="status-pill" :class="statusTone(user.status)">{{ statusLabel(user.status) }}</span>
            <span class="role-pill" :class="user.role">
              {{ user.role === 'admin' ? '管理员' : '普通用户' }}
            </span>
            <span class="ue-email">{{ user.email }}</span>
          </template>
          <template v-else-if="loading">
            <Skeleton width="60px" height="20px" radius="999px" />
            <Skeleton width="60px" height="20px" radius="999px" />
            <Skeleton width="180px" height="14px" />
          </template>
        </div>
      </div>
    </header>

    <div v-if="loadError" class="ue-error">
      <p>{{ loadError }}</p>
      <button type="button" class="btn ghost" @click="router.push('/manager/people')">返回列表</button>
    </div>

    <template v-else-if="loading">
      <div class="ue-grid">
        <section class="ue-card">
          <Skeleton width="120px" height="18px" />
          <div class="ue-fields">
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
            <div class="field">
              <Skeleton width="60px" height="12px" />
              <Skeleton width="180px" height="28px" />
            </div>
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
          </div>
          <div class="ue-card-actions">
            <Skeleton width="80px" height="32px" />
            <Skeleton width="80px" height="32px" />
          </div>
        </section>
        <section class="ue-card">
          <Skeleton width="100px" height="18px" />
          <div class="ue-action-list">
            <Skeleton height="64px" />
            <Skeleton height="64px" />
          </div>
        </section>
      </div>
    </template>

    <!-- One-time password banner (after admin-initiated reset). -->
    <div v-if="user && oneTimePassword" class="otp-banner" role="alert">
      <div class="otp-row">
        <span class="material-symbols-outlined otp-icon">key</span>
        <div class="otp-text">
          <div class="otp-title">{{ user.name }} 的初始密码</div>
          <div class="otp-hint">请将以下密码复制给用户。该密码仅显示一次,关闭后无法再次查看。</div>
        </div>
      </div>
      <div class="otp-password-row">
        <input
          id="ue-otp-input"
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

    <div v-if="user" class="ue-grid">
      <!-- Edit form -->
      <section class="ue-card">
        <h2 class="ue-card-title">基本信息</h2>
        <div class="ue-fields">
          <label class="field">
            <span class="field-label">姓名</span>
            <input
              v-model="editName"
              type="text"
              class="field-input"
              :disabled="saving"
              maxlength="64"
            />
          </label>

          <label class="field">
            <span class="field-label">邮箱</span>
            <input :value="user.email" type="email" class="field-input" disabled />
            <span class="field-hint">邮箱不可修改</span>
          </label>

          <div class="field">
            <span class="field-label">头像颜色</span>
            <div class="color-row">
              <button
                v-for="c in colorPresets"
                :key="c"
                type="button"
                class="color-swatch"
                :class="{ active: c.toUpperCase() === editColor.toUpperCase() }"
                :style="{ background: c }"
                :title="c"
                @click="editColor = c"
              />
            </div>
          </div>

          <label class="field">
            <span class="field-label">角色</span>
            <select v-model="editRole" class="field-input" :disabled="saving">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
            <span class="field-hint">管理员可访问「管理后台」</span>
          </label>
        </div>

        <div class="ue-card-actions">
          <button type="button" class="btn ghost" :disabled="!dirty || saving" @click="onReset">取消</button>
          <button type="button" class="btn primary" :disabled="!dirty || saving" @click="onSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>

      <!-- 所在空间 + 角色(5.11):让 admin 不必逐个空间进 SpaceEditView →
           MembersTab 才能查到 user 在哪个空间 / 什么角色。复用
           PersonalHomeView「共享空间与角色」视觉:space row + role pill,
           个人空间(若有)排第一。 -->
      <section class="ue-card">
        <h2 class="ue-card-title">所在空间</h2>
        <div v-if="membershipsLoading" class="ue-ms-loading">
          <Skeleton height="36px" />
          <Skeleton height="36px" />
        </div>
        <div v-else-if="memberships.length === 0" class="ue-ms-empty">
          该用户尚未加入任何空间。
        </div>
        <ul v-else class="ue-ms-list">
          <li
            v-for="m in memberships"
            :key="m.id"
            class="ue-ms-row"
            role="button"
            tabindex="0"
            @click="openSpace(m.id)"
            @keydown.enter="openSpace(m.id)"
          >
            <SpaceAvatar :space="asSpaceAvatarSource(m)" :size="20" />
            <span class="ue-ms-name">{{ m.name }}</span>
            <span class="ue-ms-kind">{{ m.kind === 'personal' ? '个人空间' : '团队空间' }}</span>
            <span class="ue-ms-role" :class="`tone-${spaceRoleTone(m)}`">{{ spaceRoleLabel(m) }}</span>
            <!-- P1-14 · 授权来源 chip(s)—— 多个 source 时并列展示。
                 chip 自身可点击 → 跳到源头(用户组 / 空间)的管理页。
                 @click.stop 阻止冒泡触发外层 row 的 openSpace,避免
                 「点 chip 进修改源 + 同时切到空间」双跳转。-->
            <span class="ue-ms-sources">
              <button
                v-for="(src, idx) in sourceChipsFor(m)"
                :key="`${src.tone}-${idx}`"
                type="button"
                class="ue-ms-source-chip"
                :class="`tone-${src.tone}`"
                :title="src.title"
                @click.stop="router.push(src.to!)"
              >
                <span class="material-symbols-outlined">{{ src.tone === 'group' || src.tone === 'legacy_group' ? 'groups' : src.tone === 'direct' ? 'person' : 'home' }}</span>
                <span class="ue-ms-source-label">{{ src.label }}</span>
              </button>
            </span>
            <span class="material-symbols-outlined ue-ms-arrow">chevron_right</span>
          </li>
        </ul>
      </section>

      <!-- Admin actions -->
      <section class="ue-card">
        <h2 class="ue-card-title">账号操作</h2>
        <div class="ue-action-list">
          <div class="ue-action">
            <div>
              <div class="ue-action-title">重置密码</div>
              <div class="ue-action-hint">生成新的初始密码,该用户将被强制退出。</div>
            </div>
            <button type="button" class="btn" @click="resetPassword">
              <span class="material-symbols-outlined btn-icon">lock_reset</span>
              <span>重置</span>
            </button>
          </div>

          <!-- 禁用/启用 — anonymized 是终态,identity 已 scrub,启用无意义
               (后端 enable 端点也会拒掉,见 adminUsers.ts)。整 row 隐藏。 -->
          <div v-if="user.status !== 'anonymized'" class="ue-action">
            <div>
              <div class="ue-action-title">
                {{ user.status === 'disabled' ? '启用账号' : '禁用账号' }}
              </div>
              <div class="ue-action-hint">
                {{ user.status === 'disabled'
                  ? '允许该用户重新登录。'
                  : '禁止该用户登录,已有的会话会被立即终止。' }}
              </div>
            </div>
            <button type="button" class="btn" :class="user.status === 'disabled' ? 'primary' : 'danger'" @click="toggleDisable">
              <span class="material-symbols-outlined btn-icon">
                {{ user.status === 'disabled' ? 'check_circle' : 'block' }}
              </span>
              <span>{{ user.status === 'disabled' ? '启用' : '禁用' }}</span>
            </button>
          </div>
        </div>

        <div class="ue-readonly">
          <div class="ue-ro-row">
            <span class="ue-ro-label">用户 ID</span>
            <code class="ue-ro-value">{{ user.id }}</code>
          </div>
          <div class="ue-ro-row">
            <span class="ue-ro-label">创建时间</span>
            <span class="ue-ro-value">{{ formatDate(user.createdAt) }}</span>
          </div>
          <div class="ue-ro-row">
            <span class="ue-ro-label">最后登录</span>
            <span class="ue-ro-value">{{ formatDate(user.lastLoginAt) }}</span>
          </div>
        </div>
      </section>

      <!-- 危险操作:注销(不可逆)。
           不到最后关头不展开 —— 默认 collapsed,点击「注销用户」才展开
           内联确认面板,要求输入 user.name 才解锁按钮(防误点)。
           已注销的用户整个 section 自动隐藏:无可恢复操作(M16 起
           改读 status 列,以前靠 name='已注销用户' sentinel 判断)。 -->
      <section v-if="user.status !== 'anonymized'" class="ue-card">
        <h2 class="ue-card-title">危险操作</h2>
        <div v-if="!anonymizeOpen" class="ue-action">
          <div>
            <div class="ue-action-title">注销用户</div>
            <div class="ue-action-hint">
              不可逆操作 —— 清除姓名、邮箱、密码、头像,清除所有组成员关系与个人空间授权。
              该用户创建/编辑的页面与评论保留,署名显示为「已注销用户」。
            </div>
          </div>
          <button type="button" class="btn danger" @click="openAnonymize">
            <span class="material-symbols-outlined btn-icon">person_off</span>
            <span>注销用户</span>
          </button>
        </div>

        <div v-else class="ue-anonymize">
          <div class="ue-anonymize-warning">
            <span class="material-symbols-outlined ue-anonymize-icon">warning</span>
            <div>
              <div class="ue-anonymize-title">确认注销「{{ user.name }}」</div>
              <div class="ue-anonymize-detail">
                将清除该用户的姓名、邮箱、密码、头像,清除所有组成员关系、关注、点赞与通知,
                移除其直接空间授权与页面级限制。已创建的页面与评论<strong>保留</strong>(署名变为「已注销用户」)。
                该操作<strong>不可撤销</strong>。
              </div>
            </div>
          </div>
          <ul v-if="anonymizeImpact" class="ue-impact-list">
            <li v-if="anonymizeImpact.groupMembershipCount">{{ anonymizeImpact.groupMembershipCount }} 个用户组成员关系</li>
            <li v-if="anonymizeImpact.watchedPageCount">{{ anonymizeImpact.watchedPageCount }} 个页面关注</li>
            <li v-if="anonymizeImpact.likeCount">{{ anonymizeImpact.likeCount }} 个页面点赞</li>
            <li v-if="anonymizeImpact.notificationCount">{{ anonymizeImpact.notificationCount }} 条接收通知</li>
            <li v-if="anonymizeImpact.roleGrantCount">{{ anonymizeImpact.roleGrantCount }} 个直接空间授权</li>
            <li v-if="anonymizeImpact.restrictionCount">{{ anonymizeImpact.restrictionCount }} 个页面限制</li>
            <li v-if="anonymizeImpact.commentCount">{{ anonymizeImpact.commentCount }} 条评论将保留并匿名署名</li>
          </ul>
          <label class="field">
            <span class="field-label">输入用户名「{{ user.name }}」以确认</span>
            <input
              v-model="anonymizeConfirm"
              type="text"
              class="field-input"
              :disabled="anonymizing"
              :placeholder="user.name"
              autocomplete="off"
            />
          </label>
          <p v-if="anonymizeError" class="ue-anonymize-error">{{ anonymizeError }}</p>
          <div class="ue-anonymize-actions">
            <button type="button" class="btn ghost" :disabled="anonymizing" @click="cancelAnonymize">
              取消
            </button>
            <button
              type="button"
              class="btn danger"
              :disabled="!canAnonymize"
              @click="confirmAnonymize"
            >
              <span v-if="anonymizing" class="ue-anonymize-spinner" aria-hidden="true"></span>
              <span>{{ anonymizing ? '注销中…' : '确认注销' }}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.user-edit { max-width: 1200px; }

/* 旧 .ue-breadcrumb / .ue-bc-sep / .ue-bc-current 一律删除(P2 收口):
   UserEditView 现在用统一 <Breadcrumb variant="inline">。 */

.ue-loading,
.ue-error {
  padding: 48px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.ue-error { color: var(--danger); }
.ue-error .btn { margin-top: 12px; display: inline-flex; }

/* ─── Header ─── */
.ue-header {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 20px;
}
.ue-header-text { min-width: 0; }
.ue-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-1);
  margin: 0;
}
.ue-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.ue-email {
  font-size: 13px;
  color: var(--text-3);
}

.status-pill,
.role-pill {
  display: inline-block;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-pill, 999px);
}
.status-pill.good { background: var(--success-soft); color: var(--success); }
.status-pill.warn { background: var(--warning-soft); color: var(--warning-text); }
.status-pill.bad { background: var(--danger-soft); color: var(--danger); }
.role-pill {
  background: var(--bg-subtle);
  color: var(--text-2);
}
.role-pill.admin {
  background: var(--purple-soft);
  color: var(--purple);
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

/* ─── Grid + cards ─── */
.ue-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}
.ue-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 20px 24px;
}
.ue-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 16px 0;
}
.ue-fields { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
.field-hint { font-size: 12px; color: var(--text-3); }
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
.field-input:focus:not(:disabled) { border-color: var(--accent); }
.field-input:disabled { background: var(--bg-canvas); color: var(--text-3); }

.ue-card-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

.color-row { display: flex; gap: 6px; flex-wrap: wrap; }
.color-swatch {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color var(--duration-fast) var(--ease-out);
}
.color-swatch.active { outline-color: var(--accent); }
.color-swatch:hover:not(.active) { outline-color: var(--border-strong); }

.ue-action-list { display: flex; flex-direction: column; gap: 14px; }
.ue-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bg-canvas);
  border-radius: var(--radius-md, 4px);
}
.ue-action-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.ue-action-hint { font-size: 12px; color: var(--text-3); margin-top: 2px; }

.ue-readonly { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.ue-ro-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
.ue-ro-label { color: var(--text-3); }
.ue-ro-value {
  color: var(--text-2);
  font-family: var(--font-mono, monospace);
}

/* ─── 5.11 所在空间 + 角色 ─── */
.ue-ms-loading { display: flex; flex-direction: column; gap: 8px; }
.ue-ms-empty {
  font-size: 13px;
  color: var(--text-3);
  padding: 8px 0;
}
.ue-ms-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ue-ms-row {
  display: grid;
  /* avatar | name | kind | role pill | sources | chevron —— P1-14
   * 在 kind / role 之后插入 sources chip 区。sources 在窄列宽下
   * name 优先截断,sources 一律 ellipsis(向下兼容视觉密度)。
   */
  grid-template-columns: 20px minmax(0, 1fr) auto auto minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md, 4px);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.ue-ms-row:hover { background: var(--bg-canvas); }
.ue-ms-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.ue-ms-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ue-ms-kind {
  font-size: 11px;
  color: var(--text-3);
  padding: 1px 8px;
  background: var(--bg-canvas);
  border-radius: var(--radius-pill, 999px);
}
.ue-ms-role {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-pill, 999px);
}
.ue-ms-role.tone-accent {
  background: var(--accent-soft);
  color: var(--accent);
}
.ue-ms-role.tone-purple {
  background: var(--purple-soft);
  color: var(--purple);
}
.ue-ms-role.tone-good {
  background: var(--success-soft);
  color: var(--success);
}
.ue-ms-role.tone-neutral {
  background: var(--bg-canvas);
  color: var(--text-2);
}
.ue-ms-arrow {
  font-size: 16px;
  color: var(--text-3);
  opacity: 0;
  transform: translateX(-2px);
  transition: opacity var(--duration-fast) var(--ease-out),
              transform var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}

/* P1-14 · 授权来源 chip(s) —— 显示在 role pill 右侧。一行可容纳多 chip,
 * 多了 overflow-x 不必要(典型 1-2 个 source 已能拍全);min-width: 0 让
 * grid 1fr column 截断发生在 chip label 而不是溢出整行。每个 chip 是
 * button:hover 时颜色加深(@click.stop 已在外层 row 隔离)。tone-direct
 * 用 accent-soft(跟角色「管理员」pill 同色系,视觉一致),tone-group
 * 用 accent-soft 不同饱和度,tone-legacy_group 走 text-2 表示「旧字段
 * 但仍生效」,tone-owner 用 purple-soft(跟 owner 角色 pill 同色)。*/
.ue-ms-sources {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.ue-ms-source-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  height: 22px;
  padding: 0 8px 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill, 999px);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.ue-ms-source-chip .material-symbols-outlined {
  font-size: 13px !important;
  line-height: 1;
}
.ue-ms-source-chip.tone-direct {
  background: var(--accent-soft);
  color: var(--accent);
}
.ue-ms-source-chip.tone-direct:hover {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.ue-ms-source-chip.tone-group {
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}
.ue-ms-source-chip.tone-group:hover {
  background: var(--accent-soft);
}
.ue-ms-source-chip.tone-legacy_group {
  background: var(--bg-canvas);
  color: var(--text-2);
  border-color: var(--border);
}
.ue-ms-source-chip.tone-legacy_group:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.ue-ms-source-chip.tone-owner {
  background: var(--purple-soft);
  color: var(--purple);
}
.ue-ms-source-chip.tone-owner:hover {
  background: color-mix(in srgb, var(--purple) 14%, transparent);
}
.ue-ms-source-label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}
.ue-ms-row:hover .ue-ms-arrow,
.ue-ms-row:focus-visible .ue-ms-arrow {
  opacity: 1;
  transform: translateX(0);
  color: var(--accent);
}

/* ─── 危险操作 — 注销用户(内联面板) ─── */
.ue-anonymize {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  background: var(--danger-soft);
  border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent);
  border-radius: var(--radius-md, 4px);
}
.ue-anonymize-warning {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-1);
}
.ue-anonymize-icon {
  font-size: 22px;
  color: var(--danger);
  flex-shrink: 0;
}
.ue-anonymize-title { font-weight: 600; }
.ue-anonymize-detail { color: var(--text-2); margin-top: 2px; }
.ue-anonymize-detail strong { font-weight: 600; color: var(--danger); }
.ue-anonymize-error {
  font-size: 12px;
  color: var(--danger);
  margin: 0;
}
.ue-anonymize-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.ue-anonymize-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ue-spin 0.6s linear infinite;
  vertical-align: -2px;
  margin-right: 4px;
}
@keyframes ue-spin { to { transform: rotate(360deg); } }
</style>