<script setup lang="ts">
/**
 * SpaceMembersTab — 空间成员展开视图(P1-2)。
 *
 * 数据来源:`GET /api/spaces/:id/members`,后端用一次 SQL + jsonb_agg
 * 聚合所有 user grant + 展开 group members,带 effectiveRole (max 规则)
 * + sources 数组(直接 / N 个组)。
 *
 * 行为:
 *  - 每个 user 一行:avatar + 名字 + effective role pill + 来源徽标
 *  - 「调整授权」按钮跳 grants tab + 高亮对应 grant 行(通过 ?highlight=
 *    query 传递,见 SpaceEditView 路由处理)
 *  - 搜索 300ms debounce,只过 name / email
 *  - 只读:所有写操作走 grants tab;本视图是浏览入口,不是写入口
 *
 * 视觉对齐 SpaceEditView 的 grants tab,保持「同一 space 管理」语境
 * 下的视觉一致;但因为是只读,密度可以稍高(每行 44px 而不是 56px)。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { api, ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import type {
  SpaceMember,
  SpaceMemberSource,
  SpaceRole,
  User,
  UserGroup,
} from '@power-wiki/shared'

const props = defineProps<{
  spaceId: string
}>()

const route = useRoute()
const router = useRouter()
const uiStore = useUiStore()

const members = ref<SpaceMember[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const search = ref('')
const searchDebounced = ref('')

/* ─── 搜索 debounce ───────────────────────────────────────────── */
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, (v) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchDebounced.value = v
  }, 300)
})
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

/* ─── 加载 ───────────────────────────────────────────────────── */
async function load() {
  loading.value = true
  loadError.value = null
  try {
    const res = await api.spaces.permissions.members(props.spaceId)
    members.value = res.items
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      loadError.value = '空间不存在或您没有管理权限'
    } else {
      loadError.value = e instanceof ApiError ? e.message : '加载成员失败'
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.spaceId, load)

/* ─── 过滤 ───────────────────────────────────────────────────── */
const filteredMembers = computed(() => {
  const q = searchDebounced.value.trim().toLowerCase()
  if (!q) return members.value
  return members.value.filter((m) => {
    if (m.user.name.toLowerCase().includes(q)) return true
    if (m.user.email && m.user.email.toLowerCase().includes(q)) return true
    return false
  })
})

/* ─── 角色查找(用于 pill 颜色 + icon) ───────────────────────── */
const ROLE_INFO: Record<SpaceRole, { label: string; icon: string }> = {
  admin:  { label: '管理', icon: 'shield_person' },
  editor: { label: '编辑', icon: 'edit' },
  viewer: { label: '只读', icon: 'visibility' },
}

/* ─── P2:哪一条来源在「赢」 ─────────────────────────────────────
 * 有效角色是所有来源按 MAX-rank 合并的结果(admin > editor > viewer),
 * 所以当一个人同时有「直接 viewer」和「某组 editor」两条来源时,生效的
 * 是 editor —— 统一的 effective pill 看不出这件事,管理员会误以为直接
 * 授权在生效。
 *
 * 后端已把 sources 按 role rank DESC 排序(见 spacePermissions.ts 的
 * jsonb_agg ORDER BY),所以「赢家」= role 等于 effectiveRole 的那些条目;
 * 同 rank 打平时 sources[0](direct 优先)是唯一的代表条目 —— 只给它挂
 * 「生效中」标记,避免多条并列时到处都是 ✓ 反而看不出重点。
 */
function isWinningSource(member: SpaceMember, index: number): boolean {
  const s = member.sources[index]
  if (!s) return false
  return s.role === member.effectiveRole && index === 0
}

/** 是否存在「被覆盖」的来源 —— 用来决定要不要给这一行加解释性 hint。 */
function hasOverriddenSource(member: SpaceMember): boolean {
  return member.sources.length > 1
    && member.sources.some((s) => s.role !== member.effectiveRole)
}

function sourceTitle(member: SpaceMember, s: SpaceMemberSource, index: number): string {
  const where = s.kind === 'direct'
    ? '直接授权'
    : `通过组「${s.groupName ?? s.groupId}」授权`
  const role = ROLE_INFO[s.role].label
  const verdict = isWinningSource(member, index)
    ? '当前生效的就是这一条'
    : s.role === member.effectiveRole
      ? '与生效角色同级'
      : `已被更高的「${ROLE_INFO[member.effectiveRole].label}」覆盖`
  return `${where} — ${role} · ${verdict}。到「授权」tab 修改。`
}

/* ─── 跳 grants tab + 高亮 ────────────────────────────────────── */
/**
 * 跳转到 grants tab 并通过 query 传递要高亮的 grant。
 * 来源是直接授权:highlight=grant:user:<memberUserId>;
 * 来源是组授权:highlight=grant:group:<groupId>。
 * grants tab 读 query 后给对应 row 加 1.8s flash 动画并自动清除。
 */
function goHighlightGrant(source: SpaceMemberSource, memberUserId: string) {
  const target = source.kind === 'direct'
    ? `grant:user:${memberUserId}`
    : `grant:group:${source.groupId ?? ''}`
  void router.replace({
    path: route.path,
    query: { ...route.query, tab: 'grants', highlight: target },
  })
}

/** 「调整」按钮文案:按首位来源区分「调整直接授权」/「调整用户组授权」,
 * 让管理员一眼能看出点击之后会跳到 grants tab 的哪一段。 */
function adjustLabel(m: SpaceMember): string {
  const first = m.sources[0]
  if (!first) return '调整授权'
  return first.kind === 'direct' ? '调整直接授权' : '调整用户组授权'
}
function adjustTitle(m: SpaceMember): string {
  const first = m.sources[0]
  if (!first) return '跳到授权 tab'
  if (first.kind === 'direct') return '跳到授权 tab 调整「' + m.user.name + '」的直接授权'
  return '跳到授权 tab 调整「' + (first.groupName ?? first.groupId) + '」用户组的授权'
}

/* ─── 复制 userId 调试(开发用,production no-op) ───────────── */
function copyUserId(userId: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(userId)
    uiStore.notify('已复制 userId', 'info')
  }
}

