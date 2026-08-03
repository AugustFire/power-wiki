<script setup lang="ts">
/**
 * SpaceGrantsTab — 访问控制 tab(grants tab 内容)。
 *
 * 从 SpaceEditView 拆出。之前整段「用户组 / 个人」两栏 + popover 添加 +
 * 角色菜单 + 保存条 + matrix help 按钮全嵌在 2600 行单文件;现在收敛
 * 在这一个文件,shell 只负责加载并把数据往下传。
 *
 * 行为:
 *  - 双向绑定 `grants`:tab 内部对 grants 的修改通过 `update:grants`
 *    抛回 shell,shell 同步自己持有的 ref 供 header(adminUserIds)读。
 *  - 保存:`api.spaces.permissions.set(spaceId, input)` 全量替换,成功
 *    后用响应更新 grants + 抛 `saved` 给 shell 让 originalGrants 跟进。
 *  - 跨 tab 高亮:`highlightedGrant` 由 shell 从 ?highlight= query 解出
 *    后传入,行渲染时按 id 匹配。
 *  - 角色菜单 / popover 全部 Teleport 到 body,close 逻辑(Esc / click
 *    outside / scroll)在本组件内完整管理,unmount 时清监听。
 *  - 有效角色预览(Phase 3.2):保存条上方展示 fromRole → toRole 变化,
 *    用 lib/spacePermissionPreview 纯函数计算。需要 group memberIds
 *    数据,见 fetchGroupMembers 的并行拉取。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type Ref,
} from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { api, ApiError } from '@/lib/api'
import { useEscape } from '@/composables/useEscape'
import {
  diffEffectiveRoles,
  summarizeDiff,
} from '@/lib/spacePermissionPreview'
import SpaceCapabilityDialog from './SpaceCapabilityDialog.vue'
import type {
  Space,
  SpaceGrants,
  SpaceRole,
  User,
  UserGroup,
} from '@power-wiki/shared'

const props = defineProps<{
  space: Space
  grants: SpaceGrants
  originalGrants: SpaceGrants
  allGroups: UserGroup[]
  allUsers: User[]
  highlightedGrant: { kind: 'user' | 'group'; id: string } | null
}>()

const emit = defineEmits<{
  (e: 'update:grants', grants: SpaceGrants): void
  (e: 'saved', grants: SpaceGrants): void
}>()

const router = useRouter()
const uiStore = useUiStore()

/* ─── Save / cancel state ─────────────────────────────────────── */
const permsSaving = ref(false)
const permsError = ref<string | null>(null)

const permsDirty = computed(
  () => JSON.stringify(props.grants) !== JSON.stringify(props.originalGrants),
)

/* ─── Search debounce ─────────────────────────────────────────── */
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

const groupSearch = ref('')
const userSearch = ref('')
const groupAddSearch = ref('')
const userAddSearch = ref('')
const groupSearchDebounced = makeDebounced(groupSearch)
const userSearchDebounced = makeDebounced(userSearch)
const groupAddSearchDebounced = makeDebounced(groupAddSearch)
const userAddSearchDebounced = makeDebounced(userAddSearch)

/* ─── Popover 状态 ─────────────────────────────────────────────── */
const groupAddOpen = ref(false)
const userAddOpen = ref(false)
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

/* ─── 角色菜单(Teleport 到 body) ──────────────────────────────── */
type RoleMenuTarget =
  | { kind: 'group'; id: string }
  | { kind: 'user'; id: string }
const roleMenuTarget = ref<RoleMenuTarget | null>(null)
const roleMenuEl = ref<HTMLElement | null>(null)
const roleMenuTriggerEl = ref<HTMLElement | null>(null)
const roleMenuPosition = ref({ top: 0, left: 0, width: 232 })

function closeRoleMenu() {
  roleMenuTarget.value = null
  roleMenuTriggerEl.value = null
}
function isRoleMenuOpen(kind: RoleMenuTarget['kind'], id: string): boolean {
  return roleMenuTarget.value?.kind === kind && roleMenuTarget.value.id === id
}

const ROLE_OPTIONS: Array<{ value: SpaceRole; label: string; icon: string; hint: string }> = [
  { value: 'viewer', label: '只读', icon: 'visibility', hint: '可以查看,但不能创建或修改页面' },
  { value: 'editor', label: '编辑', icon: 'edit', hint: '可以创建和编辑页面' },
  { value: 'admin',  label: '管理', icon: 'shield_person', hint: '可以管理成员授权和空间基本信息' },
]
const GROUP_ROLE_OPTIONS = ROLE_OPTIONS.filter((o) => o.value !== 'admin')

