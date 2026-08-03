<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DashboardCard from '@/components/page/DashboardCard.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import PageActions from '@/components/ui/PageActions.vue'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { useNotificationsStore } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { useRecentPages } from '@/composables/useRecentPages'
import { formatRelativeTime } from '@/lib/relativeTime'
import { newId } from '@/lib/id'
import { canCreateInSpace as canCreateInSpaceOf } from '@/lib/permissions'
import { api } from '@/lib/api'
import type { DashboardPayload, PageNode, Space, SpaceRole } from '@power-wiki/shared'

/* ─── 模块 1 P1 · 共享空间与角色 ─────────────────────────────────────
 * SpaceSwitcher 只列空间名 + 描述,没有「我是谁」的信息;被加进 / 移出
 * 团队空间对用户是不透明的。这里给 /me 增加一栏身份清单,row 视觉跟
 * SpaceMembersTab 对齐(role pill 配色一致),但只展示自己一行。
 *
 * **只展示 shared/team 空间** — personal 空间已经通过 cover 里的
 * 「查看我的草稿 →」入口体现,再列一份等于重复;section 的语义是
 * 「我在哪些团队空间、各自什么角色」,不是「我的全部空间」。
 *
 * 数据 0 改动:`GET /api/spaces` 已经给每条 space 注入 `viewerRole`
 * (effective space role,后端 `getEffectiveSpaceRolesForUser` 计算),
 * 前端直接消费 `spacesStore.spaces.value` 即可。ROLE_INFO 视觉对齐
 * SpaceMembersTab 的 smt-role-value(同一套配色 + icon + label),
 * 这里不抽公共组件 —— CLAUDE.md 「read-only roles are not buttons」
 * 把它当「信息」而非「组件」对待,本地写一份 4 行映射。*/
const ROLE_INFO: Record<SpaceRole, { label: string; icon: string }> = {
  admin:  { label: '管理', icon: 'shield_person' },
  editor: { label: '编辑', icon: 'edit' },
  viewer: { label: '只读', icon: 'visibility' },
}

const router = useRouter()
const auth = useAuthStore()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const notifications = useNotificationsStore()
const uiStore = useUiStore()
const { list: recentList } = useRecentPages()

useDocumentTitle(() => '我的工作台')

const payload = ref<DashboardPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const personalSpace = computed(() =>
  spacesStore.spaces.value.find((space) => space.kind === 'personal') ?? null,
)
const canCreatePersonalPage = computed(() =>
  canCreateInSpaceOf(auth.user, personalSpace.value),
)
const spaceById = computed<Map<string, Space>>(() => {
  const result = new Map<string, Space>()
  for (const space of spacesStore.spaces.value) result.set(space.id, space)
  return result
})
const hasMentions = computed(() => (payload.value?.mentions.length ?? 0) > 0)
const hasCreated = computed(() => (payload.value?.created.length ?? 0) > 0)
const hasPersonalSpace = computed(() => (payload.value?.personalSpace.length ?? 0) > 0)
const hasWatched = computed(() => (payload.value?.watched.length ?? 0) > 0)
const profileSummary = computed(() => {
  const mentions = payload.value?.mentions.length ?? 0
  const created = payload.value?.created.length ?? 0
  if (mentions > 0) return `有 ${mentions} 条未读提到等待处理,最近创建了 ${created} 个页面。`
  if (created > 0) return '集中查看你跨空间创建和最近访问的内容。'
  return '这是你跨空间的个人工作台,从这里开始记录和整理知识。'
})
const recentItems = computed(() => recentList.value.map((entry) => {
  const page = pagesStore.getPage(entry.id)
  // spaceId 优先级:1) entry 自带(syncFromServer / recordVisit 都塞了);
  // 2) pagesStore lookup(老 localStorage cache 没塞 spaceId 时);
  // 3) null → fallback 回 history icon。
  const spaceId = entry.spaceId ?? page?.spaceId ?? null
  return {
    id: entry.id,
    title: page?.title || entry.title,
    spaceId,
    timestamp: entry.visitedAt,
    // 死 row = page 已被 soft-delete。pagesStore.getPage 走内部 pages map,
    // soft-delete 后的页不在那里(API 列表过滤 deletedAt)→ getPage 返回
    // undefined。`alive` 必须显式区分「找到且未删」与「找不到」两种情况,
    // 否则 undefined?.deletedAt === undefined 让 `!undefined` = true,死
    // row 被误判为 alive,stored-row-dead + disabled 视觉降级不生效。
    alive: !!page && !page.deletedAt,
  }
}))

/* personalSpaceName / personalSpaceColor —— 「我在个人空间起草的」section
 * row 的 space chip 用用户自己的个人空间(所有 row 都来自同一空间,
 * 没有跨空间)。从 store 拿空间元数据,store 还没 init 时 fallback 到
 * 字面量「个人空间」+ 灰色;前者是 hot path,后者是 loading 兜底。*/
