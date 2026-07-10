<script setup lang="ts">
/**
 * ActivityView — P1-3 workspace-wide 活动流路由 (/activity)。
 *
 * 设计原则:
 *   - 跟 HomeView / HistoryView 同款三列布局(Sidebar + 主内容 + 右侧 toc / filter)
 *     但 ActivityView 内容区只有一张列表,没有 toc;右侧用空列占位,保持
 *     视觉对齐。
 *   - filter 默认是当前 active space,但允许 "all spaces" 一档 — admin 看全库
 *     平时主要想看「我这空间最近发生了什么」,但偶尔要 audit 别人的空间。
 *   - 单行 click → 跳到对应 page;actor 头像 + 颜色 + name 一起渲染,
 *     跟 NotificationBell 的 actor 渲染复用 UserAvatar。
 *   - "刚刚 / X 分钟前 / X 小时前 / X 天前" 时间标签 — 复用 lib/relativeTime
 *     (HomeView 已用)。
 *
 * 数据:
 *   - useRecentActivity 拉一次 + manual 刷新。路由进入时 onMounted 拉,
 *     space filter 变化时重拉,刷新按钮重拉。
 *   - 不持久化 — 关页面就丢,下次打开再拉。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useRecentActivity } from '@/composables/useRecentActivity'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { formatRelativeTime } from '@/lib/relativeTime'
import type { ActivityEvent, Space } from '@power-wiki/shared'

const router = useRouter()
const route = useRoute()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const { state, load, loadMore } = useRecentActivity()
useDocumentTitle(() => '活动流')

/** 「所有空间」哨兵值。filter dropdown 用。 */
const ALL_SPACES = '__all__'

const selectedSpace = ref<string>(ALL_SPACES)

const accessibleSpaces = computed<Space[]>(() => {
  // 用户可见的所有空间。admin 已经能看全库,但 dropdown 仍按用户视角列 —
  // 选 all = 后端无 space 参数 = 后端自己按 admin/可见 过滤。
  return spacesStore.spaces.value
})

/**
 * 当前 filter 的展示 label。all = "所有空间",否则用 space 名字。
 */
const filterLabel = computed(() => {
  if (selectedSpace.value === ALL_SPACES) return '所有空间'
  const s = accessibleSpaces.value.find((x) => x.id === selectedSpace.value)
  return s?.name ?? '(未知空间)'
})

/**
 * 重置到第一页 + 拉数据。单一 source of truth — onMounted / watch(route)
 * / 刷新按钮 / filter 切换都走这里,避免「某条路径漏 load」导致 feed
 * 卡在旧数据。filter 总是回到 active space(用户切走又回来不该卡旧值)。
 */
async function reloadFromTop(): Promise<void> {
  if (!spacesStore.loaded.value) await spacesStore.init()
  const active = spacesStore.activeSpaceId.value
  selectedSpace.value = active ?? ALL_SPACES
  await load(selectedSpace.value === ALL_SPACES ? null : selectedSpace.value)
}

/**
 * 路由进入触发 reload。
 *  - onMounted:首次 mount 必走(Vue 路由的默认行为 — 组件 unmount → remount)
 *  - watch(route.fullPath):同一组件复用(目前没用 keep-alive,但作为兜底
 *    防 keep-alive 哪天开起来时「导航回来不刷新」)
 * 二者都调 reloadFromTop,幂等:后端永远给最新数据。
 */
onMounted(() => { void reloadFromTop() })
watch(() => route.fullPath, () => { void reloadFromTop() })

watch(selectedSpace, async (v) => {
  await load(v === ALL_SPACES ? null : v)
})

async function refresh(): Promise<void> {
  await load(selectedSpace.value === ALL_SPACES ? null : selectedSpace.value)
}

function openPage(ev: ActivityEvent): void {
  // 切到事件所在空间再跳转 — 让侧栏自动展开到那条子树(参考 Sidebar 的
  // autoExpandAndLocate)。如果用户已经在那个空间,setActiveSpace 是 no-op。
  const sid = ev.spaceId
  if (sid && spacesStore.activeSpaceId.value !== sid) {
    spacesStore.setActiveSpace(sid)
  }
  void router.push(`/p/${ev.pageId}`)
}

/**
 * Hover 时 lazy-load event 对应的 page,让 Sidebar 自动展开到该子树。
 *
 * 短路三种 case,避免无效 / 反复的 GET /api/pages/:id:
 *   1. trashed / purged — 这两类 page 在 Sidebar 永远不展示(已删的 page
 *      不渲染),load 进来展开无意义,且服务端 100% 404(trashed: deletedAt
 *      IS NOT NULL 过滤; purged: page row 已 hard-delete)。
 *   2. 已经在 store 里。
 *   3. 之前 lazy-load 失败过(404 / 403)— 记到 deadPageIds Set 跳过。
 */
const deadPageIds = new Set<string>()

