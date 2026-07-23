<script setup lang="ts">
/**
 * SpaceEditView — Phase A.6 + v0.7 综合版:空间元信息 + 权限管理合一页。
 *
 *   - 基本信息(name / 描述 / 颜色 / 危险操作)(**全局 admin only**)
 *   - 访问控制(用户组 + 个人 两栏,角色三档,Save bar)(**全局 admin 或
 *     space-admin**)
 *
 * 历史:
 *   - Phase A.5 之前:SpaceEditView 管基本信息 + 旧「访问组」 card(legacy
 *     space_group_access,直接 toggle);SpacePermissionsView 管新权限模型
 *     (group / user grants,viewer/editor/admin 三档)。两个 view 两路由。
 *   - Phase A.5:删 SpaceEditView 旧「访问组」 card,改为「查看 / 调整」
 *     RouterLink 入口跳 SpacePermissionsView,新权限成唯一 UI。
 *   - Phase A.6:两个 view 合并到 SpaceEditView 一页。路由在 /manager/
 *     spaces/:id,有 meta.requiresAdmin 兜底 —— 实际上 space-admin 当时
 *     拿不到任何入口。
 *   - v0.7:为 space-admin 增加顶层 /spaces/:id 入口,组件内部按身份切换
 *     section 显示;全局 admin 仍可通过 /manager/spaces/:id 在管理后台布局
 *     内使用同一个组件。后端配套新增 /api/spaces/:id/permissions/candidates,让
 *     non-admin 路径也能拿到 + 添加候选。data fetch 也按身份分流:
 *     admin 走 api.admin.* / api.spaces.permissions.candidates;
 *     space-admin 走 api.spaces.get + api.spaces.permissions.candidates。
 *
 * 权限 gate(per-section,逐个判):
 *   - 基本信息 + 危险操作:`isGlobalAdmin`
 *   - 访问控制:`isGlobalAdmin || canAdminSpace(me, spaceId)`
 *     404-not-403 政策对齐现有 canAccessSpace 风格(不泄漏空间存在性)。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useEscape } from '@/composables/useEscape'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { SPACE_COLOR_PALETTE } from '@/lib/colorPalettes'
import type {
  Space,
  SpaceGrants,
  SpaceRole,
  User,
  UserGroup,
} from '@power-wiki/shared'

const route = useRoute()
const router = useRouter()
const uiStore = useUiStore()
const pagesStore = usePagesStore()
const authStore = useAuthStore()
const { confirm: askConfirm } = useConfirm()

const spaceId = computed(() => String(route.params.id ?? ''))

/* ─── 基本信息 state ─────────────────────────────────────────── */
const space = ref<Space | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const editName = ref('')
const editDesc = ref('')
const editColor = ref(SPACE_COLOR_PALETTE[0].value as string)
const saving = ref(false)
const formDirty = ref(false)

/* ─── 访问控制 state ─────────────────────────────────────────── */
const grants = ref<SpaceGrants>({ groups: [], users: [] })
const allGroups = ref<UserGroup[]>([])
const allUsers = ref<User[]>([])
const originalGrants = ref<SpaceGrants>({ groups: [], users: [] })
const groupSearch = ref('')
const userSearch = ref('')
const groupAddOpen = ref(false)
const userAddOpen = ref(false)
const groupAddSearch = ref('')
const userAddSearch = ref('')
const permsSaving = ref(false)
const permsError = ref<string | null>(null)

/* ─── Search debounce ─────────────────────────────────────────── */
/**
 * 4 个搜索框统一 300ms debounce —— 避免每次键入立即触发 list 过滤
 * (尤其 candidate list,全表 200 条 + 跨表 join)。
 * 保留原始 input ref(用户输入),导出 debounced ref(实际过滤)。
 */
function makeDebounced(source: Ref<string>, delay = 300) {
  const debounced = ref(source.value)
  let timer: ReturnType<typeof setTimeout> | null = null
  watch(source, (v) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      debounced.value = v
    }, delay)
  })
  return debounced
}
const groupSearchDebounced = makeDebounced(groupSearch)
const userSearchDebounced = makeDebounced(userSearch)
const groupAddSearchDebounced = makeDebounced(groupAddSearch)
const userAddSearchDebounced = makeDebounced(userAddSearch)

/* ─── Popover 关闭交互 ────────────────────────────────────────── */
const groupPopoverEl = ref<HTMLElement | null>(null)
const groupAddBtnEl = ref<HTMLElement | null>(null)
const userPopoverEl = ref<HTMLElement | null>(null)
const userAddBtnEl = ref<HTMLElement | null>(null)
function closeGroupAdd() {
  groupAddOpen.value = false
  groupAddSearch.value = ''
  groupAddSearchDebounced.value = ''
}
function closeUserAdd() {
  userAddOpen.value = false
  userAddSearch.value = ''
  userAddSearchDebounced.value = ''
}
// Esc 关闭 — useEscape 内部处理 add/removeEventListener 生命周期
useEscape(() => groupAddOpen.value, closeGroupAdd)
useEscape(() => userAddOpen.value, closeUserAdd)
// click-outside 关闭 — 用 mousedown 而不是 click,这样 toggle button 的
// click 仍能正常切换(否则 mousedown 先关、click 再开 = 永远打不开)。
function onDocMouseDown(e: MouseEvent) {
  const t = e.target as Node
  if (groupAddOpen.value) {
    if (groupPopoverEl.value?.contains(t)) return
    if (groupAddBtnEl.value?.contains(t)) return
    closeGroupAdd()
    return
  }
  if (userAddOpen.value) {
    if (userPopoverEl.value?.contains(t)) return
    if (userAddBtnEl.value?.contains(t)) return
    closeUserAdd()
  }
}
watch([groupAddOpen, userAddOpen], ([g, u]) => {
  if (g || u) {
    void nextTick(() => document.addEventListener('mousedown', onDocMouseDown))
  } else {
    document.removeEventListener('mousedown', onDocMouseDown)
  }
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))