const personalSpaceName = computed(() => personalSpace.value?.name ?? '个人空间')
const personalSpaceColor = computed(() => personalSpace.value?.color ?? 'var(--text-3)')

/* watchedPages —— 「我关注的页面」section 渲染源。Audit 5.1 期望
 * 「按 updatedAt desc」语义(用户最关心的「关注页最近发生了什么」),
 * 但后端 user_watched_pages.watchedAt 排序是「按我加入关注的时间」,
 * 跟「页面新鲜度」不一样。前端这里 client-side 按 updatedAt 重排,
 * 跟 "created" / "personalSpace" 两节(updatedAt DESC)的语义对齐。
 * spread + sort 避免修改 readonly payload 数组。*/
const watchedPages = computed<PageNode[]>(() => {
  const list = payload.value?.watched ?? []
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
})

function describeSpace(id: string | null | undefined): {
  name: string
  color: string
  kind: 'personal' | 'shared'
} {
  const space = id ? spaceById.value.get(id) : null
  if (!space) return { name: '(已删除空间)', color: 'var(--text-3)', kind: 'shared' }
  return {
    name: space.name,
    color: space.color,
    kind: space.kind ?? 'shared',
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    if (!spacesStore.loaded.value) await spacesStore.init()
    payload.value = await api.users.me.dashboard(5)
    void notifications.refreshUnread()
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => { void load() })

function openPage(pageId: string): void {
  // 跨 section 查找:任一 dashboard 数组里能找到就用其 spaceId 切 active;
  // 找不到再 fall back 到 pagesStore(可能是 pages store 缓存 / syncFromServer
  // 期间已经 preloaded 的页面)。activeSpace 不一致时设上,确保 PageTree
  // 能正确显示当前页面所在空间。
  const page = payload.value?.created.find((entry) => entry.id === pageId)
    ?? payload.value?.personalSpace.find((entry) => entry.id === pageId)
    ?? payload.value?.watched.find((entry) => entry.id === pageId)
    ?? pagesStore.getPage(pageId)
  if (page?.spaceId && spacesStore.activeSpaceId.value !== page.spaceId) {
    spacesStore.setActiveSpace(page.spaceId)
  }
  void router.push(`/p/${pageId}`)
}

function openStoredPage(item: { id: string; spaceId: string | null; alive: boolean }): void {
  if (!item.alive) return
  if (item.spaceId && spacesStore.activeSpaceId.value !== item.spaceId) {
    spacesStore.setActiveSpace(item.spaceId)
  }
  void router.push(`/p/${item.id}`)
}

async function openMention(pageId: string, commentId: string | null): Promise<void> {
  const matchingMentions = payload.value?.mentions.filter(
    (notification) => !notification.isRead
      && notification.pageId === pageId
      && (commentId == null || notification.commentId === commentId),
  ) ?? []
  const idsToMarkRead = matchingMentions.map((notification) => notification.id)
  if (idsToMarkRead.length > 0) {
    try {
      await api.notifications.markRead({ ids: idsToMarkRead })
      void notifications.refreshUnread()
    } catch {
      // Navigation remains available if marking the notification fails.
    }
  }

  const page = payload.value?.created.find((entry) => entry.id === pageId)
    ?? pagesStore.getPage(pageId)
  if (page?.spaceId && spacesStore.activeSpaceId.value !== page.spaceId) {
    spacesStore.setActiveSpace(page.spaceId)
  }
  const hash = commentId ? `#comment-${commentId}` : ''
  void router.push(`/p/${pageId}${hash}`)
}

async function createPersonalPage(): Promise<void> {
  const space = personalSpace.value
  if (!space || !canCreatePersonalPage.value) return
  spacesStore.setActiveSpace(space.id)
  const id = newId()
  void router.push(`/p/${id}/edit`)
  try {
    await pagesStore.createPage({ id, parentId: null, spaceId: space.id })
  } catch {
    // The store surfaces the error.
  }
}

function goPersonalDrafts(): void {
  document.getElementById('personal-drafts')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* goToSpace — 「我的空间与角色」section 的进入按钮 handler。
 * 统一切换 active space 并回到空间首页,泛化到任意 space。
 * 不预加载 pages roots:`/` 路由的 SpaceHomeView 挂载时会自己拉,
 * 不需要 dashboard 路径额外触发一次请求(避免双跳抖动)。*/
function goToSpace(space: Space): void {
  spacesStore.setActiveSpace(space.id)
  if (router.currentRoute.value.path !== '/') {
    void router.push('/')
  }
}

/* sharedSpacesRows — section 渲染源,**只包含 shared/team 空间**。
 * 排序:活跃(name 字母序)→ 归档(仅 admin,name 字母序,行视觉降级)。
 * personal 空间不进 list —— 已在 cover 暴露,这里是「团队身份清单」。*/
const sharedSpacesRows = computed<Space[]>(() => {
  const all = spacesStore.spaces.value
  const isAdmin = auth.user?.role === 'admin'
  const active = all
    .filter((s) => s.kind === 'shared' && !s.archivedAt)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
  const archived = isAdmin
    ? all
        .filter((s) => s.kind === 'shared' && !!s.archivedAt)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
    : []
  return [...active, ...archived]
})

/* ─── P1-9 · PersonalHomeView 折叠 / 分组 ─────────────────────────────
 * 6 个 section 拆成 2 组 —— 「主」(always-visible,默认展开)与「次级」
 * (折叠收起的低优先级信息)。复用 Sidebar.vue 已用的 uiStore 折叠设施
 * (KEY 在 localStorage 持久化),跨刷新记得住。
 *
 * 默认态:
 *   - 主:提到我 / 我在个人空间起草的 / 我关注的页面
 *         这 3 块是用户今天最该看的内容(待办 / 草稿 / 关注更新)。
 *         defaultCollapsed = false(展开)。
 *   - 次级:共享空间与角色 / 我创建的 / 最近访问
 *         这些偏身份/浏览信息,需要时点开看;常驻展开抢视觉。
 *         defaultCollapsed = true(折叠)。
 *
 * key 命名:`ph-` 前缀避免与 Sidebar section 撞 KEY_SIDEBAR_SECTIONS
 * 命名空间(uiStore 里只有一份 map,但 key 全局唯一即可,前缀是排错
 * 时的可读性,不是隔离机制)。*/
const SECTION_MENTIONS = 'ph-mentions'
const SECTION_DRAFTS = 'ph-drafts'
const SECTION_WATCHED = 'ph-watched'
const SECTION_SHARED = 'ph-shared'
const SECTION_CREATED = 'ph-created'
const SECTION_RECENT = 'ph-recent'
/* P1-9 · 次级分组的整体折叠态 —— 在「今天该看」三块下面,
 * 点 `浏览与身份` 整块收起的对象。3 个子 section 各自还独立可折叠,
 * 这个只负责最外层一键展开/收起,跟 sidebar 「此空间的页面」的
 * group / item 二级折叠同构。*/
const SECTION_GROUP_SECONDARY = 'ph-group-secondary'

const mentionsCollapsed = computed(() => uiStore.isSectionCollapsed(SECTION_MENTIONS, false))
const draftsCollapsed = computed(() => uiStore.isSectionCollapsed(SECTION_DRAFTS, false))
const watchedCollapsed = computed(() => uiStore.isSectionCollapsed(SECTION_WATCHED, false))
const sharedCollapsed = computed(() => uiStore.isSectionCollapsed(SECTION_SHARED, true))
const createdCollapsed = computed(() => uiStore.isSectionCollapsed(SECTION_CREATED, true))
const recentCollapsed = computed(() => uiStore.isSectionCollapsed(SECTION_RECENT, true))
const secondaryCollapsed = computed(() => uiStore.isSectionCollapsed(SECTION_GROUP_SECONDARY, true))

const isAdminUser = computed(() => auth.user?.role === 'admin')

/* section meta 文案:普通用户「共 N 个」足够;admin 多挂一段「已归档 M 个」,
 * 跟 Sidebar / SpaceSwitcher 在 admin 视图下的「team N · 归档 M」节奏一致。*/
const sharedSpacesMeta = computed(() => {
  const total = sharedSpacesRows.value.length
  if (!isAdminUser.value) return `共 ${total} 个`
  const archived = sharedSpacesRows.value.filter((s) => !!s.archivedAt).length
  if (archived === 0) return `共 ${total} 个`
  return `共 ${total} 个 · 已归档 ${archived} 个`
})

/* 描述一行:team 空间没 desc 就不显示;归档则在末尾追加「归档后只读」
 * 灰字(走 inventory_2 icon)。返回 null = 不显示副信息行(干净)。*/
function spaceSubLabel(space: Space): { icon: string; text: string } | null {
  if (space.archivedAt) return { icon: 'inventory_2', text: '已归档 · 归档后只读' }
  return null
}

function ensurePageLoaded(page: PageNode): void {
  if (pagesStore.getPage(page.id)) return
  void pagesStore.ensureAncestorsLoaded(page.id)
}

/* recentSpaceById — 「最近访问」row 用空间头像(不是通用 history icon)
 * 来给用户空间归属感。空间已删 / spaceId 为 null(老 cache / dead row)
 * 时返回 null,fallback 回 history icon。spaceById 已是 reactive,
 * 跟着 spacesStore.spaces.value 走。*/
function recentSpaceById(spaceId: string | null): Space | null {
  if (!spaceId) return null
  return spaceById.value.get(spaceId) ?? null
}

function relativeTime(timestamp: number): string {
  return formatRelativeTime(timestamp)
}
</script>

<template>
  <div class="personal-home-shell">
    <Breadcrumb :segments="[{ label: '我的工作台' }]" />
    <PageActions>
      <button
        v-if="canCreatePersonalPage"
        class="btn"
        type="button"
        @click="createPersonalPage"
      >
        <span class="material-symbols-outlined icon-lg">add</span>
        新建个人页面
      </button>
      <button class="btn primary" type="button" @click="uiStore.openSettings()">
        <span class="material-symbols-outlined icon-lg">edit</span>
        编辑资料
      </button>
    </PageActions>

    <div class="content-inner personal-home-page content-wide">
      <header class="profile-cover">
        <UserAvatar
          :size="56"
          :label="auth.user?.name ?? '我'"
          :color="auth.user?.color"
          :avatar-kind="auth.user?.avatarKind ?? null"
          :avatar-ref="auth.user?.avatarRef ?? null"
          :user-id="auth.user?.id ?? null"
        />
        <div class="profile-copy">
          <span class="profile-eyebrow">个人工作台</span>
          <h1 class="profile-name">{{ auth.user?.name ?? '我' }}</h1>
          <p v-if="auth.user?.email" class="profile-email">{{ auth.user.email }}</p>
          <p class="profile-summary">{{ profileSummary }}</p>
          <button
            v-if="personalSpace"
            type="button"
            class="profile-space-link"
            @click="goPersonalDrafts"
          >
            <span class="material-symbols-outlined">lock_person</span>
            <span>查看我的草稿 →</span>
          </button>
        </div>
      </header>

      <div v-if="error" class="personal-home-error">
        <span class="material-symbols-outlined">error</span>
        <span>{{ error }}</span>
        <button class="link-btn" type="button" @click="load">重试</button>
      </div>

      <div class="personal-sections">
        <!-- P1-9 · 主分组:今天该看 —— @提到我 / 我的草稿 / 我关注的变化。
             三块都默认展开,是用户进来个人首页最先想看的内容。次级分组
             (共享空间 / 我创建的 / 最近访问)收在下面一个「浏览与身份」
             折叠块里,默认折叠。 -->
        <div class="personal-group personal-group-primary">
          <div class="personal-group-label">
            <span class="material-symbols-outlined">priority_high</span>
            <span>今天该看</span>
          </div>

          <section class="personal-section">
            <header class="section-head section-toggle-row">
              <button
                type="button"
                class="section-toggle"
                :aria-expanded="!mentionsCollapsed"
                @click="uiStore.toggleSection(SECTION_MENTIONS, false)"
              >
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon mention-icon">alternate_email</span>
                  @提到我
                </h2>
                <span class="section-meta">{{ payload?.mentions.length ?? 0 }} 条未读</span>
                <span
                  class="material-symbols-outlined section-chevron"
                  :class="{ 'chevron-collapsed': mentionsCollapsed }"
                >expand_more</span>
              </button>
            </header>
            <div v-show="!mentionsCollapsed" class="section-body">
              <div v-if="loading && !payload" class="section-loading">
                <div v-for="index in 3" :key="index" class="row-skeleton">
                  <Skeleton circle :width="32" :height="32" />
                  <div class="row-skeleton-text">
                    <Skeleton :width="`${55 + index * 7}%`" :height="14" />
                    <Skeleton :width="`${30 + index * 5}%`" :height="11" />
                  </div>
                </div>
              </div>
              <ul v-else-if="hasMentions" class="section-list">
                <li v-for="notification in payload!.mentions" :key="notification.id">
                  <DashboardCard
                    variant="mention"
                    :notification="notification"
                    @open-mention="(pageId, commentId) => openMention(pageId, commentId)"
                  />
                </li>
              </ul>
              <EmptyState
                v-else
                icon="forum"
                title="没有被 @ 提到"
                hint="有人在评论里 @ 你时会出现在这里。"
                size="sm"
              />
            </div>
          </section>

          <section id="personal-drafts" class="personal-section personal-drafts-section">
            <header class="section-head section-toggle-row">
              <button
                type="button"
                class="section-toggle"
                :aria-expanded="!draftsCollapsed"
                @click="uiStore.toggleSection(SECTION_DRAFTS, false)"
              >
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon personal-space-icon">lock_person</span>
                  我的草稿
                </h2>
                <span class="section-meta">最近 {{ payload?.personalSpace.length ?? 0 }} 个</span>
                <span
                  class="material-symbols-outlined section-chevron"
                  :class="{ 'chevron-collapsed': draftsCollapsed }"
                >expand_more</span>
              </button>
            </header>
            <div v-show="!draftsCollapsed" class="section-body">
              <div v-if="loading && !payload" class="section-loading">
                <div v-for="index in 3" :key="index" class="row-skeleton">
                  <Skeleton :width="32" :height="32" />
                  <div class="row-skeleton-text">
                    <Skeleton :width="`${50 + index * 7}%`" :height="14" />
                    <Skeleton :width="`${30 + index * 5}%`" :height="11" />
                  </div>
                </div>
              </div>
              <ul v-else-if="hasPersonalSpace" class="section-list">
                <li
                  v-for="page in payload!.personalSpace"
                  :key="page.id"
                  @mouseenter="ensurePageLoaded(page)"
                >
                  <DashboardCard
                    variant="page"
                    :page="page"
                    :space-name="personalSpaceName"
                    :space-color="personalSpaceColor"
                    space-kind="personal"
                    @open-page="openPage"
                  />
                </li>
              </ul>
              <EmptyState
                v-else
                icon="lock_person"
                title="还没有个人草稿"
                hint="在个人空间写点东西,会按更新时间出现在这里。"
                size="sm"
              />
            </div>
          </section>

          <section class="personal-section">
            <header class="section-head section-toggle-row">
              <button
                type="button"
                class="section-toggle"
                :aria-expanded="!watchedCollapsed"
                @click="uiStore.toggleSection(SECTION_WATCHED, false)"
              >
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon watched-icon">notifications_active</span>
                  我关注的变化
                </h2>
                <span class="section-meta">最近 {{ watchedPages.length }} 个</span>
                <span
                  class="material-symbols-outlined section-chevron"
                  :class="{ 'chevron-collapsed': watchedCollapsed }"
                >expand_more</span>
              </button>
            </header>
            <div v-show="!watchedCollapsed" class="section-body">
              <div v-if="loading && !payload" class="section-loading">
                <div v-for="index in 3" :key="index" class="row-skeleton">
                  <Skeleton circle :width="32" :height="32" />
                  <div class="row-skeleton-text">
                    <Skeleton :width="`${50 + index * 7}%`" :height="14" />
                    <Skeleton :width="`${30 + index * 5}%`" :height="11" />
                  </div>
                </div>
              </div>
              <ul v-else-if="hasWatched" class="section-list">
                <li
                  v-for="page in watchedPages"
                  :key="page.id"
                  @mouseenter="ensurePageLoaded(page)"
                >
                  <DashboardCard
                    variant="page"
                    :page="page"
                    :space-name="describeSpace(page.spaceId).name"
                    :space-color="describeSpace(page.spaceId).color"
                    :space-kind="describeSpace(page.spaceId).kind"
                    @open-page="openPage"
                  />
                </li>
              </ul>
              <EmptyState
                v-else
                icon="notifications_off"
                title="还没有关注任何页面"
                hint="打开任一页,点顶栏的「铃铛」按钮,会出现在这里。"
                size="sm"
              />
            </div>
          </section>
        </div>

        <!-- P1-9 · 次级分组:身份 / 浏览信息,默认折叠。常驻展开会跟
             主分组三块争视觉;点开后才看到 3 个 2 列网格子卡片。 -->
        <div class="personal-group personal-group-secondary">
          <button
            type="button"
            class="personal-group-toggle"
            :aria-expanded="!secondaryCollapsed"
            @click="uiStore.toggleSection(SECTION_GROUP_SECONDARY, true)"
          >
            <span class="personal-group-toggle-label">
              <span class="material-symbols-outlined">workspaces</span>
              <span>浏览与身份</span>
            </span>
            <span class="personal-group-toggle-meta">3 项</span>
            <span
              class="material-symbols-outlined section-chevron"
              :class="{ 'chevron-collapsed': secondaryCollapsed }"
            >expand_more</span>
          </button>

          <div v-show="!secondaryCollapsed" class="personal-sections-secondary">
            <section class="personal-section shared-spaces-section">
              <header class="section-head section-toggle-row">
                <button
                  type="button"
                  class="section-toggle"
                  :aria-expanded="!sharedCollapsed"
                  @click="uiStore.toggleSection(SECTION_SHARED, true)"
                >
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon">workspaces</span>
                    共享空间与角色
                  </h2>
                  <span class="section-meta">{{ sharedSpacesMeta }}</span>
                  <span
                    class="material-symbols-outlined section-chevron"
                    :class="{ 'chevron-collapsed': sharedCollapsed }"
                  >expand_more</span>
                </button>
              </header>
              <div v-show="!sharedCollapsed" class="section-body">
                <ul v-if="sharedSpacesRows.length > 0" class="ms-list">
            <li
              v-for="space in sharedSpacesRows"
              :key="space.id"
              class="ms-row"
              :class="{ 'ms-row-archived': !!space.archivedAt }"
            >
              <SpaceAvatar :space="space" :size="20" />
              <span class="ms-row-name">{{ space.name }}</span>
              <span
                v-if="spaceSubLabel(space)"
                class="ms-row-sub"
              >
                <span class="material-symbols-outlined ms-row-sub-icon">{{ spaceSubLabel(space)!.icon }}</span>
                <span>{{ spaceSubLabel(space)!.text }}</span>
              </span>
              <span class="ms-spacer" />
              <span
                v-if="space.viewerRole"
                class="ms-role"
                :class="`ms-role-${space.viewerRole}`"
              >
                <span class="material-symbols-outlined ms-role-icon">{{ ROLE_INFO[space.viewerRole].icon }}</span>
                <span>{{ ROLE_INFO[space.viewerRole].label }}</span>
              </span>
              <span v-else class="ms-role ms-role-none">
                <span class="material-symbols-outlined ms-role-icon">help</span>
                <span>未知</span>
              </span>
              <button
                type="button"
                class="ms-enter"
                :title="`进入「${space.name}」空间首页`"
                @click="goToSpace(space)"
              >
                <span class="material-symbols-outlined">arrow_forward</span>
              </button>
            </li>
          </ul>
          <EmptyState
            v-else
            icon="workspaces"
            title="还没有加入任何团队空间"
            hint="联系管理员把你加入团队空间,就可以在这里看到自己的角色。"
            size="sm"
          />
              </div>
            </section>

            <section class="personal-section">
              <header class="section-head section-toggle-row">
                <button
                  type="button"
                  class="section-toggle"
                  :aria-expanded="!createdCollapsed"
                  @click="uiStore.toggleSection(SECTION_CREATED, true)"
                >
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon">edit_note</span>
                    我创建的
                  </h2>
                  <span class="section-meta">最近 {{ payload?.created.length ?? 0 }} 个</span>
                  <span
                    class="material-symbols-outlined section-chevron"
                    :class="{ 'chevron-collapsed': createdCollapsed }"
                  >expand_more</span>
                </button>
              </header>
              <div v-show="!createdCollapsed" class="section-body">
                <div v-if="loading && !payload" class="section-loading">
                  <div v-for="index in 3" :key="index" class="row-skeleton">
                    <Skeleton :width="32" :height="32" />
                    <div class="row-skeleton-text">
                      <Skeleton :width="`${50 + index * 7}%`" :height="14" />
                      <Skeleton :width="`${30 + index * 5}%`" :height="11" />
                    </div>
                  </div>
                </div>
                <ul v-else-if="hasCreated" class="section-list">
                  <li
                    v-for="page in payload!.created"
                    :key="page.id"
                    @mouseenter="ensurePageLoaded(page)"
                  >
                    <DashboardCard
                      variant="page"
                      :page="page"
                      :space-name="describeSpace(page.spaceId).name"
                      :space-color="describeSpace(page.spaceId).color"
                      :space-kind="describeSpace(page.spaceId).kind"
                      @open-page="openPage"
                    />
                  </li>
                </ul>
                <EmptyState
                  v-else
                  icon="article"
                  title="还没有创建过页面"
                  hint="去任意空间创建你的第一页,会出现在这里。"
                  size="sm"
                />
              </div>
            </section>

            <section class="personal-section">
              <header class="section-head section-toggle-row">
                <button
                  type="button"
                  class="section-toggle"
                  :aria-expanded="!recentCollapsed"
                  @click="uiStore.toggleSection(SECTION_RECENT, true)"
                >
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon">history</span>
                    最近访问
                  </h2>
                  <span class="section-meta">{{ recentItems.length }} 个</span>
                  <span
                    class="material-symbols-outlined section-chevron"
                    :class="{ 'chevron-collapsed': recentCollapsed }"
                  >expand_more</span>
                </button>
              </header>
              <div v-show="!recentCollapsed" class="section-body">
                <ul v-if="recentItems.length > 0" class="stored-list">
                  <li v-for="item in recentItems" :key="item.id">
                    <button
                      type="button"
                      class="stored-row"
                      :class="{ 'stored-row-dead': !item.alive }"
                      :disabled="!item.alive"
                      @click="openStoredPage(item)"
                    >
                      <SpaceAvatar
                        v-if="recentSpaceById(item.spaceId)"
                        :space="recentSpaceById(item.spaceId)"
                        :size="20"
                        class="stored-avatar"
                      />
                      <span v-else class="material-symbols-outlined stored-icon">history</span>
                      <span class="stored-title">{{ item.title }}</span>
                      <span class="stored-meta">{{ relativeTime(item.timestamp) }}</span>
                    </button>
                  </li>
                </ul>
                <EmptyState
                  v-else
                  icon="history"
                  title="暂无最近访问"
                  hint="打开过的页面会按访问时间显示在这里。"
                  size="sm"
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.personal-home-page {
  padding-top: 28px;
  padding-bottom: 64px;
}
/* cover —— 双列布局(avatar + 文字块),去掉右侧冗余的「编辑资料」
 * 按钮(subheader 已有一份);padding 从 28/32 收到 20/28,跟下方
 * section 卡片节奏一致;box-shadow 去掉 —— 在 2560 宽视口下阴影很
 * 重,border + radius 已经足够把 cover 跟背景区分开。*/
.profile-cover {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  column-gap: 24px;
  padding: 20px 28px;
  margin-bottom: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
}
.profile-copy { min-width: 0; }
.profile-eyebrow {
  display: block;
  margin-bottom: 4px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.profile-name {
  margin: 0;
  color: var(--text-1);
  font-size: 26px;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
.profile-email {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 13px;
}
.profile-summary {
  margin: 10px 0 0;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.55;
}

/* 「查看我的草稿 →」— cover 内的 inline link,定位到下方个人草稿 section。
 * 不再重复触发进入个人空间的 / 路由,让 cover 入口承担明确的内容导航。 */
.profile-space-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out);
}
.profile-space-link:hover { color: var(--accent); }
.profile-space-link .material-symbols-outlined {
  font-size: 15px !important;
  color: inherit;
}
.personal-drafts-section {
  scroll-margin-top: calc(var(--topbar-h) + var(--sub-h) + var(--space-4));
}
.personal-home-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-bottom: 20px;
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  color: var(--danger);
  font-size: 14px;
}
.link-btn {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.personal-sections {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  align-items: start;
}
.personal-section {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
}
/* 静态卡片,不交互 —— 去掉 hover 边框/阴影变化(原 transition 让边框
 * 在 mouseover 时变成 border-strong + 加 shadow,在大网格里 4 张卡同时
 * 高亮显得「卡片墙」,而非信息分区。)*/
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
}
.section-title {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-1);
  font-size: 15px;
  font-weight: 600;
}
.section-icon {
  color: var(--text-2);
  font-size: 20px !important;
}
.mention-icon { color: var(--danger); }
/* 5.1 P0 · personalSpace / watched section 配色:
   - personalSpace 用 accent(跟 shared-spaces-section 平行,两组都是
     「你的空间」概念,保持视觉权重);
   - watched 用默认 text-2(信息浏览类,跟 created / recent 同节奏)。*/