function ensurePageLoaded(ev: ActivityEvent): void {
  if (ev.kind === 'trashed' || ev.kind === 'purged') return
  if (pagesStore.getPage(ev.pageId)) return
  if (deadPageIds.has(ev.pageId)) return
  void pagesStore.ensureAncestorsLoaded(ev.pageId).then(() => {
    // ensureAncestorsLoaded 内部 try/catch 静默吞 404;事后看 store 仍
    // 没有这个 page = 拉不到,记进 Set 防再打。
    if (!pagesStore.getPage(ev.pageId)) deadPageIds.add(ev.pageId)
  })
}

/**
 * 事件类型 → 色块 chip 映射。每种 kind 一种背景色 + 中文 label。
 * 不再用 kind-icon — 跟操作按钮的 Material Symbols 同款容易让人误以为
 * 可点。改 chip 视觉上是「事件标签」,跟操作按钮拉开。
 * 同步后端 `apps/api/src/lib/pageEvents.ts` 的 PageEventKind enum。
 */
const chipMap: Record<ActivityEvent['kind'], { label: string; color: string }> = {
  created:    { label: '创建',       color: 'kind-created' },
  edited:     { label: '编辑',       color: 'kind-edited' },
  moved:      { label: '移动',       color: 'kind-moved' },
  restored:   { label: '恢复',       color: 'kind-restored' },
  duplicated: { label: '复制',       color: 'kind-duplicated' },
  published:  { label: '发布',       color: 'kind-published' },
  trashed:    { label: '删除',       color: 'kind-trashed' },
  purged:     { label: '永久删除',   color: 'kind-purged' },
}
function chipLabel(kind: ActivityEvent['kind']): string {
  return chipMap[kind]?.label ?? '编辑'
}
function chipColor(kind: ActivityEvent['kind']): string {
  return chipMap[kind]?.color ?? 'kind-edited'
}
</script>

<template>
  <div class="activity-layout">
    <Sidebar />
    <main class="activity-main">
      <header class="activity-header">
        <div class="title-block">
          <h1 class="title">最近页面活动</h1>
          <p class="subtitle">
            Workspace-wide 最近 50 条 page 活动事件,涵盖编辑/创建/复制/移动/恢复/发布。按发生时间倒序,点击进入对应页。
          </p>
        </div>
        <div class="controls">
          <label class="filter-select">
            <span>空间</span>
            <select v-model="selectedSpace">
              <option :value="ALL_SPACES">所有空间</option>
              <option v-for="s in accessibleSpaces" :key="s.id" :value="s.id">
                {{ s.name }}
              </option>
            </select>
          </label>
          <button
            class="refresh-btn"
            type="button"
            :disabled="state.loading"
            @click="refresh"
          >
            <span
              class="material-symbols-outlined icon-md"
              :class="{ 'is-loading': state.loading }"
            >refresh</span>
            刷新
          </button>
        </div>
      </header>

      <div v-if="state.loading && state.items.length === 0" class="activity-list">
        <div v-for="i in 8" :key="i" class="row-skeleton">
          <Skeleton circle :width="32" :height="32" />
          <div class="row-skeleton-text">
            <Skeleton :width="`${50 + (i * 7) % 30}%`" :height="14" />
            <Skeleton :width="`${30 + (i * 5) % 20}%`" :height="11" />
          </div>
        </div>
      </div>

      <div
        v-else-if="state.error"
        class="activity-error"
        role="alert"
      >
        <span class="material-symbols-outlined">error</span>
        <span>{{ state.error }}</span>
        <button class="link-btn" type="button" @click="refresh">重试</button>
      </div>

      <EmptyState
        v-else-if="state.items.length === 0"
        class="activity-empty"
        variant="no-data"
        icon="timeline"
        title="还没有活动"
        :hint="`${filterLabel} 下暂无编辑记录 — 创建或修改一页后会出现在这里。`"
      />

      <ul v-else class="activity-list">
        <li
          v-for="(ev, idx) in state.items"
          :key="`${ev.pageId}-${idx}`"
          class="activity-row"
          tabindex="0"
          role="button"
          @click="openPage(ev)"
          @keydown.enter="openPage(ev)"
          @mouseenter="ensurePageLoaded(ev)"
        >
          <UserAvatar
            :size="32"
            :label="ev.actorName ?? ev.actorId"
            :color="ev.actorColor ?? undefined"
          />
          <div class="row-body">
            <div class="row-line-1">
              <span class="actor-name">{{ ev.actorName ?? '(已删除用户)' }}</span>
              <span
                class="kind-chip"
                :class="chipColor(ev.kind)"
                :title="chipLabel(ev.kind)"
              >{{ chipLabel(ev.kind) }}</span>
              <span class="ev-page-title">{{ ev.pageTitle || '(无标题)' }}</span>
            </div>
            <div class="row-line-2">
              <span
                class="space-chip"
                :style="{ background: ev.spaceColor }"
                :title="`${ev.spaceName} (${ev.spaceKind === 'personal' ? '个人空间' : '团队空间'})`"
              >
                {{ ev.spaceName }}
              </span>
              <span class="time">{{ formatRelativeTime(ev.updatedAt) }}</span>
            </div>
          </div>
          <span class="row-arrow material-symbols-outlined">chevron_right</span>
        </li>
      </ul>

      <div v-if="state.items.length > 0" class="load-more-row">
        <button
          v-if="state.hasMore"
          type="button"
          class="load-more-btn"
          :disabled="state.loadingMore"
          @click="loadMore"
        >
          <span
            class="material-symbols-outlined icon-md"
            :class="{ 'is-loading': state.loadingMore }"
          >expand_more</span>
          {{ state.loadingMore ? '加载中…' : '加载更多' }}
        </button>
        <span v-else class="end-hint">已经到底了</span>
      </div>
    </main>
  </div>