/* ─── P1-4:添加成员 / 用户组 入口(2026-08-03)────────────────────
 * 复用 `candidates` 端点(共享 space-admin 路径,不依赖 admin.users.list),
 * 默认角色 viewer —— 新成员进来先按只读访问,要更高权限去授权 tab 调。
 * 直接 upsert 调 `upsertUser` / `upsertGroup`,成功后 reload members,
 * 跟 grants tab 的 full-replace 不冲突(单条 upsert 走自己的路由)。
 * 跟 grants tab 同时打开编辑时:这里直接调 upsert,grants tab 本地
 * dirty 状态会被后端真相覆盖;UI 不做并发锁,跟原有 upsert 同语义。 */
const addOpen = ref<null | 'user' | 'group'>(null)
const addSearch = ref('')
const candidates = ref<{ users: User[]; groups: UserGroup[] }>({ users: [], groups: [] })
const candidatesLoading = ref(false)
const addBusy = ref(false)
const addRootEl = ref<HTMLElement | null>(null)

async function loadCandidates() {
  candidatesLoading.value = true
  try {
    candidates.value = await api.spaces.permissions.candidates(props.spaceId, addSearch.value)
  } catch (e) {
    if (e instanceof ApiError) {
      uiStore.notify(humanizeApiError(e), 'error')
    } else {
      uiStore.notify('加载候选失败', 'error')
    }
  } finally {
    candidatesLoading.value = false
  }
}

function openAdd(kind: 'user' | 'group') {
  addOpen.value = kind
  addSearch.value = ''
  void loadCandidates()
}
function closeAdd() {
  addOpen.value = null
  addSearch.value = ''
}