.personal-space-icon { color: var(--accent); }
.watched-icon { color: var(--text-2); }
.section-meta {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-subtle);
  color: var(--text-3);
  font-size: 12px;
  font-weight: 500;
}
.section-list,
.stored-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.section-list > li:last-child :deep(.dash-card) { border-bottom: 0; }
.section-loading { padding: 8px 0; }
.row-skeleton {
  display: grid;
  grid-template-columns: 32px 1fr;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.row-skeleton:last-child { border-bottom: 0; }
.row-skeleton-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stored-list > li + li { border-top: 1px solid var(--border); }
.stored-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 46px;
  padding: 7px 16px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.stored-row:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.stored-row-dead {
  opacity: 0.45;
  cursor: not-allowed;
}
.stored-icon {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 20px !important;
}
/* stored-avatar —— 「最近访问」用真实空间头像替代通用 history icon;
 * 跟 .ms-row 的 SpaceAvatar 同 size=22 节奏对齐,让两个 section 的
 * row 视觉权重一致。flex-shrink: 0 防止被 title 截断挤压。*/
.stored-avatar {
  flex-shrink: 0;
}
.stored-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
}
.stored-meta {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 12px;
}

/* ─── P1-9 · PersonalHomeView 分组 + 折叠 ────────────────────────────
 * 把原 6 个 section 拆成 2 个 .personal-group:
 *   - personal-group-primary:"今天该看" — 3 个 section 单列全宽,常驻展开。
 *   - personal-group-secondary:"浏览与身份" — 3 个 section 2 列子网
 *     格,外层一键折叠。
 *
 * 主分组单列而不是 2 列,是因为「今天该看」的 row 含 DashboardCard
 * (variant=mention,含未读 chip + 时间线),跨 2 列会被切成两半;
 * 居中长 list 体验也更好。次级分组 task 是「要不要点开看一眼」,信
 * 息密度高,2 列更紧凑。
 */
