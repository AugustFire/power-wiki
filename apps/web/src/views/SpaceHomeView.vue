<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useRecentPages } from '@/composables/useRecentPages'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { newId } from '@/lib/id'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import StatCard from '@/components/space/StatCard.vue'
import DrillDownPanel from '@/components/space/DrillDownPanel.vue'
import EmptySpaceOnboarding from '@/components/space/EmptySpaceOnboarding.vue'
import { excerpt as makeExcerpt } from '@/lib/textMetrics'
import { formatRelativeTime } from '@/lib/relativeTime'
import { canCreateInSpace as canCreateInSpaceOf } from '@/lib/permissions'
import type { PageNode } from '@power-wiki/shared'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const uiStore = useUiStore()
const authStore = useAuthStore()
const { list: recentList } = useRecentPages()
const router = useRouter()
const route = useRoute()
const activeSpaceId = computed(() => spacesStore.activeSpaceId.value)
const activeSpace = computed(() => spacesStore.activeSpace.value)
const isPersonal = computed(() => activeSpace.value?.kind === 'personal')
/* P1-12 · 归档空间显式状态 —— 后端 GET /api/spaces 已经把 archivedAt
 * 字段透出来,前端用 stores.isArchived 派生(单一事实来源,跟
 * Sidebar / SpaceSwitcher 已有逻辑一致)。在 archive 过的空间里:
 *   - 渲染顶部只读 banner(归档时间 + 不能新增/编辑)
 *   - canCreateInSpace 仍走 canCreateInSpaceOf(架构上 archived shared
 *     space 对普通成员就返回 false),createRoot 也被 canCreateInSpace
 *     自然 disable
 *   - 现有页面树 / 阅读 / 浏览照常,成员可以继续读历史文档
 * 这是「区分业务状态」的最小实现 —— 用户点击旧链接进来看到「这里已
 * 归档,可以读不能改」而不是静默 404 / 静默首页。*/
const isArchived = computed(() => spacesStore.isArchived(activeSpaceId.value))
const archivedAt = computed<number | null>(() => activeSpace.value?.archivedAt ?? null)
const archivedByName = computed<string | null>(() => null)
const fallbackSpaceName = computed(() =>
  isPersonal.value ? '我的个人空间' : '团队空间',
)
/**
 * 团队空间主页跳转:Confluence space homepage 的同构。
 *
 * 当 activeSpace 配置了 homepagePageId(管理员在 SpaceEditView 里挑的本
 * 空间内一篇页面),`/` 路由应该渲染那篇页面的 ReadView,而不是系统仪
 * 表盘。个人空间永远为 null(没这个概念),跳过此分支。
 *
 * 用 router.replace 而不是 push —— `/` 是入口,「返回 `/`」不应再触发
 * 一次 redirect(否则 history 里堆栈爆炸)。
 *
 * 处理边界:homepagePageId 指向的页可能是 trash 或已 hard-delete。
 *   - soft-delete(进回收站):API 没自动清字段,保留信息让 admin 知情;
 *     ReadView 的 trash 渲染会接管(trashed 页面访问会显示相应状态)。
 *   - hard-delete(purge):pages.ts purge transaction 已同事务清空引用,
 *     所以「悬挂引用」不会发生(除非用户在 purge 流程完成前就缓存了
 *     stale activeSpace —— 此时 router.replace 会撞 ReadView 的 404,
 *     ReadView 显示错误页,用户可手动回 `/` 重试,这次就会走仪表盘)。
 */
const homepagePageId = computed(() => {
  if (isPersonal.value) return null
  return activeSpace.value?.homepagePageId ?? null
})
watch(
  [homepagePageId, activeSpaceId],
  ([target, sid]) => {
    if (!target || !sid) return
    // 仅当确实停在 `/`(home 路由)时跳;用户在 home 之后又点了别的页
    // 进来(罕见),不要把人家踢回主页。
    if (router.currentRoute.value.name !== 'home') return
    void router.replace(`/p/${target}`)
  },
  { immediate: true },
)
const homeTitle = computed(() => activeSpace.value?.name ?? fallbackSpaceName.value)
useDocumentTitle(() => `${homeTitle.value} · 首页`)
const me = computed(() => authStore.user)
const canCreateInSpace = computed(() =>
  canCreateInSpaceOf(authStore.user, activeSpace.value),
)
const inSpace = computed(() =>
  pagesStore.pages.filter((page) => page.spaceId === activeSpaceId.value),
)
const rootPages = computed(() =>
  inSpace.value
    .filter((page) => page.parentId === null)
    .sort((a, b) => a.order - b.order),
)
const recentPages = computed(() =>
  [...inSpace.value]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6),
)
const myRecentPages = computed(() =>
  recentList.value
    .filter((entry) => pagesStore.getPage(entry.id)?.spaceId === activeSpaceId.value)
    .slice(0, 6),
)
const stats = computed(() => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  const weekMs = todayMs - 7 * 86400000
  const meId = authStore.user?.id
  let editedToday = 0
  let thisWeek = 0
  let childCount = 0
  let myPages = 0

  for (const page of inSpace.value) {
    if (page.updatedAt >= todayMs) editedToday++
    if (page.updatedAt >= weekMs) thisWeek++
    if (page.parentId !== null) childCount++
    if (meId && page.authorId === meId) myPages++
  }

  return {
    total: inSpace.value.length,
    roots: rootPages.value.length,
    children: childCount,
    editedToday,
    thisWeek,
    myPages,
  }
})