const filteredUserCandidates = computed(() => {
  if (addOpen.value !== 'user') return []
  const q = addSearch.value.trim().toLowerCase()
  const taken = new Set(members.value.map((m) => m.userId))
  let list = candidates.value.users.filter(
    (u) => !taken.has(u.id) && u.status !== 'disabled' && u.status !== 'anonymized',
  )
  if (q) list = list.filter((u) =>
    u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q),
  )
  return list
})
const filteredGroupCandidates = computed(() => {
  if (addOpen.value !== 'group') return []
  const q = addSearch.value.trim().toLowerCase()
  const taken = new Set<string>()
  for (const m of members.value) {
    for (const s of m.sources) {
      if (s.kind === 'group' && s.groupId) taken.add(s.groupId)
    }
  }
  let list = candidates.value.groups.filter(
    (g) => !taken.has(g.id) && !g.id.startsWith('pg-'),
  )
  if (q) list = list.filter((g) =>
    g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q),
  )
  return list
})

let candidatesSearchTimer: ReturnType<typeof setTimeout> | null = null
watch(addSearch, () => {
  if (candidatesSearchTimer) clearTimeout(candidatesSearchTimer)
  candidatesSearchTimer = setTimeout(() => {
    void loadCandidates()
  }, 300)
})

function onAddDocClick(e: MouseEvent) {
  if (!addOpen.value || !addRootEl.value) return
  if (!addRootEl.value.contains(e.target as Node)) closeAdd()
}
function onAddKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && addOpen.value) {
    e.preventDefault()
    closeAdd()
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onAddDocClick)
  document.addEventListener('keydown', onAddKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onAddDocClick)
  document.removeEventListener('keydown', onAddKey)
  if (candidatesSearchTimer) clearTimeout(candidatesSearchTimer)
})

async function addUserDirect(userId: string) {
  if (addBusy.value) return
  addBusy.value = true
  try {
    await api.spaces.permissions.upsertUser(props.spaceId, userId, 'viewer')
    uiStore.notify('已添加成员(默认只读)', 'info')
    closeAdd()
    await load()
  } catch (e) {
    uiStore.notify(e instanceof ApiError ? humanizeApiError(e) : '添加失败', 'error')
  } finally {
    addBusy.value = false
  }
}
async function addGroupDirect(groupId: string) {
  if (addBusy.value) return
  addBusy.value = true
  try {
    await api.spaces.permissions.upsertGroup(props.spaceId, groupId, 'viewer')
    uiStore.notify('已添加用户组(默认只读)', 'info')
    closeAdd()
    await load()
  } catch (e) {
    uiStore.notify(e instanceof ApiError ? humanizeApiError(e) : '添加失败', 'error')
  } finally {
    addBusy.value = false
  }
}
</script>