.personal-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.personal-group-primary {
  grid-column: 1 / -1;
}
.personal-group-secondary {
  /* 占 2 列网格里的整行,里面用 .personal-sections-secondary 子网格
   * 再拆成 2 列,跟原 2 列布局视觉同款。grid-column: 1/-1 让
   * .personal-sections 父容器始终把 secondary group 排到下一行。*/
  grid-column: 1 / -1;
}
.personal-group-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 0;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.personal-group-label .material-symbols-outlined {
  font-size: 16px !important;
  color: var(--accent);
}

/* 次级分组折叠按钮 —— 跟 sidebar section header 同款结构:icon + 文
 * 字 + meta 靠左,chevron 贴右。一键展开/收起整组,默认折叠。视觉跟
 * 主分组的 section 卡片边框/底色区分:无边框,只是带分组说明 + chevron
 * 的 row,跟下面的卡片留出明确层次。*/
.personal-group-toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.personal-group-toggle:hover {
  background: var(--bg-subtle);
  border-color: var(--border-strong);
}
.personal-group-toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
.personal-group-toggle-label .material-symbols-outlined {
  font-size: 18px !important;
  color: var(--text-2);
}
.personal-group-toggle-meta {
  color: var(--text-3);
  font-size: 12px;
  font-weight: 500;
}
.personal-group-secondary > .personal-group-toggle .section-chevron {
  margin-left: 4px;
}