/* P2-1 · stat-card drill-down —— 4 张 stat-card 改为 RouterLink,点击切换
 * `?filter=all|today|week|mine`。模式参考 SpacesView.vue 的 `?filter=empty
 * |unauthorized`。drillDownPages 依赖 inSpace / rootPages,所以放在它们
 * 之后声明。DrillDownPanel 只在 activeFilter 非空时挂载 —— 当 drill-down
 * 激活时,模板里把「推荐浏览 / 最近编辑」两个 section 隐藏(drill-down
 * 本身就是针对性列表),避免视觉冗余。*/
type StatFilter = '' | 'all' | 'today' | 'week' | 'mine'
const VALID_FILTERS: ReadonlySet<StatFilter> = new Set([
  '',
  'all',
  'today',
  'week',
  'mine',
])
const activeFilter = computed<StatFilter>(() => {
  const raw = String(route.query.filter ?? '')
  return VALID_FILTERS.has(raw as StatFilter) ? (raw as StatFilter) : ''
})
function setFilter(key: StatFilter): void {
  void router.replace({
    query: { ...route.query, filter: key === '' ? undefined : key },
  })
}
function filterTitle(key: StatFilter): string {
  switch (key) {
    case 'today': return '今日活跃'
    case 'week': return '本周更新'
    case 'mine': return '我的页面'
    case 'all': return '全部页面'
    default: return ''
  }
}
const drillDownPages = computed<PageNode[]>(() => {
  if (!activeFilter.value) return []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  const weekMs = todayMs - 7 * 86400000
  const meId = authStore.user?.id
  const inSpaceSorted = [...inSpace.value].sort((a, b) => b.updatedAt - a.updatedAt)
  let filtered: PageNode[]
  switch (activeFilter.value) {
    case 'today':
      filtered = inSpaceSorted.filter((p) => p.updatedAt >= todayMs)
      break
    case 'week':
      filtered = inSpaceSorted.filter((p) => p.updatedAt >= weekMs)
      break
    case 'mine':
      filtered = inSpaceSorted.filter((p) => meId !== null && p.authorId === meId)
      break
    case 'all':
      filtered = rootPages.value
      break
    default:
      filtered = []
  }
  return filtered.slice(0, 20)
})

function goPage(id: string): void {
  void router.push(`/p/${id}`)
}

async function createRoot(): Promise<void> {
  const clientId = newId()
  void router.push(`/p/${clientId}/edit`)
  try {
    await pagesStore.createPage({ id: clientId, parentId: null })
  } catch {
    // The store surfaces the error.
  }
}

function relativeTime(timestamp: number): string {
  return formatRelativeTime(timestamp)
}

function excerpt(html: string): string {
  return makeExcerpt(html)
}

/* P2-3 · 三步上手 —— 空状态卡 2(导入 Markdown)走 ImportMarkdownModal。
 * Modal 是 uiStore 持有的全局开关,从 active space 根(sidebar icon button
 * 入口)走的也是这条;不传 sourceRow(可选字段省略)即默认落到 active space 根。*/
function openImportModal(): void {
  const sid = activeSpaceId.value
  if (!sid) return
  uiStore.openImport({ defaultSpaceId: sid })
}

/* P2-3 · 三步上手 —— 空状态卡 3(邀请成员)。差距分析 P1/13.3 的「一次
 * 性邀请链接」还没建,这里先用 toast 兜底,等邀请流程落地后接进来。*/
function onInviteMembers(): void {
  uiStore.notify('请联系空间管理员邀请成员加入', 'info', 4000)
}
</script>