<template>
  <section class="smt-card">
    <div class="smt-header">
      <div class="smt-title-wrap">
        <h2 class="smt-title">成员</h2>
        <span class="smt-count">{{ members.length }} 人</span>
      </div>
      <div class="smt-header-actions">
        <div ref="addRootEl" class="smt-add-wrap">
          <button
            type="button"
            class="btn ghost smt-add-btn"
            :disabled="addOpen !== null"
            @click="openAdd('user')"
          >
            <span class="material-symbols-outlined">person_add</span>
            <span>添加成员</span>
          </button>
          <button
            type="button"
            class="btn ghost smt-add-btn"
            :disabled="addOpen !== null"
            @click="openAdd('group')"
          >
            <span class="material-symbols-outlined">workspaces</span>
            <span>添加用户组</span>
          </button>
          <div v-if="addOpen !== null" class="smt-add-popover">
            <div class="smt-add-head">
              <span class="material-symbols-outlined">
                {{ addOpen === 'user' ? 'person_add' : 'workspaces' }}
              </span>
              <span class="smt-add-title">
                {{ addOpen === 'user' ? '添加成员(默认只读)' : '添加用户组(默认只读)' }}
              </span>
            </div>
            <div class="smt-add-search">
              <span class="material-symbols-outlined smt-search-icon">search</span>
              <input
                v-model="addSearch"
                type="text"
                class="smt-search-input"
                :placeholder="addOpen === 'user' ? '按姓名或邮箱搜索' : '按组名或描述搜索'"
                :disabled="candidatesLoading"
              />
            </div>
            <div class="smt-add-scroll">
              <template v-if="addOpen === 'user'">
                <div v-if="candidatesLoading" class="smt-add-loading">加载候选中…</div>
                <div v-else-if="filteredUserCandidates.length === 0" class="smt-add-empty">
                  没有可添加的成员
                </div>
                <button
                  v-for="u in filteredUserCandidates.slice(0, 30)"
                  v-else
                  :key="u.id"
                  type="button"
                  class="smt-add-candidate"
                  :disabled="addBusy"
                  @click="addUserDirect(u.id)"
                >
                  <span class="smt-row-avatar" :style="{ background: u.color }">
                    {{ (u.name || '?').slice(0, 2) }}
                  </span>
                  <div class="smt-add-text">
                    <div class="smt-add-name">{{ u.name }}</div>
                    <div class="smt-add-desc">{{ u.email }}</div>
                  </div>
                  <span class="smt-add-cta">添加</span>
                </button>
              </template>
              <template v-else>
                <div v-if="candidatesLoading" class="smt-add-loading">加载候选中…</div>
                <div v-else-if="filteredGroupCandidates.length === 0" class="smt-add-empty">
                  没有可添加的用户组
                </div>
                <button
                  v-for="g in filteredGroupCandidates.slice(0, 30)"
                  v-else
                  :key="g.id"
                  type="button"
                  class="smt-add-candidate"
                  :disabled="addBusy"
                  @click="addGroupDirect(g.id)"
                >
                  <span class="material-symbols-outlined smt-add-icon">workspaces</span>
                  <div class="smt-add-text">
                    <div class="smt-add-name">{{ g.name }}</div>
                    <div v-if="g.description" class="smt-add-desc">{{ g.description }}</div>
                  </div>
                  <span class="smt-add-cta">添加</span>
                </button>
              </template>
            </div>
            <div class="smt-add-foot">
              <span class="smt-add-foot-hint">
                新成员先以「只读」加入,要去「授权」tab 调整更高权限。
              </span>
              <button type="button" class="btn ghost" @click="closeAdd">完成</button>
            </div>
          </div>
        </div>
        <div class="smt-search">
          <span class="material-symbols-outlined smt-search-icon">search</span>
          <input
            v-model="search"
            type="text"
            class="smt-search-input"
            placeholder="按姓名或邮箱搜索"
            :disabled="loading"
          />
        </div>
      </div>
    </div>
    <p class="smt-hint">
      显示当前空间的所有成员,以及每个人是怎么拿到访问权的(直接授权 / 通过某个组)。
      一个人有多条来源时,按权限最大的那一条生效(管理 &gt; 编辑 &gt; 只读),
      打勾的来源就是当前生效的那条。写操作请到「授权」tab。
    </p>

    <div v-if="loadError" class="smt-error">
      <p>{{ loadError }}</p>
      <button type="button" class="btn ghost" @click="load">重试</button>
    </div>

    <div v-else-if="loading && members.length === 0" class="smt-skeleton">
      <div v-for="i in 5" :key="i" class="smt-skel-row">
        <div class="smt-skel-avatar" />
        <div class="smt-skel-text">
          <div class="smt-skel-name" />
          <div class="smt-skel-email" />
        </div>
        <div class="smt-skel-role" />
        <div class="smt-skel-source" />
        <div class="smt-skel-action" />
      </div>
    </div>

    <ul v-else-if="filteredMembers.length > 0" class="smt-list">
      <li class="smt-list-header">
        <span class="smt-list-header-label smt-list-header-member">成员</span>
        <span class="smt-list-header-label">空间角色</span>
        <span class="smt-list-header-label">授权来源</span>
        <span class="smt-list-header-label">操作</span>
      </li>
      <li
        v-for="m in filteredMembers"
        :key="m.userId"
        class="smt-row"
      >
        <UserAvatar
          :size="32"
          :label="m.user.name"
          :color="m.user.color"
          :avatar-kind="m.user.avatarKind ?? null"
          :avatar-ref="m.user.avatarRef ?? null"
          :user-id="m.userId"
        />
        <div class="smt-row-text">
          <div class="smt-row-name">
            {{ m.user.name }}
            <span
              v-if="m.user.status === 'disabled'"
              class="smt-status-chip smt-status-disabled"
              title="该用户已被禁用,授权仍生效但无法登录"
            >已禁用</span>
            <span
              v-else-if="m.user.status === 'anonymized'"
              class="smt-status-chip smt-status-anonymized"
              title="该用户已被匿名化,身份不可恢复"
            >已注销</span>
            <span
              v-else-if="m.user.status === 'must_reset_password'"
              class="smt-status-chip smt-status-pending"
              title="该用户尚未完成首次重置密码"
            >待激活</span>
          </div>
          <div v-if="m.user.email" class="smt-row-email">{{ m.user.email }}</div>
        </div>
        <div class="smt-role-cell">
          <span
            class="smt-role-value"
            :class="`smt-role-${m.effectiveRole}`"
          >
            <span class="material-symbols-outlined smt-role-icon">
              {{ ROLE_INFO[m.effectiveRole].icon }}
            </span>
            <span>{{ ROLE_INFO[m.effectiveRole].label }}</span>
          </span>
        </div>
        <div class="smt-sources">
          <template v-for="(s, i) in m.sources" :key="i">
            <button
              type="button"
              class="smt-source"
              :class="[
                `smt-source-${s.kind}`,
                isWinningSource(m, i) ? 'smt-source-winning' : '',
                !isWinningSource(m, i) && s.role !== m.effectiveRole ? 'smt-source-overridden' : '',
              ]"
              :title="sourceTitle(m, s, i)"
              @click="goHighlightGrant(s, m.userId)"
            >
              <span
                v-if="isWinningSource(m, i)"
                class="material-symbols-outlined smt-source-check"
                aria-hidden="true"
              >check</span>
              <span v-else class="material-symbols-outlined smt-source-icon">
                {{ s.kind === 'direct' ? 'person' : 'workspaces' }}
              </span>
              <span class="smt-source-label">
                {{ s.kind === 'direct' ? '直接' : (s.groupName ?? s.groupId) }}
              </span>
              <span class="smt-source-role">{{ ROLE_INFO[s.role].label }}</span>
            </button>
          </template>
          <!-- 只在真的有「被覆盖」来源时出现 —— 单来源的行不需要解释合并规则 -->
          <span
            v-if="hasOverriddenSource(m)"
            class="smt-source-note"
            title="多条来源取权限最大的那一条生效(管理 > 编辑 > 只读),打勾的是当前生效的来源"
          >取最大权限生效</span>
        </div>
        <button
          type="button"
          class="smt-adjust"
          :title="adjustTitle(m)"
          @click="goHighlightGrant(m.sources[0]!, m.userId)"
        >
          {{ adjustLabel(m) }}
          <span class="material-symbols-outlined">arrow_forward</span>
        </button>
      </li>
    </ul>

    <div v-else-if="searchDebounced.trim()" class="smt-empty">
      没有匹配「{{ searchDebounced }}」的成员
    </div>
    <div v-else class="smt-empty">
      <p class="smt-empty-text">还没有任何成员 — 先加几个成员或用户组:</p>
      <div class="smt-empty-actions">
        <button type="button" class="btn ghost" @click="openAdd('user')">
          <span class="material-symbols-outlined">person_add</span>
          <span>添加成员</span>
        </button>
        <button type="button" class="btn ghost" @click="openAdd('group')">
          <span class="material-symbols-outlined">workspaces</span>
          <span>添加用户组</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.smt-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 16px 20px 20px;
}