/* 次级分组展开后的子网格 —— 跟原 .personal-sections 视觉一致
 * (2 列 + 16-24px gap),只是去掉了第一行的对齐要求。*/
.personal-sections-secondary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

/* section-toggle-row —— header 行变 button 让整行可点:chevron 在
 * 末尾,默认 0°(展开)→ 折叠时 -90°,跟 SidebarSectionHeader 同款。*/
.section-toggle-row { padding: 0; border-bottom: 1px solid var(--border); }
.section-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 11px 16px;
  background: transparent;
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.section-toggle:hover { background: var(--bg-subtle); }
.section-toggle:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.section-toggle .section-title {
  flex: 1;
  min-width: 0;
}
.section-chevron {
  flex-shrink: 0;
  font-size: 18px !important;
  color: var(--text-3);
  transition: transform var(--duration-fast) var(--ease-out);
}
.section-chevron.chevron-collapsed { transform: rotate(-90deg); }

/* section-body —— 折叠切换真正控制渲染对象。v-show 是 hide-only,
 * 不销毁 v-if 下的 children,避免每次展开重新跑 DashboardCard
 * 的 mount 逻辑。空 padding 让 .personal-section 边框保持原视觉
 * (row 内容贴着 section 底边时 border 不会凸显)。*/
.section-body { padding: 0; }