useDocumentTitle(() => (space.value ? `编辑空间: ${space.value.name}` : null))

/* ─── Role options ───────────────────────────────────────────── */
const ROLE_OPTIONS: Array<{ value: SpaceRole; label: string }> = [
  { value: 'viewer', label: '只读' },
  { value: 'editor', label: '编辑' },
  { value: 'admin', label: '管理' },
]
/** 用户组 role 子集:不含 admin —— assertNotAdminToGroup 在后端硬拒。 */
const GROUP_ROLE_OPTIONS = ROLE_OPTIONS.filter((o) => o.value !== 'admin')

/* ─── 身份 / 路由 gate ───────────────────────────────────────── */
const isGlobalAdmin = computed(() => authStore.isAdmin)
const isManagerRoute = computed(() =>
  route.matched.some((record) => record.path === '/manager'),
)
const backTarget = computed(() => (isManagerRoute.value ? '/manager/spaces' : '/'))
const backLabel = computed(() => (isManagerRoute.value ? '空间' : '我的知识库'))

/* ─── 加载 ───────────────────────────────────────────────────── */
async function load() {
  loading.value = true
  loadError.value = null
  permsError.value = null
  try {
    // 全局 admin 路径:所有可用 admin-only 端点返回更完整元数据
    // (accessGrants / ownerName / accessGroupIds),一把拉满。
    // space-admin 路径:走 /api/spaces/:id(非 admin)+ permissions
    // candidates(非 admin)—— 后端 gate 同样是 isAdmin || canAdminSpace,
    // 不存在跨权访问。404 政策对齐:无权限 = 看不到。
    const isAdmin = isGlobalAdmin.value
    let s: Space
    let g: SpaceGrants
    let groupsAll: UserGroup[]
    let usersAll: User[]
    if (isAdmin) {
      const [s2, g2, groupsP, usersP] = await Promise.all([
        api.admin.spaces.get(spaceId.value),
        api.spaces.permissions.get(spaceId.value),
        api.admin.groups.list({ limit: 200 }),
        api.admin.users.list({ limit: 200 }),
      ])
      s = s2
      g = g2
      groupsAll = groupsP.items
      usersAll = usersP.items
    } else {
      const [s2, g2, candidates] = await Promise.all([
        api.spaces.get(spaceId.value),
        api.spaces.permissions.get(spaceId.value),
        api.spaces.permissions.candidates(spaceId.value),
      ])
      s = s2
      g = g2
      groupsAll = candidates.groups
      usersAll = candidates.users
    }
    space.value = s
    syncFormFromSpace()
    grants.value = g
    allGroups.value = groupsAll
    allUsers.value = usersAll
    originalGrants.value = JSON.parse(JSON.stringify(grants.value))
    // 个人空间永远是 owner-only,不存在「管理」页面。TopBar 入口已 hide,
    // 但直接 URL 进来 / 旧书签 仍能命中这里 → 立即跳回首页,跟 TopBar
    // 入口的可见性保持一致。
    if (s.kind === 'personal') {
      void router.replace('/')
      return
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      loadError.value = '空间不存在或您没有管理权限'
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
  formDirty.value = false
}

watch(spaceId, () => {
  if (spaceId.value) void load()
})

onMounted(load)

/* ─── 基本信息: dirty / save / reset / delete ─────────────────── */
function markFormDirty() {
  formDirty.value = true
}

async function onSaveForm() {
  if (!space.value || !formDirty.value || saving.value) return
  saving.value = true
  try {
    const updated = await api.admin.spaces.update(space.value.id, {
      name: editName.value.trim(),
      description: editDesc.value.trim() || undefined,
      color: editColor.value,
    })
    space.value = { ...space.value, ...updated }
    syncFormFromSpace()
    uiStore.notify('空间信息已保存', 'success')
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function onResetForm() {
  syncFormFromSpace()
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
    void pagesStore.refresh()
    void router.push(backTarget.value)
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.code === 'space_not_empty') {
      const body = e.body as { pageCount?: number } | null
      uiStore.setError(`该空间下还有 ${body?.pageCount ?? ''} 个页面,请先删除或移动这些页面`)
    } else {
      uiStore.setError(e instanceof ApiError ? e.message : '删除失败')
    }
  }
}

/* ─── 访问控制: dirty 判定 ───────────────────────────────────── */
const adminUserIds = computed(() =>
  grants.value.users.filter((u) => u.role === 'admin').map((u) => u.userId),
)

const permsDirty = computed(
  () => JSON.stringify(grants.value) !== JSON.stringify(originalGrants.value),
)

/* ─── 访问控制: 过滤 / 候选 ─────────────────────────────────── */
const filteredGroups = computed(() => {
  const q = groupSearchDebounced.value.trim().toLowerCase()
  if (!q) return grants.value.groups
  return grants.value.groups.filter(
    (g) =>
      groupNameOf(g.groupId).toLowerCase().includes(q) ||
      (groupDescOf(g.groupId) ?? '').toLowerCase().includes(q),
  )
})

const filteredUsers = computed(() => {
  const q = userSearchDebounced.value.trim().toLowerCase()
  if (!q) return grants.value.users
  return grants.value.users.filter(
    (u) =>
      userNameOf(u.userId).toLowerCase().includes(q) ||
      (userEmailOf(u.userId) ?? '').toLowerCase().includes(q),
  )
})

const candidateGroups = computed(() => {
  const q = groupAddSearchDebounced.value.trim().toLowerCase()
  const taken = new Set(grants.value.groups.map((g) => g.groupId))
  const candidates = allGroups.value.filter(
    (g) => !taken.has(g.id) && !g.id.startsWith('pg-'),
  )
  if (!q) return candidates
  return candidates.filter(
    (g) =>
      g.name.toLowerCase().includes(q) ||
      (g.description ?? '').toLowerCase().includes(q),
  )
})

const candidateUsers = computed(() => {
  const q = userAddSearchDebounced.value.trim().toLowerCase()
  const taken = new Set(grants.value.users.map((u) => u.userId))
  // 含 active + must_reset_password;刚创建没首次重置密码的 user 也允许
  // 提前授权(admin 一条龙:建账号 → 授空间 → 告知初始密码)。仅排除 disabled。
  const candidates = allUsers.value.filter(
    (u) => !taken.has(u.id) && u.status !== 'disabled',
  )
  if (!q) return candidates
  return candidates.filter(
    (u) =>
      u.name.toLowerCase().includes(q) ||
      (u.email ?? '').toLowerCase().includes(q),
  )
})

/* 「已授权」section —— 候选 popover 内显示 N 个已在授权中的项,只读不点。
   让用户搜索时看到「这个关键词对应的项其实已经在授权中」,避免误以为
   添加操作没生效。仅在搜索非空时显示(空搜索时完全隐藏,跟"可添加"列表
   0 候选不冲突)。 */
const candidateAlreadyAddedGroups = computed(() => {
  const q = groupAddSearchDebounced.value.trim().toLowerCase()
  if (!q) return []
  const taken = new Set(grants.value.groups.map((g) => g.groupId))
  return allGroups.value.filter(
    (g) =>
      taken.has(g.id) &&
      !g.id.startsWith('pg-') &&
      (g.name.toLowerCase().includes(q) ||
        (g.description ?? '').toLowerCase().includes(q)),
  )
})

const candidateAlreadyAddedUsers = computed(() => {
  const q = userAddSearchDebounced.value.trim().toLowerCase()
  if (!q) return []
  const taken = new Set(grants.value.users.map((u) => u.userId))
  return allUsers.value.filter(
    (u) =>
      taken.has(u.id) &&
      u.status !== 'disabled' &&
      (u.name.toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q)),
  )
})

/* ─── 访问控制: helpers ─────────────────────────────────────── */
function groupNameOf(id: string): string {
  return allGroups.value.find((g) => g.id === id)?.name ?? id
}
function groupDescOf(id: string): string | null | undefined {
  return allGroups.value.find((g) => g.id === id)?.description
}
function userNameOf(id: string): string {
  return allUsers.value.find((u) => u.id === id)?.name ?? id
}
function userEmailOf(id: string): string | undefined {
  return allUsers.value.find((u) => u.id === id)?.email
}

function setGroupRole(idx: number, role: SpaceRole) {
  const next = [...grants.value.groups]
  next[idx] = { ...next[idx]!, role }
  grants.value = { ...grants.value, groups: next }
}
function setUserRole(idx: number, role: SpaceRole) {
  const next = [...grants.value.users]
  next[idx] = { ...next[idx]!, role }
  grants.value = { ...grants.value, users: next }
}
function removeGroup(idx: number) {
  grants.value = {
    ...grants.value,
    groups: grants.value.groups.filter((_, i) => i !== idx),
  }
}
function removeUser(idx: number) {
  grants.value = {
    ...grants.value,
    users: grants.value.users.filter((_, i) => i !== idx),
  }
}
function addGroup(groupId: string) {
  grants.value = {
    ...grants.value,
    groups: [
      ...grants.value.groups,
      { groupId, role: 'viewer', grantedBy: null, grantedAt: Date.now() },
    ],
  }
  closeGroupAdd()
}
function addUser(userId: string) {
  grants.value = {
    ...grants.value,
    users: [
      ...grants.value.users,
      { userId, role: 'viewer', grantedBy: null, grantedAt: Date.now() },
    ],
  }
  closeUserAdd()
}

/* ─── 访问控制: save / cancel ───────────────────────────────── */
async function onSavePerms() {
  if (!permsDirty.value || permsSaving.value) return
  permsSaving.value = true
  permsError.value = null
  try {
    const input = {
      groups: grants.value.groups.map((g) => ({
        groupId: g.groupId,
        role: g.role,
      })),
      users: grants.value.users.map((u) => ({
        userId: u.userId,
        role: u.role,
      })),
    }
    const updated = await api.spaces.permissions.set(spaceId.value, input)
    grants.value = updated
    originalGrants.value = JSON.parse(JSON.stringify(grants.value))
    uiStore.notify('访问控制已保存', 'success')
  } catch (e) {
    permsError.value = e instanceof ApiError ? e.message : '保存失败'
  } finally {
    permsSaving.value = false
  }
}

function onCancelPerms() {
  grants.value = JSON.parse(JSON.stringify(originalGrants.value))
  permsError.value = null
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}
</script>

<template>
  <div class="space-edit">
    <nav class="se-breadcrumb" aria-label="面包屑导航">
      <RouterLink :to="backTarget">
        {{ backLabel }}
      </RouterLink>
      <span class="se-bc-sep" aria-hidden="true">/</span>
      <span class="se-bc-current">
        <Skeleton v-if="loading" width="120px" height="14px" />
        <template v-else-if="space">{{ space.name }}</template>
        <template v-else>—</template>
      </span>
    </nav>

    <header class="se-header" v-if="space">
      <div class="se-header-text">
        <div class="se-title-row">
          <span
            class="se-avatar"
            :style="{ background: space.color }"
            aria-hidden="true"
          >
            <span v-if="space.icon" class="material-symbols-outlined se-icon">{{ space.icon }}</span>
            <span v-else class="se-initials">{{ space.name.slice(0, 2) }}</span>
          </span>
          <h1 class="se-title">{{ space.name }}</h1>
          <span
            v-if="space.kind === 'personal'"
            class="se-kind-badge se-kind-personal"
            title="个人空间:只有所有者可见,管理员只读"
          >个人空间</span>
          <span
            v-else
            class="se-kind-badge se-kind-shared"
            title="团队空间:授权组成员可见"
          >团队空间</span>
        </div>
        <!-- 元数据单行:创建于 / 所有者 / 管理员 全部在同一个 flex 容器里,
     小屏 / 项多时自动换行。分隔符独立 span 控制间距,避免原 inline
     · 在 v-if false 时残留。 -->
        <div class="se-meta-row">
          <span class="se-meta-item">创建于 {{ formatDate(space.createdAt) }}</span>
          <template v-if="space.kind === 'personal' && space.ownerName">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">所有者:<RouterLink :to="{ name: 'manager-user-edit', params: { id: space.ownerId } }">{{ space.ownerName }}</RouterLink></span>
          </template>
          <template v-else-if="space.kind === 'personal' && !space.ownerName && space.ownerId">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">所有者 ID:<code>{{ space.ownerId }}</code></span>
          </template>
          <template v-if="adminUserIds.length > 0">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">
              管理员:
              <template v-for="(id, idx) in adminUserIds" :key="id">
                <RouterLink :to="{ name: 'manager-user-edit', params: { id } }">{{ userNameOf(id) }}</RouterLink><template v-if="idx < adminUserIds.length - 1">, </template>
              </template>
            </span>
          </template>
          <template v-else-if="space.kind !== 'personal'">
            <span class="se-meta-sep" aria-hidden="true">·</span>
            <span class="se-meta-item">管理员:全局 admin(无 user-level admin)</span>
          </template>
        </div>
      </div>
    </header>

    <header v-else-if="loading" class="se-header">
      <div class="se-header-text">
        <div class="se-title-row">
          <Skeleton width="40px" height="40px" radius="6px" />
          <Skeleton width="200px" height="22px" />
          <Skeleton width="80px" height="20px" radius="999px" />
        </div>
        <p class="se-sub">
          <Skeleton width="240px" height="12px" />
        </p>
      </div>
    </header>

    <div v-if="loadError" class="se-error">
      <p>{{ loadError }}</p>
      <button
        type="button"
        class="btn ghost"
        @click="router.push(backTarget)"
      >返回</button>
    </div>

    <template v-else-if="loading">
      <div class="se-stack">
        <section v-if="isGlobalAdmin" class="se-card">
          <Skeleton width="100px" height="18px" />
          <div class="se-fields">
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
            <div class="field">
              <Skeleton width="40px" height="12px" />
              <Skeleton height="36px" />
            </div>
            <div class="se-color-row">
              <Skeleton width="40px" height="12px" />
              <Skeleton width="240px" height="28px" />
            </div>
          </div>
        </section>
        <section class="se-card">
          <Skeleton width="100px" height="18px" />
          <div class="se-perms-grid">
            <div>
              <Skeleton width="100%" height="36px" />
              <Skeleton :count="3" height="44px" />
            </div>
            <div>
              <Skeleton width="100%" height="36px" />
              <Skeleton :count="3" height="44px" />
            </div>
          </div>
        </section>
      </div>
    </template>

    <div v-else-if="space" class="se-stack">
      <!-- ─── 非 admin 顶部提示:说清楚能干什么 ─── -->
      <div v-if="!isGlobalAdmin" class="se-info">
        <span class="material-symbols-outlined se-info-icon">shield_person</span>
        <span>
          你是本空间的<strong>管理员</strong>(space-admin),可管理成员授权。空间名称、描述、颜色、删除由全局 admin 处理。
        </span>
      </div>

      <!-- ─── 基本信息(全局 admin only) ─── -->
      <section v-if="isGlobalAdmin" class="se-card">
        <h2 class="se-card-title">基本信息</h2>
        <div class="se-fields">
          <label class="field field-name">
            <span class="field-label">名称</span>
            <input
              v-model="editName"
              type="text"
              class="field-input"
              :disabled="saving"
              maxlength="64"
              @input="markFormDirty"
            />
          </label>
          <label class="field field-desc">
            <span class="field-label">描述</span>
            <input
              v-model="editDesc"
              type="text"
              class="field-input"
              :disabled="saving"
              maxlength="200"
              placeholder="可选 — 出现在侧边栏空间名下方"
              @input="markFormDirty"
            />
          </label>
          <div class="field field-color">
            <span class="field-label">颜色</span>
            <div class="color-swatches">
              <button
                v-for="c in SPACE_COLOR_PALETTE"
                :key="c.value as string"
                type="button"
                class="cs-swatch"
                :class="{ 'cs-swatch-active': editColor === c.value }"
                :style="{ background: c.value as string }"
                :title="c.name"
                :disabled="saving"
                @click="editColor = c.value!; markFormDirty()"
              >
                <span
                  v-if="editColor === c.value"
                  class="material-symbols-outlined cs-swatch-check"
                  aria-hidden="true"
                >check</span>
              </button>
            </div>
          </div>
        </div>
        <div class="se-card-actions">
          <button type="button" class="btn ghost" :disabled="!formDirty || saving" @click="onResetForm">取消</button>
          <button type="button" class="btn primary" :disabled="!formDirty || saving" @click="onSaveForm">
            <span v-if="saving" class="se-spinner" aria-hidden="true"></span>
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>

        <!-- ─── 危险操作(全局 admin only) ─── -->
        <div class="se-danger-zone">
          <h3 class="se-danger-title">危险操作</h3>
          <button type="button" class="btn danger" @click="onDelete">
            <span class="material-symbols-outlined btn-icon">delete</span>
            <span>删除空间</span>
          </button>
        </div>
      </section>

      <!-- ─── 访问控制:用户组 + 个人 两栏(admin 或 space-admin) ─── -->
      <section class="se-card se-perms-card">
        <div class="se-perms-header">
          <h2 class="se-card-title">访问控制</h2>
          <div v-if="permsDirty || permsError" class="se-perms-actions">
            <button type="button" class="btn ghost" :disabled="permsSaving" @click="onCancelPerms">取消</button>
            <button type="button" class="btn primary" :disabled="permsSaving" @click="onSavePerms">
              <span v-if="permsSaving" class="se-spinner" aria-hidden="true"></span>
              {{ permsSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
        <p v-if="permsError" class="se-perms-error">{{ permsError }}</p>
        <p class="se-perms-hint">
          管理谁可以访问这个空间、以什么角色访问。组授权批量给队员;直接 user 授权适合未入任何组的协作者。
        </p>
        <div class="se-perms-grid">
          <!-- Groups -->
          <div class="se-perms-col">
            <h3 class="se-perms-col-title">用户组</h3>
            <p class="se-perms-col-hint">选中的组获得对应角色,组内成员共享授权。</p>
            <div class="se-search-row">
              <span class="material-symbols-outlined se-search-icon">search</span>
              <input
                v-model="groupSearch"
                type="text"
                class="se-search"
                placeholder="按名称或描述搜索"
              />
            </div>

            <ul v-if="filteredGroups.length > 0" class="se-list">
              <li v-for="(g, idx) in filteredGroups" :key="g.groupId" class="se-row">
                <span class="material-symbols-outlined se-row-icon">workspaces</span>
                <div class="se-row-text">
                  <div class="se-row-name">{{ groupNameOf(g.groupId) }}</div>
                  <div v-if="groupDescOf(g.groupId)" class="se-row-desc">{{ groupDescOf(g.groupId) }}</div>
                </div>
                <div class="se-role" role="radiogroup">
                  <button
                    v-for="opt in GROUP_ROLE_OPTIONS"
                    :key="opt.value"
                    type="button"
                    class="se-role-btn"
                    :class="{ 'is-active': g.role === opt.value }"
                    :aria-pressed="g.role === opt.value"
                    @click="setGroupRole(idx, opt.value)"
                  >{{ opt.label }}</button>
                </div>
                <button
                  type="button"
                  class="se-remove"
                  title="移除授权"
                  @click="removeGroup(idx)"
                >
                  <span class="material-symbols-outlined">close</span>
                </button>
              </li>
            </ul>
            <div v-else-if="groupSearch.trim()" class="se-empty">没有匹配的用户组</div>
            <div v-else class="se-empty">还没有授权任何用户组</div>

            <div class="se-add">
              <button
                ref="groupAddBtnEl"
                type="button"
                class="btn ghost se-add-btn"
                :class="{ 'se-add-btn-open': groupAddOpen }"
                @click="groupAddOpen = !groupAddOpen"
              >
                <span class="material-symbols-outlined se-add-icon">{{ groupAddOpen ? 'close' : 'add' }}</span>
                <span>{{ groupAddOpen ? '收起' : '添加用户组' }}</span>
              </button>
              <div v-show="groupAddOpen" ref="groupPopoverEl" class="se-popover">
                <div class="se-popover-search">
                  <label class="se-popover-search-label">查找候选用户组</label>
                  <div class="se-popover-search-row">
                    <span class="material-symbols-outlined se-search-icon">search</span>
                    <input
                      v-model="groupAddSearch"
                      type="text"
                      class="se-search"
                      placeholder="按名称或描述筛选候选"
                      autofocus
                    />
                  </div>
                </div>
                <ul v-if="candidateGroups.length > 0" class="se-candidate-list">
                  <li v-for="c in candidateGroups.slice(0, 20)" :key="c.id">
                    <button type="button" class="se-candidate" @click="addGroup(c.id)">
                      <span class="material-symbols-outlined se-row-icon">workspaces</span>
                      <div>
                        <div class="se-row-name">{{ c.name }}</div>
                        <div v-if="c.description" class="se-row-desc">{{ c.description }}</div>
                      </div>
                    </button>
                  </li>
                </ul>
                <div v-else class="se-empty">没有可添加的用户组</div>
                <template v-if="groupAddSearchDebounced.trim() && candidateAlreadyAddedGroups.length > 0">
                  <div class="se-popover-divider" />
                  <div class="se-popover-section-label">
                    <span class="material-symbols-outlined">check_circle</span>
                    已授权 ({{ candidateAlreadyAddedGroups.length }})
                  </div>
                  <ul class="se-candidate-list se-candidate-list-disabled">
                    <li v-for="c in candidateAlreadyAddedGroups.slice(0, 20)" :key="c.id">
                      <div class="se-candidate se-candidate-disabled">
                        <span class="material-symbols-outlined se-row-icon">workspaces</span>
                        <div>
                          <div class="se-row-name">{{ c.name }}</div>
                          <div v-if="c.description" class="se-row-desc">{{ c.description }}</div>
                        </div>
                        <span class="material-symbols-outlined se-candidate-already">check</span>
                      </div>
                    </li>
                  </ul>
                </template>
              </div>
            </div>
          </div>

          <!-- Users -->
          <div class="se-perms-col">
            <h3 class="se-perms-col-title">个人</h3>
            <p class="se-perms-col-hint">直接给单个用户授角色,适合未入任何组的外部协作者或临时访问。</p>
            <div class="se-search-row">
              <span class="material-symbols-outlined se-search-icon">search</span>
              <input
                v-model="userSearch"
                type="text"
                class="se-search"
                placeholder="按姓名或邮箱搜索"
              />
            </div>

            <ul v-if="filteredUsers.length > 0" class="se-list">
              <li v-for="(u, idx) in filteredUsers" :key="u.userId" class="se-row">
                <span
                  class="se-row-avatar"
                  :style="{ background: allUsers.find((x) => x.id === u.userId)?.color || '#888' }"
                  aria-hidden="true"
                >{{ (userNameOf(u.userId) || '?').slice(0, 2) }}</span>
                <div class="se-row-text">
                  <div class="se-row-name">{{ userNameOf(u.userId) }}</div>
                  <div v-if="userEmailOf(u.userId)" class="se-row-desc">{{ userEmailOf(u.userId) }}</div>
                </div>
                <div class="se-role" role="radiogroup">
                  <button
                    v-for="opt in ROLE_OPTIONS"
                    :key="opt.value"
                    type="button"
                    class="se-role-btn"
                    :class="{ 'is-active': u.role === opt.value }"
                    :aria-pressed="u.role === opt.value"
                    @click="setUserRole(idx, opt.value)"
                  >{{ opt.label }}</button>
                </div>
                <button
                  type="button"
                  class="se-remove"
                  title="移除授权"
                  @click="removeUser(idx)"
                >
                  <span class="material-symbols-outlined">close</span>
                </button>
              </li>
            </ul>
            <div v-else-if="userSearch.trim()" class="se-empty">没有匹配的用户</div>
            <div v-else class="se-empty">还没有授权任何个人</div>

            <div class="se-add">
              <button
                ref="userAddBtnEl"
                type="button"
                class="btn ghost se-add-btn"
                :class="{ 'se-add-btn-open': userAddOpen }"
                @click="userAddOpen = !userAddOpen"
              >
                <span class="material-symbols-outlined se-add-icon">{{ userAddOpen ? 'close' : 'add' }}</span>
                <span>{{ userAddOpen ? '收起' : '添加用户' }}</span>
              </button>
              <div v-show="userAddOpen" ref="userPopoverEl" class="se-popover">
                <div class="se-popover-search">
                  <label class="se-popover-search-label">查找候选用户</label>
                  <div class="se-popover-search-row">
                    <span class="material-symbols-outlined se-search-icon">search</span>
                    <input
                      v-model="userAddSearch"
                      type="text"
                      class="se-search"
                      placeholder="按姓名或邮箱筛选候选"
                      autofocus
                    />
                  </div>
                </div>
                <ul v-if="candidateUsers.length > 0" class="se-candidate-list">
                  <li v-for="c in candidateUsers.slice(0, 20)" :key="c.id">
                    <button type="button" class="se-candidate" @click="addUser(c.id)">
                      <span
                        class="se-row-avatar"
                        :style="{ background: c.color }"
                        aria-hidden="true"
                      >{{ c.name.slice(0, 2) }}</span>
                      <div class="se-candidate-text">
                        <div class="se-row-name">
                          {{ c.name }}
                          <span
                            v-if="c.status === 'must_reset_password'"
                            class="se-status-chip se-status-chip-pending"
                            title="该用户尚未完成首次登录,授权仍有效"
                          >待激活</span>
                        </div>
                        <div class="se-row-desc">{{ c.email }}</div>
                      </div>
                    </button>
                  </li>
                </ul>
                <div v-if="candidateUsers.length > 20" class="se-candidate-more">
                  共 {{ candidateUsers.length }} 个候选,输入关键词以筛选
                </div>
                <div v-else class="se-empty">没有可添加的用户</div>
                <template v-if="userAddSearchDebounced.trim() && candidateAlreadyAddedUsers.length > 0">
                  <div class="se-popover-divider" />
                  <div class="se-popover-section-label">
                    <span class="material-symbols-outlined">check_circle</span>
                    已授权 ({{ candidateAlreadyAddedUsers.length }})
                  </div>
                  <ul class="se-candidate-list se-candidate-list-disabled">
                    <li v-for="c in candidateAlreadyAddedUsers.slice(0, 20)" :key="c.id">
                      <div class="se-candidate se-candidate-disabled">
                        <span
                          class="se-row-avatar"
                          :style="{ background: c.color }"
                          aria-hidden="true"
                        >{{ c.name.slice(0, 2) }}</span>
                        <div class="se-candidate-text">
                          <div class="se-row-name">{{ c.name }}</div>
                          <div class="se-row-desc">{{ c.email }}</div>
                        </div>
                        <span class="material-symbols-outlined se-candidate-already">check</span>
                      </div>
                    </li>
                  </ul>
                </template>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

  </div>
</template>

<style scoped>
/* max-width: 1680 + margin auto 对齐 .content-inner(components.css:485)
   —— 2K 屏下「访问控制」两列(用户组 / 个人)自然撑开,小屏不挤压。 */
.space-edit {
  max-width: 1680px;
  margin: 0 auto;
  padding-bottom: 80px;
  width: 100%;
}

/* ─── Layout ─── */
.se-stack { display: flex; flex-direction: column; gap: 12px; }

/* ─── Breadcrumb ─── */
.se-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 12px;
}
.se-breadcrumb a {
  color: var(--accent);
  text-decoration: none;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: 3px;
  transition: background var(--duration-fast) var(--ease-out);
}
.se-breadcrumb a:hover {
  background: var(--accent-soft, #DEEBFF);
  text-decoration: none;
}
.se-bc-sep { color: var(--text-3); }
.se-bc-current { color: var(--text-2); font-weight: 500; }

.se-error {
  padding: 48px;
  text-align: center;
  color: var(--danger);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.se-error .btn { margin-top: 12px; display: inline-flex; }

/* space-admin 顶部说明 banner:亮蓝色 chip 风格,跟 se-error 区分。
   单行内嵌图标 + 文案,避免占用额外行高 —— 视觉提醒非阻断。 */
.se-info {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  line-height: 1.5;
}
.se-info-icon { font-size: 18px; flex-shrink: 0; }
.se-info strong { font-weight: 600; }

/* ─── Header ─── */
.se-header { margin-bottom: 14px; }
.se-title-row { display: flex; align-items: center; gap: 12px; }
.se-avatar {
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
.se-icon { font-size: 22px !important; }
.se-initials { letter-spacing: 0.5px; text-transform: uppercase; }
.se-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0; }
.se-kind-badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 11px;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.se-kind-personal { background: var(--accent-soft); color: var(--accent); }
.se-kind-shared { background: var(--bg-canvas); color: var(--text-3); }
.se-sub { font-size: 13px; color: var(--text-3); margin: 4px 0 0 52px; }
.se-sub a { color: var(--accent); text-decoration: none; }
.se-sub a:hover { text-decoration: underline; }
.se-sub code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background: var(--bg-canvas);
  padding: 1px 4px;
  border-radius: 3px;
}
/* Metadata 单行横排:创建于 / 所有者 / 管理员 用 flex-wrap + 小 gap。
   margin-left: 52px 对齐 title 行(40 头像 + 12 gap)。 */
.se-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  font-size: 13px;
  color: var(--text-3);
  margin: 0 0 0 52px;
  align-items: baseline;
  line-height: 1.5;
}
.se-meta-sep { color: var(--text-3); user-select: none; }
.se-meta-item { display: inline-flex; align-items: baseline; gap: 2px; }
.se-meta-item a {
  color: var(--accent);
  text-decoration: none;
  padding: 1px 3px;
  margin: -1px -3px;
  border-radius: 3px;
  transition: background var(--duration-fast) var(--ease-out);
}
.se-meta-item a:hover { background: var(--accent-soft, #DEEBFF); }
.se-meta-item code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background: var(--bg-canvas);
  padding: 1px 4px;
  border-radius: 3px;
}

/* ─── Card ─── */
.se-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 16px 20px;
}
.se-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 12px 0;
}

/* ─── Form fields ─── */
/* 两列布局:name 1fr min 160px,description 2fr(可塞一句话),color 跨双列。
   12px column gap / 14px row gap —— 比之前 3 行堆叠省 ~40px 垂直空间。 */
.se-fields {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) 2fr;
  column-gap: 16px;
  row-gap: 14px;
}
.field-color { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
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
.se-color-row { display: flex; flex-direction: column; gap: 6px; }
.color-swatches { display: flex; gap: 6px; }
.cs-swatch {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 0;
  cursor: pointer;
  padding: 0;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--duration-fast) var(--ease-out);
}
.cs-swatch:hover:not(:disabled) { transform: scale(1.06); }
/* 选中态:中心叠一个白色 check icon。语义化(对号 = 选中),
   不抢眼(swatch 本体不变,只是上面多了个 glyph),适配任何背景色。
   text-shadow 防止浅色 swatch(浅黄 / 浅绿)上白 check 糊掉。 */