.smt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 4px;
}

.smt-title-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.smt-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}

.smt-count {
  font-size: 12px;
  color: var(--text-3);
  font-weight: 500;
}

.smt-search {
  position: relative;
  width: 260px;
  flex-shrink: 0;
}

.smt-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.smt-add-wrap { position: relative; display: inline-flex; gap: 6px; }

.smt-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  padding: 0 12px;
  height: 32px;
  font-family: inherit;
}
.smt-add-btn .material-symbols-outlined { font-size: 16px; }

.smt-add-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 360px;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-sm, 0 2px 12px rgba(0, 0, 0, 0.08));
  z-index: 20;
}

.smt-add-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 6px;
  border-bottom: 1px solid var(--border);
}
.smt-add-head .material-symbols-outlined { font-size: 18px; color: var(--accent); }
.smt-add-title { font-size: 13px; font-weight: 600; color: var(--text-1); }

.smt-add-search { padding: 8px 12px 4px; }

.smt-add-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 8px;
  max-height: 320px;
}

.smt-add-loading,
.smt-add-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}

.smt-add-candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.smt-add-candidate:hover { background: var(--bg-canvas); }
.smt-add-candidate:disabled { cursor: progress; opacity: 0.6; }

.smt-add-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; }
.smt-row-avatar {
  width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; font-size: 11px; text-transform: uppercase;
}
.smt-add-text { min-width: 0; flex: 1; }
.smt-add-name { font-size: 13px; font-weight: 500; color: var(--text-1); }
.smt-add-desc { font-size: 12px; color: var(--text-3); margin-top: 1px; }
.smt-add-cta {
  font-size: 12px;
  font-weight: 500;
  color: var(--accent);
  flex-shrink: 0;
}