/* ─── 模块 1 P1 · 共享空间与角色 ─────────────────────────────────────
 * section 复用 .personal-section 卡片样式(统一边框 / 阴影 / hover 行为),
 * 放在 .personal-sections 2 列网格的第一个 cell 里 —— 跟 @提及我并列。
 * 之所以进 2 列网格:共享空间行数通常很少(普通用户 1-5 个),全宽 row
 * 会让每行 ~1100px 跑一两个字段,显空。半宽 cell ≈ 580px,row 紧凑更
 * 符合信息密度。
 *
 * row 用 flex 而非 grid:5 个元素(avatar / name / sub / role / enter)
 * 边界规则不一致(grid-template-columns 难写),flex + 1fr-spacer 让
 * role pill + enter 始终靠右、name 截断发生在剩余空间里。role pill 是
 * 纯文字 + icon + 配色,无背景填充 —— CLAUDE.md 「read-only roles are
 * not buttons」硬约束:role 是信息,不是可点 chip。配色跟 SpaceMembersTab
 * 的 .smt-role-{admin|editor|viewer} 完全一致,但**不抽公共组件**
 * —— 跨视图共享样式约定改用「视觉对齐」而非「共享 class」。*/
.shared-spaces-section .section-icon {
  color: var(--accent);
}
.ms-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ms-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  transition: background var(--duration-fast) var(--ease-out);
}
.ms-row:last-child { border-bottom: 0; }
.ms-row:hover { background: var(--bg-canvas); }