</template>

<style scoped>
.activity-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  min-height: 100vh;
}
.activity-main {
  padding: 24px 32px 48px;
  overflow-y: auto;
}
.activity-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border, #dfe1e6);
}
.title-block { flex: 1; min-width: 0; }
.title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1, #172b4d);
  margin: 0 0 4px;
}
.subtitle {
  font-size: 13px;
  color: var(--text-3, #6b778c);
  margin: 0;
  max-width: 640px;
}
.controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.filter-select {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2, #42526e);
}
.filter-select select {
  height: 30px;
  padding: 0 24px 0 8px;
  font-family: inherit;
  font-size: 13px;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: var(--radius, 4px);
  background: var(--bg, #ffffff);
  color: var(--text-1, #172b4d);
  cursor: pointer;
}
.filter-select select:hover { border-color: var(--border-strong, #c1c7d0); }
.filter-select select:focus {
  outline: none;
  border-color: var(--focus-ring, #4c9aff);
}
.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: var(--radius, 4px);
  background: var(--bg, #ffffff);
  color: var(--text-1, #172b4d);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.refresh-btn:hover:not(:disabled) {
  border-color: var(--border-strong, #c1c7d0);
  background: var(--bg-subtle, #f4f5f7);
}
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.is-loading { animation: spin 0.9s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.activity-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}
.activity-row {
  display: grid;
  grid-template-columns: 32px 1fr 20px;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  border-bottom: 1px solid var(--border, #ebecf0);
  cursor: pointer;
  transition: background var(--duration-fast);
}
.activity-row:hover { background: var(--bg-subtle, #f4f5f7); }
.activity-row:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: -2px;
  border-radius: var(--radius-sm, 3px);
}
.row-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.row-line-1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 14px;
  color: var(--text-1, #172b4d);
}
.actor-name {
  font-weight: 600;
  color: var(--text-1, #172b4d);
}
.kind-chip {
  display: inline-block;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: 0.2px;
  flex-shrink: 0;
  white-space: nowrap;
}
.kind-chip.kind-created    { background: #36B37E; }
.kind-chip.kind-edited     { background: #6B778C; }
.kind-chip.kind-moved      { background: #4C9AFF; }
.kind-chip.kind-restored   { background: #FFAB00; }
.kind-chip.kind-duplicated { background: #6554C0; }
.kind-chip.kind-published  { background: #00B8D9; }
.kind-chip.kind-trashed    { background: #FF5630; }
.kind-chip.kind-purged     { background: #DE350B; }
.ev-page-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1, #172b4d);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 480px;
}
.row-line-2 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-3, #6b778c);
}
.space-chip {
  display: inline-block;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  color: white;
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: 0.2px;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  max-width: 160px;
}
.time { color: var(--text-3, #6b778c); font-variant-numeric: tabular-nums; }
.row-arrow {
  color: var(--text-3, #6b778c);
  font-size: 18px;
}
.activity-row:hover .row-arrow { color: var(--accent, #0052cc); }

.load-more-row {
  display: flex;
  justify-content: center;
  padding: 16px 0 4px;
}
.load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 16px;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: var(--radius, 4px);
  background: var(--bg, #ffffff);
  color: var(--text-1, #172b4d);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.load-more-btn:hover:not(:disabled) {
  border-color: var(--border-strong, #c1c7d0);
  background: var(--bg-subtle, #f4f5f7);
}
.load-more-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.end-hint {
  font-size: 12px;
  color: var(--text-3, #6b778c);
  padding: 8px 0;
}

.row-skeleton {
  display: grid;
  grid-template-columns: 32px 1fr;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  border-bottom: 1px solid var(--border, #ebecf0);
}
.row-skeleton-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.activity-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-top: 16px;
  background: var(--error-soft, #ffebe6);
  border: 1px solid var(--error, #de350b);
  border-radius: var(--radius, 4px);
  color: var(--error, #de350b);
  font-size: 14px;
}
.link-btn {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: var(--accent, #0052cc);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  text-decoration: underline;
}

.activity-empty {
  margin-top: 32px;
}
</style>