function toggleRoleMenu(kind: RoleMenuTarget['kind'], id: string, event: MouseEvent) {
  if (isRoleMenuOpen(kind, id)) {
    closeRoleMenu()
    return
  }
  closeGroupAdd()
  closeUserAdd()
  const trigger = event.currentTarget as HTMLElement
  const rect = trigger.getBoundingClientRect()
  const width = 232
  const optionCount = kind === 'group' ? GROUP_ROLE_OPTIONS.length : ROLE_OPTIONS.length
  const menuHeight = optionCount * 52 + 8
  const below = rect.bottom + 6
  const top = below + menuHeight <= window.innerHeight - 8
    ? below
    : rect.top - menuHeight - 6
  roleMenuPosition.value = {
    top,
    left: Math.min(
      Math.max(8, rect.right - width),
      window.innerWidth - width - 8,
    ),
    width,
  }
  roleMenuTriggerEl.value = trigger
  roleMenuTarget.value = { kind, id } as RoleMenuTarget
}

const roleMenuOptions = computed(() =>
  roleMenuTarget.value?.kind === 'group' ? GROUP_ROLE_OPTIONS : ROLE_OPTIONS,
)
const roleMenuRole = computed<SpaceRole | null>(() => {
  const target = roleMenuTarget.value
  if (!target) return null
  return target.kind === 'group'
    ? props.grants.groups.find((grant) => grant.groupId === target.id)!.role
    : props.grants.users.find((grant) => grant.userId === target.id)!.role
})

function chooseRole(role: SpaceRole) {
  const target = roleMenuTarget.value!
  if (target.kind === 'group') {
    const index = props.grants.groups.findIndex((grant) => grant.groupId === target.id)
    setGroupRole(index, role)
  } else {
    const index = props.grants.users.findIndex((grant) => grant.userId === target.id)
    setUserRole(index, role)
  }
  closeRoleMenu()
}

useEscape(() => groupAddOpen.value, closeGroupAdd)
useEscape(() => userAddOpen.value, closeUserAdd)
useEscape(() => roleMenuTarget.value !== null, closeRoleMenu)