/* 归档行视觉降级 —— 跟 SpaceSwitcher 的 ss-menu-item-archived 同节奏
 * (opacity 0.65),不阻塞 hover 高亮(hover 时透明度自动回到 1 让用户
 * 看见这是「可点」,只是内容是历史快照)。*/
.ms-row-archived {
  opacity: 0.65;
}
.ms-row-archived:hover {
  opacity: 1;
}

.ms-row-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.ms-row-sub {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.3;
}
.ms-row-sub-icon {
  font-size: 12px !important;
  color: inherit;
  line-height: 1;
}

/* spacer —— 让 name/sub 跟右侧 role+enter 之间留一段弹性空白,
 * name 截断时不会贴着 role pill。min-width: 0 防止 flex 子项内容撑破。*/
.ms-spacer {
  flex: 1;
  min-width: 0;
}

/* role pill —— text + icon,无背景,跟 SpaceMembersTab smt-role-value 视觉一致 */
.ms-role {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
.ms-role-icon {
  font-size: 14px !important;
  line-height: 1;
}
.ms-role-admin { color: var(--accent); }
.ms-role-editor { color: var(--text-2); }
.ms-role-viewer { color: var(--text-3); }
.ms-role-none { color: var(--text-3); font-style: italic; }

/* 进入按钮 —— icon-only(arrow_forward),跟其他 list-row 的右箭头节奏
 * 一致(不显「进入空间」文字,让 row 更紧凑)。hover 给 accent-soft。*/
.ms-enter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.ms-enter:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.ms-enter .material-symbols-outlined {
  font-size: 16px !important;
  line-height: 1;
}
</style>
