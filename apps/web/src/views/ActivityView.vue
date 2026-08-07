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
import type { BreadcrumbItem } from '@/components/ui/Breadcrumb.vue'
import { useSpaceBreadcrumbSegment } from '@/composables/useSpaceBreadcrumbSegment'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import PageActions from '@/components/ui/PageActions.vue'
import { useRecentActivity, type ActivityFilters } from '@/composables/useRecentActivity'
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

// [P0-1] 面包屑首段改用 active space 名字 + kind icon。ActivityView
// 是全空间活动流,active space 语义不强;但跟 ReadView/EditView 走
// 同一份事实来源,统一观感。active 没 hydrate 时回退「我的知识库」
// 静态文案(老字符串,避免 chain 头空白)
const spaceSegment = useSpaceBreadcrumbSegment()
const breadcrumbSegments = computed(() => {
  const sp = spaceSegment.value
  const head: BreadcrumbItem[] = sp ? [sp] : [{ label: '我的知识库', to: '/' }]
  return [...head, { label: '最近页面活动' }]
})

/** 「所有空间」哨兵值。filter dropdown 用。 */
const ALL_SPACES = '__all__'

const selectedSpace = ref<string>(ALL_SPACES)
const selectedKinds = ref<ActivityEvent['kind'][]>([])
const selectedTime = ref<'all' | 'today' | 'week' | 'month'>('all')
const selectedActor = ref<'all' | 'me'>('all')

const kindOptions: Array<{ value: ActivityEvent['kind']; label: string }> = [
  { value: 'created', label: '创建' },
  { value: 'edited', label: '编辑' },
  { value: 'moved', label: '移动' },
  { value: 'restored', label: '恢复' },
  { value: 'duplicated', label: '复制' },
  { value: 'published', label: '发布' },
  { value: 'trashed', label: '删除' },
  { value: 'purged', label: '永久删除' },
]

function sinceForTime(): number | undefined {
  if (selectedTime.value === 'all') return undefined
  const now = new Date()
  if (selectedTime.value === 'today') {
    now.setHours(0, 0, 0, 0)
  } else if (selectedTime.value === 'week') {
    const day = now.getDay() || 7
    now.setDate(now.getDate() - day + 1)
    now.setHours(0, 0, 0, 0)
  } else {
    now.setDate(1)
    now.setHours(0, 0, 0, 0)
  }
  return now.getTime()
}

function activityFilters(): ActivityFilters {
  return {
    kinds: selectedKinds.value.length > 0 ? [...selectedKinds.value] : undefined,
    since: sinceForTime(),
    actor: selectedActor.value === 'me' ? 'me' : undefined,
  }
}

const activeFilterCount = computed(() =>
  selectedKinds.value.length + (selectedTime.value === 'all' ? 0 : 1) + (selectedActor.value === 'all' ? 0 : 1),
)


const accessibleSpaces = computed<Space[]>(() => {
  // 用户可见的所有空间。admin 已经能看全库,但 dropdown 仍按用户视角列 —
  // 选 all = 后端无 space 参数 = 后端自己按 admin/可见 过滤。
  return spacesStore.spaces.value
})

/**
 * 当前 filter 的展示 label。all = "所有空间",否则用 space 名字。
 */
const filterLabel = computed(() => {
  if (selectedSpace.value === ALL_SPACES) return '所有共享空间'
  const s = accessibleSpaces.value.find((x) => x.id === selectedSpace.value)
  return s?.name ?? '(未知空间)'
})

/**
 * 重置到第一页 + 拉数据。单一 source of truth — onMounted / watch(route)
 * / 刷新按钮 / filter 切换都走这里,避免「某条路径漏 load」导致 feed
 * filter 总是回到 active space(用户切走又回来不该卡旧值),并携带当前
 * 事件类型 / 时间段 / 操作人筛选。
 */
async function reloadFromTop(): Promise<void> {
  if (!spacesStore.loaded.value) await spacesStore.init()
  const active = spacesStore.activeSpaceId.value
  selectedSpace.value = active ?? ALL_SPACES
  await load(selectedSpace.value === ALL_SPACES ? null : selectedSpace.value, activityFilters())
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
  await load(v === ALL_SPACES ? null : v, activityFilters())
})

watch([selectedKinds, selectedTime, selectedActor], () => {
  void load(selectedSpace.value === ALL_SPACES ? null : selectedSpace.value, activityFilters())
}, { deep: true })