.cs-swatch-check {
  font-size: 18px;
  color: white;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
  line-height: 1;
  pointer-events: none;
}
.se-card-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
  /* dirty 视觉锚定:用顶部细线 + 浅底把 save bar 跟 form fields 划清,
     避免「右上角孤立」感 —— 以前是裸 margin-top 飘在那里。 */
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.se-card-actions:has(button:not(:disabled)) {
  border-top-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}
/* saving spinner:CSS-only,12px 圆环,纯 currentColor 跟随按钮文字色,
   disabled 态下按钮文字变浅,spinner 也跟着淡。 */
.se-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: se-spin 0.6s linear infinite;
  vertical-align: -2px;
  margin-right: 4px;
}
@keyframes se-spin {
  to { transform: rotate(360deg); }
}

/* ─── Danger zone ─── */
.se-danger-zone {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.se-danger-title { font-size: 12px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 10px 0; }

/* ─── Access control (perms card) ─── */
.se-perms-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.se-perms-header .se-card-title { margin-bottom: 0; }
.se-perms-actions { display: flex; gap: 8px; flex-shrink: 0; }
.se-perms-error { font-size: 13px; color: var(--danger); margin: 8px 0 0; }
.se-perms-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 4px 0 16px 0;
  line-height: 1.5;
}
.se-perms-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}
.se-perms-col { display: flex; flex-direction: column; gap: 10px; }
.se-perms-col-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}
.se-perms-col-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: -6px 0 0 0;
  line-height: 1.5;
}