.smt-add-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-canvas);
}
.smt-add-foot-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
}

.smt-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 18px;
  color: var(--text-3);
  pointer-events: none;
}

.smt-search-input {
  width: 100%;
  height: 32px;
  padding: 0 10px 0 34px;
  font-size: 13px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: var(--bg-canvas);
  border: 1px solid transparent;
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: background var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
  box-sizing: border-box;
}

.smt-search-input:focus {
  background: var(--bg);
  border-color: var(--accent);
}

.smt-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 8px 0 16px;
  line-height: 1.5;
}

/* ─── list ─── */
.smt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  max-height: 560px;
  overflow-y: auto;
}

.smt-list-header,
.smt-row {
  display: grid;
  grid-template-columns: 32px minmax(140px, 220px) 92px minmax(160px, 240px) 120px;
  align-items: center;
  column-gap: 16px;
}

.smt-list-header {
  padding: 8px 12px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
}

.smt-list-header-label {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-3);
  white-space: nowrap;
}

.smt-list-header-member { grid-column: 1 / 3; }

.smt-row {
  min-height: 52px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  transition: background var(--duration-fast) var(--ease-out);
}

.smt-row:last-child { border-bottom: 0; }

.smt-row:hover { background: var(--bg-canvas); }

.smt-row-text { min-width: 0; }