<template>
  <div class="home-shell">
    <Breadcrumb :segments="[{ label: homeTitle + ' · 首页' }]">
      <template #current>
        <span class="crumb-item current">
          {{ homeTitle }} · 首页
          <span
            v-if="!canCreateInSpace"
            class="material-symbols-outlined crumb-lock"
            title="你在此空间只有只读权限,无法创建新页面"
          >lock</span>
        </span>
      </template>
    </Breadcrumb>
    <!-- page-actions 同样 Teleport 到 #app-subheader,与面包屑并列渲染,
         视觉上「页面名/操作按钮」左右两段,顺序由 CSS .app-subheader-content
         下 .breadcrumb/.page-actions 的 order 锁死(见 components.css)。
         空间为空时不显示,空状态的「创建第一个页面」已经承担了主 CTA 职责;
         同时空(连首页空状态图都画好了)再叠一个 subheader 按钮会让用户
         在两个「+」之间挑,视觉冗余。 -->
    <div class="page-actions">
      <button v-if="canCreateInSpace && rootPages.length > 0" class="btn primary" @click="createRoot">
        <span class="material-symbols-outlined icon-lg">add</span>
        新建页面
      </button>
    </div>

    <div class="content-inner home-page content-wide">
      <!-- P1-12 · 归档空间 banner —— 只在 active space 已归档时显示。
           顶部醒目位置 + warning 配色,让用户第一眼知道「这里的状态跟
           平时不一样」;同时显式解释"仍可读,不能写 / 不能新增"
           —— 区别于 404 和无权访问。归档时间用相对时间,谁归档
           (archivedByName) 由后端 Space DTO 暂未透出,先给 ?。-->
      <div v-if="isArchived" class="archived-banner" role="status">
        <span class="material-symbols-outlined archived-banner-icon">inventory_2</span>
        <div class="archived-banner-body">
          <strong>此空间已归档</strong>
          <p>
            归档后空间内的页面仍可阅读、不会清除历史,
            但<strong>不能新增 / 修改 / 删除</strong>任何内容。
            如需恢复,请联系管理员。
          </p>
          <p v-if="archivedAt" class="archived-banner-meta">
            归档于 {{ relativeTime(archivedAt) }}
          </p>
        </div>
      </div>

      <EmptySpaceOnboarding
        v-if="rootPages.length === 0"
        :space-name="activeSpace?.name ?? fallbackSpaceName"
        :kind="isPersonal ? 'personal' : 'shared'"
        :can-create="canCreateInSpace"
        @create-page="createRoot"
        @import-markdown="openImportModal"
        @invite-members="onInviteMembers"
      />

      <template v-else>
        <div class="home-hero">
          <h1 class="page-title">{{ homeTitle }}</h1>
          <div class="page-byline">
            <span class="author">
              <UserAvatar
                :size="20"
                :label="me?.name ?? '我'"
                :color="me?.color"
                :avatar-kind="me?.avatarKind ?? null"
                :avatar-ref="me?.avatarRef ?? null"
                :user-id="me?.id ?? null"
              />
              {{ me?.name ?? '我' }}
            </span>
            <span class="dot">·</span>
            <span>共 {{ stats.total }} 个页面 · {{ stats.roots }} 个根页面 · {{ stats.children }} 个子页面</span>
          </div>
        </div>

        <section v-if="activeSpace?.description" class="space-overview">
          <SpaceAvatar :space="activeSpace" :size="40" :show-name="true" />
          <p class="space-overview-desc">{{ activeSpace.description }}</p>
        </section>

        <div class="stat-grid">
          <StatCard
            label="全部页面"
            :value="stats.total"
            :trend="`${stats.roots} 根 · ${stats.children} 子`"
            icon="description"
            variant="default"
            filter-key="all"
          />
          <StatCard
            label="今日活跃"
            :value="stats.editedToday"
            trend="最近 24h 更新过"
            icon="today"
            variant="success"
            filter-key="today"
          />
          <StatCard
            label="本周更新"
            :value="stats.thisWeek"
            trend="过去 7 天"
            icon="schedule"
            variant="purple"
            filter-key="week"
          />
          <StatCard
            label="我的页面"
            :value="stats.myPages"
            trend="我创建的 · 本空间内"
            icon="person"
            variant="warning"
            filter-key="mine"
          />
        </div>

        <DrillDownPanel
          v-if="activeFilter"
          :title="filterTitle(activeFilter)"
          :count="drillDownPages.length"
          :pages="drillDownPages"
          @clear="setFilter('')"
          @open="goPage"
        />

        <div class="quick-actions">
          <button v-if="canCreateInSpace" class="quick-action" @click="createRoot">
            <span class="qa-icon"><span class="material-symbols-outlined">add_circle</span></span>
            <span>
              <span>新建空白页面</span>
              <span class="qa-meta">从零开始记录</span>
            </span>
          </button>
          <button class="quick-action" @click="$el.querySelector('.page-grid')?.scrollIntoView({ behavior: 'smooth' })">
            <span class="qa-icon"><span class="material-symbols-outlined">folder_open</span></span>
            <span>
              <span>浏览所有根页面</span>
              <span class="qa-meta">{{ stats.roots }} 个主题</span>
            </span>
          </button>
          <button class="quick-action" @click="uiStore.openTopSearch()">
            <span class="qa-icon"><span class="material-symbols-outlined">search</span></span>
            <span>
              <span>搜索页面</span>
              <span class="qa-meta">按标题搜索</span>
            </span>
          </button>
        </div>

        <!-- drill-down 激活时隐藏这两个 section(drill-down 本身就是针对性列表,
         视觉冗余)。「所有主题」主题卡网格保留,因为它展示根页面 excerpt
         + 子页数,是 drill-down 没有的维度。-->
        <template v-if="!activeFilter">
          <div class="section-title">
            <span>{{ myRecentPages.length > 0 ? '我最近访问' : '推荐浏览' }}</span>
          </div>
          <ul v-if="myRecentPages.length > 0" class="recent-list recent-list--mine">
            <li v-for="entry in myRecentPages" :key="entry.id" @click="goPage(entry.id)">
              <span class="material-symbols-outlined doc-icon">history</span>
              <span class="rl-title">{{ entry.title }}</span>
              <span class="rl-meta">{{ relativeTime(entry.visitedAt) }}</span>
            </li>
          </ul>
          <ul v-else class="recent-list">
            <li v-for="page in recentPages.slice(0, 3)" :key="page.id" @click="goPage(page.id)">
              <span class="material-symbols-outlined doc-icon">description</span>
              <span class="rl-title">{{ page.title }}</span>
              <span class="rl-meta">{{ relativeTime(page.updatedAt) }}</span>
            </li>
          </ul>

          <div class="section-title">
            <span>最近编辑</span>
          </div>
          <ul class="recent-list">
            <li v-for="page in recentPages" :key="page.id" @click="goPage(page.id)">
              <span class="material-symbols-outlined doc-icon">description</span>
              <span class="rl-title">{{ page.title }}</span>
              <span class="rl-meta">{{ relativeTime(page.updatedAt) }}</span>
            </li>
          </ul>
        </template>

        <div class="section-title">
          <span>所有主题</span>
          <span class="count">{{ stats.roots }}</span>
        </div>
        <div class="page-grid">
          <a
            v-for="page in rootPages"
            :key="page.id"
            class="page-card"
            href="#"
            @click.prevent="goPage(page.id)"
          >
            <span class="material-symbols-outlined pc-icon">folder_open</span>
            <div class="pc-title">{{ page.title }}</div>
            <div class="pc-excerpt">{{ excerpt(page.contentHTML) || '空白页面' }}</div>
            <div class="pc-meta">
              <span class="material-symbols-outlined icon-xs">schedule</span>
              {{ relativeTime(page.updatedAt) }}
              <span class="meta-separator">·</span>
              <span class="material-symbols-outlined icon-xs">layers</span>
              {{ pagesStore.getChildren(page.id).length }} 子页面
            </div>
          </a>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* P1-12 · 归档空间 banner —— 跟 ReadView 同款中性灰 + icon。
 * 归档是生命周期状态,不是错误或风险(见 ReadView archived-banner
 * 注释),保持中性视觉跟「个人工作台 / 团队空间」首页节奏一致。
 * 位置在 content-inner 顶部,保证用户进入空间第一眼看到状态。*/
.archived-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 0 20px;
  padding: 12px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.archived-banner-icon {
  font-size: 20px;
  line-height: 1.2;
  color: var(--text-3);
  flex-shrink: 0;
}
.archived-banner-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--text-2);
}
.archived-banner-body strong { color: var(--text-1); font-weight: 600; }
.archived-banner-body p { margin: 0; color: var(--text-2); }
.archived-banner-meta {
  color: var(--text-3) !important;
  font-size: 12px;
  margin-top: 2px !important;
}
.home-hero { margin-bottom: 8px; }
.space-overview {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 16px 0 20px;
  padding: 12px 16px;
  background: var(--bg-subtle);
  border-radius: var(--radius-md, 6px);
}
.space-overview :deep(.sa-name) {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin-right: 8px;
}
.space-overview-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  flex: 1;
  min-width: 0;
}
.crumb-lock {
  font-size: 14px !important;
  color: var(--text-3);
  flex-shrink: 0;
}
.quick-action > span:last-child {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.doc-icon { font-size: 18px !important; }
.pc-icon { font-size: 22px !important; }
.meta-separator { margin: 0 4px; }
</style>