.se-search-row { position: relative; }
.se-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 18px;
  color: var(--text-3);
  pointer-events: none;
}
.se-search {
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
  box-sizing: border-box;
}
.se-search:focus { background: var(--bg); border-color: var(--accent); }

.se-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 480px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}
.se-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  transition: background var(--duration-fast) var(--ease-out);
}
.se-row:last-child { border-bottom: 0; }
.se-row:hover { background: var(--bg-canvas); }
.se-row-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; }
.se-row-avatar {
  width: 28px; height: 28px; font-size: 11px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; flex-shrink: 0;
}
.se-row-text { min-width: 0; flex: 1; }
.se-row-name { font-size: 14px; font-weight: 500; color: var(--text-1); }
.se-row-desc { font-size: 12px; color: var(--text-3); margin-top: 2px; }

.se-role {
  display: inline-flex;
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 2px;
  flex-shrink: 0;
}
.se-role-btn {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.se-role-btn:hover:not(.is-active) { background: var(--bg); }
.se-role-btn.is-active { background: var(--accent); color: white; }

.se-remove {
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 4px;
  border-radius: 50%;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.se-remove:hover { color: var(--danger); background: var(--bg-canvas); }
.se-remove .material-symbols-outlined { font-size: 18px; }

.se-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md, 4px);
}

