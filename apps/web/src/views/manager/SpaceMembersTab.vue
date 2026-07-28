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
import UserAvatar from '@/components/ui/UserAvatar.vue'
import type { SpaceMember, SpaceMemberSource, SpaceRole } from '@power-wiki/shared'

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

/* ─── 复制 userId 调试(开发用,production no-op) ───────────── */
function copyUserId(userId: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(userId)
    uiStore.notify('已复制 userId', 'info')
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
    <p class="smt-hint">
      显示当前空间的所有成员,以及每个人是怎么拿到访问权的(直接授权 / 通过某个组)。
      写操作请到「授权」tab。
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
              :class="[`smt-source-${s.kind}`]"
              :title="s.kind === 'direct' ? '直接授权 — 在授权 tab 修改' : `通过组「${s.groupName ?? s.groupId}」授权 — 在授权 tab 改组授权`"
              @click="goHighlightGrant(s, m.userId)"
            >
              <span class="material-symbols-outlined smt-source-icon">
                {{ s.kind === 'direct' ? 'person' : 'workspaces' }}
              </span>
              <span class="smt-source-label">
                {{ s.kind === 'direct' ? '直接' : (s.groupName ?? s.groupId) }}
              </span>
            </button>
          </template>
        </div>
        <button
          type="button"
          class="smt-adjust"
          :title="`跳到授权 tab 调整「${m.user.name}」的授权`"
          @click="goHighlightGrant(m.sources[0]!, m.userId)"
        >
          调整
          <span class="material-symbols-outlined">arrow_forward</span>
        </button>
      </li>
    </ul>

    <div v-else-if="searchDebounced.trim()" class="smt-empty">
      没有匹配「{{ searchDebounced }}」的成员
    </div>
    <div v-else class="smt-empty">
      还没有任何成员 — 去授权 tab 添加用户或用户组
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
  grid-template-columns: 32px minmax(0, 1fr) 92px minmax(180px, 280px) 72px;
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
  padding: 32px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md, 4px);
}

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
  grid-template-columns: 32px minmax(0, 1fr) 92px minmax(180px, 280px) 72px;
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