function onDocMouseDown(e: MouseEvent) {
  const t = e.target as Node
  if (roleMenuTarget.value) {
    if (roleMenuEl.value?.contains(t)) return
    if (roleMenuTriggerEl.value?.contains(t)) return
    closeRoleMenu()
    return
  }
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

function onScrollOrResize() {
  if (roleMenuTarget.value) closeRoleMenu()
}

watch([groupAddOpen, userAddOpen, roleMenuTarget], (vals) => {
  if (vals.some(Boolean)) {
    void nextTick(() => {
      document.addEventListener('mousedown', onDocMouseDown)
      window.addEventListener('scroll', onScrollOrResize, true)
      window.addEventListener('resize', onScrollOrResize)
    })
  } else {
    document.removeEventListener('mousedown', onDocMouseDown)
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
})

/* ─── Matrix help 状态(本组件内自管) ──────────────────────────── */
const matrixHelpOpen = ref(false)

/* ─── Role options helpers ────────────────────────────────────── */
function roleOption(role: SpaceRole) {
  return ROLE_OPTIONS.find((option) => option.value === role)!
}

/* ─── 列表 / 候选 / 名字查找 helpers ─────────────────────────── */
function groupNameOf(id: string): string {
  return props.allGroups.find((g) => g.id === id)?.name ?? id
}
function groupDescOf(id: string): string | null | undefined {
  return props.allGroups.find((g) => g.id === id)?.description
}
function userNameOf(id: string): string {
  return props.allUsers.find((u) => u.id === id)?.name ?? id
}
function userEmailOf(id: string): string | undefined {
  return props.allUsers.find((u) => u.id === id)?.email
}

const filteredGroups = computed(() => {
  const q = groupSearchDebounced.value.trim().toLowerCase()
  if (!q) return props.grants.groups
  return props.grants.groups.filter(
    (g) =>
      groupNameOf(g.groupId).toLowerCase().includes(q) ||
      (groupDescOf(g.groupId) ?? '').toLowerCase().includes(q),
  )
})
const filteredUsers = computed(() => {
  const q = userSearchDebounced.value.trim().toLowerCase()
  if (!q) return props.grants.users
  return props.grants.users.filter(
    (u) =>
      userNameOf(u.userId).toLowerCase().includes(q) ||
      (userEmailOf(u.userId) ?? '').toLowerCase().includes(q),
  )
})
const candidateGroups = computed(() => {
  const q = groupAddSearchDebounced.value.trim().toLowerCase()
  const taken = new Set(props.grants.groups.map((g) => g.groupId))
  const candidates = props.allGroups.filter(
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
  const taken = new Set(props.grants.users.map((u) => u.userId))
  const candidates = props.allUsers.filter(
    (u) => !taken.has(u.id) && u.status !== 'disabled' && u.status !== 'anonymized',
  )
  if (!q) return candidates
  return candidates.filter(
    (u) =>
      u.name.toLowerCase().includes(q) ||
      (u.email ?? '').toLowerCase().includes(q),
  )
})
const candidateAlreadyAddedGroups = computed(() => {
  const q = groupAddSearchDebounced.value.trim().toLowerCase()
  if (!q) return []
  const taken = new Set(props.grants.groups.map((g) => g.groupId))
  return props.allGroups.filter(
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
  const taken = new Set(props.grants.users.map((u) => u.userId))
  return props.allUsers.filter(
    (u) =>
      taken.has(u.id) &&
      u.status !== 'disabled' &&
      u.status !== 'anonymized' &&
      (u.name.toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q)),
  )
})

/* ─── Grants 写入(via emit) ─────────────────────────────────── */
function setGroupRole(idx: number, role: SpaceRole) {
  const next = [...props.grants.groups]
  next[idx] = { ...next[idx]!, role }
  emit('update:grants', { ...props.grants, groups: next })
}
function setUserRole(idx: number, role: SpaceRole) {
  const next = [...props.grants.users]
  next[idx] = { ...next[idx]!, role }
  emit('update:grants', { ...props.grants, users: next })
}
function removeGroup(idx: number) {
  emit('update:grants', {
    ...props.grants,
    groups: props.grants.groups.filter((_, i) => i !== idx),
  })
}
function removeUser(idx: number) {
  emit('update:grants', {
    ...props.grants,
    users: props.grants.users.filter((_, i) => i !== idx),
  })
}
function addGroup(groupId: string) {
  emit('update:grants', {
    ...props.grants,
    groups: [
      ...props.grants.groups,
      { groupId, role: 'viewer', grantedBy: null, grantedAt: Date.now() },
    ],
  })
  closeGroupAdd()
}
function addUser(userId: string) {
  emit('update:grants', {
    ...props.grants,
    users: [
      ...props.grants.users,
      { userId, role: 'viewer', grantedBy: null, grantedAt: Date.now() },
    ],
  })
  closeUserAdd()
}

/* ─── Save / cancel ──────────────────────────────────────────── */
async function onSavePerms() {
  if (!permsDirty.value || permsSaving.value) return
  permsSaving.value = true
  permsError.value = null
  try {
    const input = {
      groups: props.grants.groups.map((g) => ({
        groupId: g.groupId,
        role: g.role,
      })),
      users: props.grants.users.map((u) => ({
        userId: u.userId,
        role: u.role,
      })),
    }
    const updated = await api.spaces.permissions.set(props.space.id, input)
    emit('update:grants', updated)
    emit('saved', updated)
    uiStore.notify('访问控制已保存', 'success')
  } catch (e) {
    permsError.value = e instanceof ApiError ? e.message : '保存失败'
  } finally {
    permsSaving.value = false
  }
}

function onCancelPerms() {
  emit('update:grants', JSON.parse(JSON.stringify(props.originalGrants)))
  permsError.value = null
}

/* ─── P1-4 有效角色预览(Phase 3.2) ─────────────────────────────
 * group 成员数据(UserGroup.memberIds)由 list 端点不带,需要单独拉。
 * 这里用并发 fetch 拉齐 allGroups 中所有 group 的 memberIds,异步
 * 注入,完成前 effective role 预览只算直接 user grant(降级为纯直接
 * grant diff),完成后才显示完整多来源 diff。
 */
const groupsWithMembers = ref<UserGroup[]>(props.allGroups)
let fetchedMemberIds = false

async function fetchGroupMembers() {
  if (fetchedMemberIds) return
  fetchedMemberIds = true
  const missing = props.allGroups.filter((g) => !g.memberIds && !g.id.startsWith('pg-'))
  if (missing.length === 0) {
    groupsWithMembers.value = props.allGroups
    return
  }
  const results = await Promise.allSettled(
    missing.map((g) => api.admin.groups.get(g.id)),
  )
  const map = new Map<string, UserGroup>()
  for (const g of props.allGroups) map.set(g.id, g)
  for (const r of results) {
    if (r.status === 'fulfilled') {
      map.set(r.value.id, r.value)
    }
  }
  groupsWithMembers.value = Array.from(map.values())
}

watch(
  () => props.allGroups,
  () => {
    fetchedMemberIds = false
    void fetchGroupMembers()
  },
  { immediate: true },
)

const roleDiff = computed(() =>
  diffEffectiveRoles(
    props.originalGrants,
    props.grants,
    groupsWithMembers.value,
    props.allUsers,
  ),
)
const roleDiffSummary = computed(() => summarizeDiff(roleDiff.value))

function userLabel(c: { user: User; fromRole: SpaceRole | null; toRole: SpaceRole | null }): string {
  const name = c.user.name
  const from = c.fromRole ? roleOption(c.fromRole).label : '无访问权'
  const to = c.toRole ? roleOption(c.toRole).label : '无访问权'
  return `${name}: ${from} → ${to}`
}
</script>

<template>
  <div class="sgt-stack">
    <section class="se-card se-perms-card">
      <div class="se-perms-header">
        <div class="se-perms-title-wrap">
          <h2 class="se-card-title">访问控制</h2>
          <button
            type="button"
            class="se-matrix-help-btn"
            :class="{ 'se-matrix-help-btn-open': matrixHelpOpen }"
            :aria-label="matrixHelpOpen ? '关闭角色权限对照表' : '查看角色权限对照表'"
            title="查看各角色权限差异"
            @click="matrixHelpOpen = !matrixHelpOpen"
          >
            <span class="material-symbols-outlined">{{ matrixHelpOpen ? 'close' : 'help' }}</span>
          </button>
        </div>
        <div v-if="permsDirty || permsError" class="se-perms-actions">
          <button type="button" class="btn ghost" :disabled="permsSaving" @click="onCancelPerms">取消</button>
          <button type="button" class="btn primary" :disabled="permsSaving" @click="onSavePerms">
            <span v-if="permsSaving" class="se-spinner" aria-hidden="true"></span>
            {{ permsSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>

      <!-- ─── P1-4 有效角色变化预览(Phase 3.2) ─── -->
      <div v-if="permsDirty && roleDiffSummary.hasChanges" class="se-perms-diff">
        <div class="se-perms-diff-head">
          <span class="material-symbols-outlined se-perms-diff-icon">manage_search</span>
          <span class="se-perms-diff-title">保存后将影响 {{ roleDiffSummary.promoted + roleDiffSummary.demoted + roleDiffSummary.lostAccess + roleDiffSummary.gainedAccess }} 人</span>
        </div>
        <ul class="se-perms-diff-list">
          <li v-if="roleDiffSummary.promoted > 0" class="se-perms-diff-item se-perms-diff-promote">
            <span class="material-symbols-outlined">trending_up</span>
            <span>升级 {{ roleDiffSummary.promoted }} 人</span>
            <ul class="se-perms-diff-detail">
              <li v-for="c in roleDiff.promoted" :key="`p-${c.user.id}`">{{ userLabel(c) }}</li>
            </ul>
          </li>
          <li v-if="roleDiffSummary.demoted > 0" class="se-perms-diff-item se-perms-diff-demote">
            <span class="material-symbols-outlined">trending_down</span>
            <span>降级 {{ roleDiffSummary.demoted }} 人</span>
            <ul class="se-perms-diff-detail">
              <li v-for="c in roleDiff.demoted" :key="`d-${c.user.id}`">{{ userLabel(c) }}</li>
            </ul>
          </li>
          <li v-if="roleDiffSummary.lostAccess > 0" class="se-perms-diff-item se-perms-diff-lost">
            <span class="material-symbols-outlined">block</span>
            <span>失去访问权 {{ roleDiffSummary.lostAccess }} 人</span>
            <ul class="se-perms-diff-detail">
              <li v-for="c in roleDiff.lostAccess" :key="`l-${c.user.id}`">{{ userLabel(c) }}</li>
            </ul>
          </li>
          <li v-if="roleDiffSummary.gainedAccess > 0" class="se-perms-diff-item se-perms-diff-gained">
            <span class="material-symbols-outlined">person_add</span>
            <span>获得访问权 {{ roleDiffSummary.gainedAccess }} 人</span>
            <ul class="se-perms-diff-detail">
              <li v-for="c in roleDiff.gainedAccess" :key="`g-${c.user.id}`">{{ userLabel(c) }}</li>
            </ul>
          </li>
        </ul>
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
            <li
              v-for="(g, idx) in filteredGroups"
              :key="g.groupId"
              class="se-row"
              :class="{ 'se-row-highlight': highlightedGrant?.kind === 'group' && highlightedGrant.id === g.groupId }"
            >
              <span class="material-symbols-outlined se-row-icon">workspaces</span>
              <div class="se-row-text">
                <div class="se-row-name">{{ groupNameOf(g.groupId) }}</div>
                <div v-if="groupDescOf(g.groupId)" class="se-row-desc">{{ groupDescOf(g.groupId) }}</div>
              </div>
              <button
                type="button"
                class="se-role-trigger"
                :class="[`se-role-${g.role}`, { 'se-role-trigger-open': isRoleMenuOpen('group', g.groupId) }]"
                :data-role="g.role"
                :aria-haspopup="'menu'"
                :aria-expanded="isRoleMenuOpen('group', g.groupId)"
                :title="roleOption(g.role).hint"
                @click="toggleRoleMenu('group', g.groupId, $event)"
              >
                <span class="material-symbols-outlined se-role-trigger-icon">
                  {{ roleOption(g.role).icon }}
                </span>
                <span class="se-role-trigger-label">{{ roleOption(g.role).label }}</span>
                <span class="material-symbols-outlined se-role-trigger-caret">expand_more</span>
              </button>
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
            <li
              v-for="(u, idx) in filteredUsers"
              :key="u.userId"
              class="se-row"
              :class="{ 'se-row-highlight': highlightedGrant?.kind === 'user' && highlightedGrant.id === u.userId }"
            >
              <span
                class="se-row-avatar"
                :style="{ background: allUsers.find((x) => x.id === u.userId)?.color || '#888' }"
                aria-hidden="true"
              >{{ (userNameOf(u.userId) || '?').slice(0, 2) }}</span>
              <div class="se-row-text">
                <div class="se-row-name">{{ userNameOf(u.userId) }}</div>
                <div v-if="userEmailOf(u.userId)" class="se-row-desc">{{ userEmailOf(u.userId) }}</div>
              </div>
              <button
                type="button"
                class="se-role-trigger"
                :class="[`se-role-${u.role}`, { 'se-role-trigger-open': isRoleMenuOpen('user', u.userId) }]"
                :data-role="u.role"
                :aria-haspopup="'menu'"
                :aria-expanded="isRoleMenuOpen('user', u.userId)"
                :title="roleOption(u.role).hint"
                @click="toggleRoleMenu('user', u.userId, $event)"
              >
                <span class="material-symbols-outlined se-role-trigger-icon">
                  {{ roleOption(u.role).icon }}
                </span>
                <span class="se-role-trigger-label">{{ roleOption(u.role).label }}</span>
                <span class="material-symbols-outlined se-role-trigger-caret">expand_more</span>
              </button>
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

    <SpaceCapabilityDialog :open="matrixHelpOpen" @close="matrixHelpOpen = false" />

    <!-- 自定义角色下拉菜单。Teleport 到 body 避开 row 内 stacking
         context;固定定位坐标由 toggleRoleMenu 在 trigger.getBoundingClientRect()
         时算好,随窗口滚动 / resize 自动关(见 onScrollOrResize)。 -->
    <Teleport to="body">
      <Transition name="se-role-menu">
        <div
          v-if="roleMenuTarget"
          ref="roleMenuEl"
          class="se-role-menu"
          role="menu"
          :style="{
            position: 'fixed',
            top: roleMenuPosition.top + 'px',
            left: roleMenuPosition.left + 'px',
            width: roleMenuPosition.width + 'px',
          }"
        >
          <button
            v-for="opt in roleMenuOptions"
            :key="opt.value"
            type="button"
            class="se-role-menu-option"
            :class="[`se-role-${opt.value}`, { 'se-role-menu-option-active': roleMenuRole === opt.value }]"
            :data-role="opt.value"
            role="menuitemradio"
            :aria-checked="roleMenuRole === opt.value"
            :title="opt.hint"
            @click="chooseRole(opt.value)"
          >
            <span class="material-symbols-outlined se-role-menu-icon">{{ opt.icon }}</span>
            <span class="se-role-menu-label">{{ opt.label }}</span>
            <span
              v-if="roleMenuRole === opt.value"
              class="material-symbols-outlined se-role-menu-check"
            >check</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.sgt-stack { display: flex; flex-direction: column; gap: 12px; }

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

/* P1-4 角色变化预览(Phase 3.2):存于 header 与 hint 之间的折叠 banner。
   仅在 dirty + 至少一处变化时显示,空状态整条不渲染。 */
.se-perms-diff {
  margin: 12px 0 0;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  background: var(--accent-soft);
  border-radius: var(--radius-md, 4px);
}
.se-perms-diff-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 8px;
}
.se-perms-diff-icon { font-size: 18px !important; }
.se-perms-diff-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.se-perms-diff-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-radius: var(--radius-sm, 3px);
  background: var(--bg);
}
.se-perms-diff-item > .material-symbols-outlined {
  font-size: 14px !important;
  vertical-align: -2px;
  margin-right: 4px;
}
.se-perms-diff-detail {
  list-style: none;
  margin: 4px 0 0 22px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text-2);
}
.se-perms-diff-promote { color: var(--success-text); }
.se-perms-diff-demote { color: var(--warning); }
.se-perms-diff-lost { color: var(--danger); }
.se-perms-diff-gained { color: var(--accent); }

/* 角色权限对照表 help 按钮 */
.se-perms-title-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.se-matrix-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 50%;
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.se-matrix-help-btn .material-symbols-outlined { font-size: 18px; }
.se-matrix-help-btn:hover {
  background: var(--bg-canvas);
  color: var(--accent);
}
.se-matrix-help-btn-open {
  background: var(--accent-soft);
  color: var(--accent);
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
.se-row-highlight {
  animation: se-row-flash 1.8s var(--ease-out) both;
  position: relative;
}
.se-row-highlight::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid var(--accent);
  border-radius: inherit;
  pointer-events: none;
  animation: se-row-flash-border 1.8s var(--ease-out) both;
}
@keyframes se-row-flash {
  0%   { background: var(--accent-soft); }
  60%  { background: var(--accent-soft); }
  100% { background: transparent; }
}
@keyframes se-row-flash-border {
  0%   { opacity: 1; }
  60%  { opacity: 1; }
  100% { opacity: 0; }
}
.se-row-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; }
.se-row-avatar {
  width: 28px; height: 28px; font-size: 11px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; flex-shrink: 0;
}
.se-row-text { min-width: 0; flex: 1; }
.se-row-name { font-size: 14px; font-weight: 500; color: var(--text-1); }
.se-row-desc { font-size: 12px; color: var(--text-3); margin-top: 2px; }