async function refresh(): Promise<void> {
  await load(selectedSpace.value === ALL_SPACES ? null : selectedSpace.value, activityFilters())
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
  <div class="activity-main">
    <Breadcrumb :segments="breadcrumbSegments" />
    <PageActions>
      <label class="filter-select">
        <span>空间</span>
        <select v-model="selectedSpace">
          <option :value="ALL_SPACES">所有共享空间</option>
          <option v-for="s in accessibleSpaces" :key="s.id" :value="s.id">
            {{ s.name }}
          </option>
        </select>
      </label>
      <details class="kind-filter">
        <summary>
          <span>事件类型</span>
          <span v-if="selectedKinds.length" class="kind-filter-summary-count">{{ selectedKinds.length }}</span>
        </summary>
        <div class="kind-filter-popover">
          <label v-for="kind in kindOptions" :key="kind.value">
            <input v-model="selectedKinds" type="checkbox" :value="kind.value" />
            <span>{{ kind.label }}</span>
          </label>
        </div>
      </details>
      <label class="filter-select">
        <span>时间</span>
        <select v-model="selectedTime">
          <option value="all">全部时间</option>
          <option value="today">今天</option>
          <option value="week">本周</option>
          <option value="month">本月</option>
        </select>
      </label>
      <label class="filter-select">
        <span>操作人</span>
        <select v-model="selectedActor">
          <option value="all">所有人</option>
          <option value="me">只看我</option>
        </select>
      </label>
      <span v-if="activeFilterCount" class="active-filter-count" role="status">
        <span class="material-symbols-outlined">filter_list</span>
        <span>已筛选 {{ activeFilterCount }} 项</span>
      </span>
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
    </PageActions>

    <div class="content-inner activity-page">
      <header class="activity-header">
        <div class="title-block">
          <h1 class="title">最近页面活动</h1>
          <p class="subtitle">
            编辑 / 创建 / 复制 / 移动 / 恢复 / 发布 / 删除事件,按时间倒序,每页 20 条。
          </p>
          <!-- P1-11 · 「仅团队空间」明示 —— 后端 activity SQL 已经过滤
               spaces.kind = 'shared',但用户看不到 filter 规则,经常误
               以为「某人改了 X 页但没出现 = 数据丢了」。这里给 inline
               微提示(不是 callout,callout 是 warn 语义,这里是常驻指
               引):accent-soft 圆点 + 短文案 + 一键跳转链接。跳转目标
               是 /me(PersonalHomeView)而非 /(SpaceHomeView)—— 用户看
               「个人草稿」三个字时心智模型是「自己的 dashboard」,而
               SpaceHomeView 是「当前 active team 空间首页」,路由错位
               会让用户点过去发现「还是团队空间」而误以为链接坏了。-->
          <p class="activity-scope-hint">
            <span class="scope-hint-dot" aria-hidden="true"></span>
            <span>
              仅显示团队空间;个人草稿请到
              <router-link to="/me" class="scope-hint-link">个人工作台</router-link>
              查看。
            </span>
          </p>
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
            :avatar-kind="ev.actorAvatarKind ?? null"
            :avatar-ref="ev.actorAvatarRef ?? null"
            :user-id="ev.actorId ?? null"
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
    </div>
  </div>
</template>

<style scoped>
.activity-main {
  min-height: 100%;
}
.activity-page {
  padding-top: 24px;
  padding-bottom: 64px;
  max-width: var(--content-max-wide);
}
.activity-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.title-block { flex: 1; min-width: 0; }
.title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1);
  margin: 0 0 8px;
}
.subtitle {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
  max-width: 720px;
  line-height: 1.6;
}
/* P1-11 · 活动范围明示 —— inline 微提示替代 callout。accent 主色圆
 * 点 + 紧贴上下文的短文案 + 一键跳转链接。视觉重量比 subtitle 还
 * 低,但颜色更清楚:accent 圆点告诉眼睛「这里有分类提示」,跳转链
 * 接提供「修复路径」。常驻在标题区,不占垂直空间(box height 18px)
 * 比旧 callout 省 ~30px 头部空间。*/