.se-add { position: relative; }
.se-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.se-add-icon { font-size: 18px !important; }
/* popover 打开态:toggle 按钮变成"按下去"的样子 —— accent-soft 底色
   提示"按这个会关闭"。 */
.se-add-btn-open {
  background: var(--accent-soft, #DEEBFF);
  color: var(--accent-hover, #0747A6);
}

.se-popover {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  padding: 12px;
  z-index: 10;
}
.se-popover-search { position: relative; margin-bottom: 8px; }
.se-popover-search-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}
.se-popover-search-row { position: relative; }
.se-popover .se-search {
  background: var(--bg);
  border-color: var(--border);
}
.se-popover .se-search:focus {
  background: var(--bg);
  border-color: var(--focus-ring);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.se-candidate-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}
.se-candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-md, 4px);
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out);
}
.se-candidate:hover { background: var(--bg-canvas); }
.se-candidate-text { min-width: 0; flex: 1; }
.se-status-chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  border-radius: var(--radius-pill, 999px);
  vertical-align: 1px;
}
.se-status-chip-pending {
  background: var(--accent-softer, #F4F8FF);
  color: var(--accent-hover, #0747A6);
  border: 1px solid var(--accent-soft, #DEEBFF);
}
.se-candidate-more {
  padding: 6px 10px 2px;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
}
.se-popover-actions { display: flex; justify-content: flex-end; margin-top: 8px; }

/* popover section 分隔:在「可添加」和「已授权」之间画一根细线,提示
   这是两块不同语义的数据。 */
.se-popover-divider {
  height: 1px;
  background: var(--border);
  margin: 8px 0;
}
.se-popover-section-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 4px 4px;
}
.se-popover-section-label .material-symbols-outlined {
  font-size: 14px;
  color: var(--text-3);
}
/* 「已授权」列表:无 hover、无 focus 样式,纯静态展示。 */
.se-candidate-list-disabled {
  margin-top: 0;
}
.se-candidate-disabled {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-md, 4px);
  cursor: default;
  text-align: left;
  opacity: 0.55;
  pointer-events: none;
}
.se-candidate-disabled .se-row-name { color: var(--text-2); }
.se-candidate-already {
  font-size: 18px;
  color: var(--text-3);
  flex-shrink: 0;
  margin-left: auto;
}

</style>