.se-role-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 92px;
  height: 30px;
  padding: 0 22px 0 4px;
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-bottom: 1px solid transparent;
  border-radius: 0;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.se-role-trigger:hover {
  border-bottom-color: var(--border-strong);
  color: var(--text-1);
}
.se-role-trigger:focus-visible {
  outline: 0;
  border-bottom-color: var(--accent);
}
.se-role-trigger-open {
  border-bottom-color: var(--accent);
  color: var(--text-1);
}
.se-role-admin { color: var(--accent); }
.se-role-editor { color: var(--text-2); }
.se-role-viewer { color: var(--text-3); }

.se-role-trigger-icon {
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
  pointer-events: none;
}
.se-role-trigger-label {
  pointer-events: none;
  font-weight: 500;
}
.se-role-trigger-caret {
  position: absolute;
  right: 2px;
  font-size: 16px;
  line-height: 1;
  color: var(--text-3);
  pointer-events: none;
}

.se-role-menu {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: 0 6px 20px rgba(9, 30, 66, 0.16),
              0 2px 6px rgba(9, 30, 66, 0.08);
  padding: 4px;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.se-role-menu-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.se-role-menu-option:hover {
  background: var(--bg-canvas);
}
.se-role-menu-option:focus-visible {
  outline: 0;
  background: var(--bg-canvas);
}
.se-role-menu-option-active {
  background: var(--accent-soft);
}
.se-role-menu-option-active:hover {
  background: var(--accent-soft);
}
.se-role-menu-icon {
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
}
.se-role-menu-label {
  flex: 1;
  min-width: 0;
}
.se-role-menu-check {
  font-size: 16px;
  color: var(--accent);
  flex-shrink: 0;
}

.se-role-menu-enter-active {
  transition: opacity 120ms var(--ease-out),
              transform 120ms var(--ease-out);
}
.se-role-menu-leave-active {
  transition: opacity 80ms var(--ease-out);
}
.se-role-menu-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.se-role-menu-leave-to {
  opacity: 0;
}

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
</style>