.activity-scope-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  padding: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.4;
}
.scope-hint-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.scope-hint-link {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.scope-hint-link:hover {
  border-bottom-color: var(--accent);
}
.controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.filter-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  font-size: 13px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: var(--radius, 4px);
  background: var(--bg);
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.filter-select:hover { border-color: var(--border-strong); background: var(--bg-subtle); }
.filter-select:focus-within {
  border-color: var(--focus-ring);
}
.filter-select select {
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--text-1);
  cursor: pointer;
  padding-right: 4px;
}
.filter-select > span { color: var(--text-3); font-size: 12px; }
/* 5.5 — multi-select event chips live in a compact native details popover. */
.kind-filter {
  position: relative;
  font-size: 13px;
  color: var(--text-2);
}
.kind-filter summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius, 4px);
  background: var(--bg);
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  list-style: none;
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.kind-filter summary:hover { border-color: var(--border-strong); background: var(--bg-subtle); }
.kind-filter summary::-webkit-details-marker { display: none; }
.kind-filter[open] summary { border-color: var(--focus-ring); background: var(--bg-subtle); }
/* 已选 count chip:小色块 + 数字,跟 summary 同高,让用户一眼看到「多选已生效」*/
.kind-filter-summary-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--bg);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
.kind-filter-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: var(--z-popover);
  display: grid;
  grid-template-columns: repeat(2, max-content);
  gap: 6px 14px;
  min-width: 220px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}
.kind-filter-popover label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  cursor: pointer;
}
.kind-filter-popover input { accent-color: var(--accent); }
.active-filter-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px 3px 8px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.active-filter-count .material-symbols-outlined {
  font-size: 14px !important;
  color: inherit;
  line-height: 1;
}
.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius, 4px);
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.refresh-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
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
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  position: relative;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
/* Hover affordance:浅灰背景 + 左侧 2px accent 竖线 —— 比单纯换 bg
 * 色更强,跟 sidebar row / page-tree row 的 hover 视觉对齐。*/
.activity-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: transparent;
  transition: background var(--duration-fast) var(--ease-out);
}
.activity-row:hover {
  background: var(--bg-subtle);
}
.activity-row:hover::before { background: var(--accent); }
.activity-row:focus-visible {
  outline: 2px solid var(--focus-ring);
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
  gap: 8px;
  font-size: 14px;
  color: var(--text-1);
}
.actor-name {
  font-weight: 600;
  color: var(--text-1);
  flex-shrink: 0;
}
.kind-chip {
  display: inline-block;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  color: var(--text-invert);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: 0.2px;
  flex-shrink: 0;
  white-space: nowrap;
}
.kind-chip.kind-created    { background: var(--success); }
.kind-chip.kind-edited     { background: var(--text-3); }
.kind-chip.kind-moved      { background: var(--activity-moved); }
.kind-chip.kind-restored   { background: var(--warning); }
.kind-chip.kind-duplicated { background: var(--activity-duplicated); }
.kind-chip.kind-published  { background: var(--activity-published); }
.kind-chip.kind-trashed    { background: var(--danger); }
.kind-chip.kind-purged     { background: var(--activity-purged); }
/* page-title 占满行 1 剩余空间 —— 之前 max-width: 480px + flex-wrap 让
 * 2K 视口下 row 右半边大片留白(只有 chevron),看起来「内容挤左、空间
 * 浪费」。flex: 1 + min-width: 0 让 ellipsis 在 title 自身宽度内发生,
 * 行 1 一路拉到 chevron 前才结束。*/
.ev-page-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-line-2 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-3);
}
/* time 右推到行尾 —— space-chip 紧贴 actor 一侧,time 走时间轴语义,
 * 「最近一次动作发生在 X」读起来更顺。margin-left: auto 利用 row-line-2
 * 的 flex 弹性把 time 顶到最右;space-chip 不再「漂在中间」。*/
.row-line-2 .time { margin-left: auto; }
.space-chip {
  display: inline-block;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  color: var(--text-invert);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: 0.2px;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  max-width: 160px;
}
.time {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 500;
}
.row-arrow {
  color: var(--text-3);
  font-size: 18px;
}
.activity-row:hover .row-arrow { color: var(--accent); }

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
  border: 1px solid var(--border);
  border-radius: var(--radius, 4px);
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.load-more-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
}
.load-more-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.end-hint {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 14px 0 4px;
  font-size: 12px;
  color: var(--text-3);
  font-weight: 500;
  letter-spacing: 0.04em;
}
.end-hint::before,
.end-hint::after {
  content: '';
  display: inline-block;
  width: 32px;
  height: 1px;
  background: var(--border);
}

.row-skeleton {
  display: grid;
  grid-template-columns: 32px 1fr;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  border-bottom: 1px solid var(--border);
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
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius, 4px);
  color: var(--danger);
  font-size: 14px;
}
.link-btn {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: var(--accent);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  text-decoration: underline;
}

.activity-empty {
  margin-top: 32px;
}
</style>