.smt-row-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.smt-row-email {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── 状态 chip(参考 SpaceEditView 的 se-status-chip)── */
.smt-status-chip {
  display: inline-block;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  border-radius: var(--radius-pill, 999px);
}

.smt-status-disabled {
  background: var(--bg-canvas);
  color: var(--text-3);
  border: 1px solid var(--border);
}

.smt-status-anonymized {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  border: 1px solid color-mix(in srgb, var(--danger) 24%, transparent);
}

.smt-status-pending {
  background: var(--accent-softer, #F4F8FF);
  color: var(--accent-hover, #0747A6);
  border: 1px solid var(--accent-soft, #DEEBFF);
}

/* ─── 角色 + 来源列 ─── */
.smt-role-cell {
  display: flex;
  align-items: center;
  min-width: 0;
}

.smt-role-value {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.smt-role-admin { color: var(--accent); }
.smt-role-editor { color: var(--text-2); }
.smt-role-viewer { color: var(--text-3); }

.smt-role-icon {
  font-size: 14px;
  line-height: 1;
}

.smt-sources {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.smt-source {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 180px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill, 999px);
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: background var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}

.smt-source:hover {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
  color: var(--accent);
}

.smt-source-icon {
  font-size: 12px;
  line-height: 1;
  flex-shrink: 0;
}

.smt-source-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.smt-source-group {
  color: var(--text-2);
  background: var(--bg-canvas);
  border-color: transparent;
}

/* P2:MAX-rank 合并的赢家 —— accent 描边 + ✓,让「哪条在生效」一眼可见。
   不用填充色块,避免跟 grants tab 的可点 chip 混淆(这里仍是只读视图)。 */
.smt-source-winning {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  font-weight: 600;
}

/* 被更高 rank 覆盖的来源 —— 降到次要层级(不删,管理员仍需知道它存在)。 */
.smt-source-overridden {
  color: var(--text-3);
  background: var(--bg-canvas);
  border-color: transparent;
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--text-3) 60%, transparent);
}
.smt-source-overridden:hover {
  text-decoration: none;
}

.smt-source-check {
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}

/* 每条来源自己的角色 —— 有了它管理员才能看出「直接是只读、组给了编辑」。 */
.smt-source-role {
  flex-shrink: 0;
  padding-left: 5px;
  margin-left: 1px;
  border-left: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  font-weight: 500;
  opacity: 0.85;
}

.smt-source-note {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  cursor: help;
}

/* ─── 「调整授权」button ─── */
.smt-adjust {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 4px;
  min-height: 28px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--accent);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--duration-fast) var(--ease-out);
}

.smt-adjust:hover {
  background: var(--accent-soft);
}

.smt-adjust .material-symbols-outlined {
  font-size: 14px;
  line-height: 1;
}

/* ─── empty / error / skeleton ─── */
.smt-empty {
  padding: 28px 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md, 4px);
}
.smt-empty-text { margin: 0 0 12px 0; }
.smt-empty-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}
.smt-empty-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  font-family: inherit;
  font-size: 13px;
}
.smt-empty-actions .material-symbols-outlined { font-size: 16px; }

.smt-error {
  padding: 24px;
  text-align: center;
  color: var(--danger);
  font-size: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
}

.smt-error .btn { margin-top: 12px; display: inline-flex; }

.smt-skeleton {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  overflow: hidden;
}

.smt-skel-row {
  display: grid;
  grid-template-columns: 32px minmax(140px, 220px) 92px minmax(160px, 240px) 120px;
  align-items: center;
  column-gap: 16px;
  padding: 10px 12px;
  background: var(--bg);
}

.smt-skel-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-canvas);
}

.smt-skel-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.smt-skel-name {
  height: 14px;
  width: 40%;
  background: var(--bg-canvas);
  border-radius: 3px;
}

.smt-skel-email {
  height: 10px;
  width: 30%;
  background: var(--bg-canvas);
  border-radius: 3px;
}

.smt-skel-role,
.smt-skel-source,
.smt-skel-action {
  height: 22px;
  background: var(--bg-canvas);
  border-radius: var(--radius-sm, 3px);
}

.smt-skel-role { width: 66px; }
.smt-skel-source { width: 104px; }
.smt-skel-action { width: 56px; }
</style>
