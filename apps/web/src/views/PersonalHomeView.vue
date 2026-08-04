<script setup lang="ts">
/**
 * 个人工作台:每个用户登录后的主页。
 *
 * layout 6 个 section 重排为「主区 + 次区 2 列」结构(plan §3.1):
 *   - 主区:从 mentions / created / personalSpace / watched / recent 按优先级
 *     取第一个非空 section,整段渲染;其他 section 走次区
 *   - 次区:2 列 grid,其他 sections 用 DashboardCard `variant="compact"` 紧凑行
 *
 * 顶部多了一条「快速操作条」(plan §3.2):3 个圆形大 tile(快速新建 / 快速导入
 * / 个人空间)+ 1 个「今日待办」计数卡(读 mentions)。
 *
 * 「我创建的」改为按空间分组(plan §3.3):每组带头 + 折叠态走 uiStore,跟
 * Sidebar 的页面树折叠复用 `PERSIST_KEYS.SIDEBAR_SECTIONS`。
 *
 * 「最近访问」加常读频次 star badge(plan §3.4):`useRecentPages.visits >= 3`
 * 显示 star,tooltip 写「访问过 N 次」(store 当前是 upsert 历史 timeline 不可
 * 用,「N 次」近似「终生累计」≥ 3 —— 见 useRecentPages.ts 文档)。
 *
 * 全部 section 空态合并为单张「待办卡」(plan §3.5):建第一页 / 浏览空间 /
 * 邀请队友(按角色动态)— 只在 mainSection === null 时显示。
 *
 * ─── 模块 1 P1 · 共享空间与角色 ─────────────────────────────────────
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
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DashboardCard from '@/components/page/DashboardCard.vue'
import QuickActionTile from '@/components/page/QuickActionTile.vue'
import CreatedPageGroup from '@/components/page/CreatedPageGroup.vue'
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
  const spaceId = entry.spaceId ?? page?.spaceId ?? null
  return {
    id: entry.id,
    title: page?.title || entry.title,
    spaceId,
    timestamp: entry.visitedAt,
    alive: !!page && !page.deletedAt,
  }
}))

/* frequentIds —— plan §3.4:把「最近访问」里 visits >= 3 的页 id 收成 Set,
   给 row 右侧打常读频次 star。阈值 3 是「常读」粗略口径,跟 store
   visits 字段的"终生累计"语义对齐(非 "7 天内",见 useRecentPages
   文档说明)。visitedAt 没动 —— visits 是独立频率维度。*/
const frequentIds = computed<Set<string>>(() => {
  const set = new Set<string>()
  for (const entry of recentList.value) {
    if ((entry.visits ?? 0) >= 3) set.add(entry.id)
  }
  return set
})

const personalSpaceName = computed(() => personalSpace.value?.name ?? '个人空间')
const personalSpaceColor = computed(() => personalSpace.value?.color ?? 'var(--text-3)')

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
  document.getElementById('section-drafts')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function goToSpace(space: Space): void {
  spacesStore.setActiveSpace(space.id)
  if (router.currentRoute.value.path !== '/') {
    void router.push('/')
  }
}

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

const isAdminUser = computed(() => auth.user?.role === 'admin')

const sharedSpacesMeta = computed(() => {
  const total = sharedSpacesRows.value.length
  if (!isAdminUser.value) return `共 ${total} 个`
  const archived = sharedSpacesRows.value.filter((s) => !!s.archivedAt).length
  if (archived === 0) return `共 ${total} 个`
  return `共 ${total} 个 · 已归档 ${archived} 个`
})

function spaceSubLabel(space: Space): { icon: string; text: string } | null {
  if (space.archivedAt) return { icon: 'inventory_2', text: '已归档 · 归档后只读' }
  return null
}

function ensurePageLoaded(page: PageNode): void {
  if (pagesStore.getPage(page.id)) return
  void pagesStore.ensureAncestorsLoaded(page.id)
}

function recentSpaceById(spaceId: string | null): Space | null {
  if (!spaceId) return null
  return spaceById.value.get(spaceId) ?? null
}

function relativeTime(timestamp: number): string {
  return formatRelativeTime(timestamp)
}

/* ─── 模块 3 P1/P2 · 主区/次区 + 顶部快速条 + 分组 + 空态合并 ───── */

/* profileStats —— cover 右侧 6 格 stats 面板的渲染源。每格是「数字 + icon +
 * label」的小 tile,从已有 payload / store / recentItems 派生,无新增 fetch。
 * `alert=true` 用来给 mentions > 0 这格加 danger 色,提示用户优先处理。
 * 顺序按"对用户而言的优先级":未读 → 创建 → 关注 → 草稿 → 团队 → 近期。*/
const profileStats = computed<Array<{ key: string; icon: string; value: number; label: string; alert?: boolean }>>(() => {
  const mentions = payload.value?.mentions.length ?? 0
  const created = payload.value?.created.length ?? 0
  const watched = payload.value?.watched.length ?? 0
  const drafts = payload.value?.personalSpace.length ?? 0
  const teams = sharedSpacesRows.value.length
  const recent = recentItems.value.length
  return [
    { key: 'mentions', icon: 'alternate_email', value: mentions, label: '未读提到', alert: mentions > 0 },
    { key: 'created',   icon: 'edit_note',       value: created,  label: '我创建的' },
    { key: 'watched',   icon: 'notifications_active', value: watched, label: '我关注的' },
    { key: 'drafts',    icon: 'lock_person',     value: drafts,   label: '个人草稿' },
    { key: 'teams',     icon: 'workspaces',      value: teams,    label: '加入团队' },
    { key: 'recent',    icon: 'history',         value: recent,   label: '近期访问' },
  ]
})

/* profilePulse —— cover 中部「最近活动」timeline 的渲染源。合并 created +
 * personalSpace + recentItems,按 timestamp desc 取 3 条。无 fetch,纯派生。
 * 用于填充 2560 视口下 cover 的中部留白,让 cover 视觉权重均衡。*/
const pulseItems = computed<Array<{ id: string; title: string; timestamp: number; icon: string }>>(() => {
  const seen = new Set<string>()
  const merged: Array<{ id: string; title: string; timestamp: number; icon: string }> = []
  const push = (id: string, title: string, timestamp: number, icon: string) => {
    if (seen.has(id)) return
    seen.add(id)
    merged.push({ id, title, timestamp, icon })
  }
  for (const page of payload.value?.created ?? []) {
    push(page.id, page.title, page.updatedAt, page.icon || 'description')
  }
  for (const page of payload.value?.personalSpace ?? []) {
    push(page.id, page.title, page.updatedAt, page.icon || 'lock_person')
  }
  for (const entry of recentItems.value) {
    push(entry.id, entry.title, entry.timestamp, 'history')
  }
  merged.sort((a, b) => b.timestamp - a.timestamp)
  return merged.slice(0, 3)
})

/* pulseDateLabel —— cover 中部 timeline 头部的"今天"日期标签,纯展示。*/
const pulseDateLabel = computed(() => {
  const d = new Date()
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${y}年${m}月${day}日 · 周${wd}`
})

/* profileMeta —— identity 右侧/下方的次要元信息块,填充左侧身份列纵向。
   · role chip:admin / 团队成员(走 ms-role-* 同款配色,但 chip 而非 row)
   · joined:注册时间 → "加入 X 个月前"
   · last:最近登录 → "X 前登录"
   让 cover 在 2560 视口下左列有足够视觉重量,平衡右侧 stats panel。*/
const profileMeta = computed(() => {
  const user = auth.user
  if (!user) return null
  const now = Date.now()
  const daysSinceJoin = Math.max(0, Math.floor((now - user.createdAt) / 86_400_000))
  const joinedLabel = daysSinceJoin < 30
    ? `${daysSinceJoin} 天前加入`
    : daysSinceJoin < 365
      ? `${Math.floor(daysSinceJoin / 30)} 个月前加入`
      : `${Math.floor(daysSinceJoin / 365)} 年前加入`
  let lastLabel: string | null = null
  if (user.lastLoginAt) {
    const sec = Math.max(0, Math.floor((now - user.lastLoginAt) / 1000))
    lastLabel = sec < 60
      ? '刚刚登录'
      : sec < 3600
        ? `${Math.floor(sec / 60)} 分钟前登录`
        : sec < 86_400
          ? `${Math.floor(sec / 3600)} 小时前登录`
          : `${Math.floor(sec / 86_400)} 天前登录`
  }
  return {
    roleLabel: user.role === 'admin' ? '管理员' : '团队成员',
    roleIcon: user.role === 'admin' ? 'shield_person' : 'badge',
    joinedLabel,
    lastLabel,
  }
})

/* wriableSharedSpaces —— 「快速新建」选取目标空间时的候选列表。
 * 用户的第一个 shared space(按 store 顺序,字母序靠前的优先);没 shared 时
 * 退到个人空间(已有 canCreatePersonalPage 把握可写)。disabled 决策:
 * 个人空间可写 → 任何时候可建;shared 全只读 + 个人只读 → 整体禁用。*/
const writableSharedSpace = computed<Space | null>(() => {
  return spacesStore.spaces.value.find((space) =>
    space.kind === 'shared'
    && !space.archivedAt
    && canCreateInSpaceOf(auth.user, space),
  ) ?? null
})
const canQuickCreate = computed(() =>
  canCreatePersonalPage.value || writableSharedSpace.value !== null,
)

/* mainSection —— 主区渲染源。优先级:mentions > created > personalSpace >
 * watched > recent > shared(spaces)。返回 { kind, items } 或 null —— null
 * 时走 plan §3.5 todo card。 */
type SectionKind = 'mentions' | 'created' | 'personalSpace' | 'watched' | 'recent' | 'shared'
interface MainSection {
  kind: SectionKind
  items: unknown[]
}
const mainSection = computed<MainSection | null>(() => {
  if (!payload.value) return null
  if (hasMentions.value) return { kind: 'mentions', items: payload.value.mentions }
  if (hasCreated.value) return { kind: 'created', items: payload.value.created }
  if (hasPersonalSpace.value) return { kind: 'personalSpace', items: payload.value.personalSpace }
  if (hasWatched.value) return { kind: 'watched', items: watchedPages.value }
  if (recentItems.value.length > 0) return { kind: 'recent', items: recentItems.value }
  if (sharedSpacesRows.value.length > 0) return { kind: 'shared', items: sharedSpacesRows.value }
  return null
})

/* secondarySections —— 次区渲染源。跟 mainSection 不重复,顺序按「对用户而言
 * 的重要度」:cross-section → cross-space 活动。空 section 跳过。*/
const SECONDARY_ORDER: SectionKind[] = ['mentions', 'created', 'personalSpace', 'watched', 'recent', 'shared']
const secondarySections = computed<SectionKind[]>(() => {
  if (!mainSection.value) return []
  return SECONDARY_ORDER.filter((kind) => kind !== mainSection.value!.kind && sectionHasItems(kind))
})

function sectionHasItems(kind: SectionKind): boolean {
  switch (kind) {
    case 'mentions': return hasMentions.value
    case 'created': return hasCreated.value
    case 'personalSpace': return hasPersonalSpace.value
    case 'watched': return hasWatched.value
    case 'recent': return recentItems.value.length > 0
    case 'shared': return sharedSpacesRows.value.length > 0
  }
}

/* createdBySpace —— plan §3.3 "我创建的"按空间分组。组内 updatedAt desc,
 * 组按组的最新 page desc(让最近的组靠前),只显示还有页的组。groupPages
 * 不止用于分组内,也用于次区卡片中「我创建的」的渲染源。*/
interface CreatedGroup {
  spaceId: string
  space: Space | null
  pages: PageNode[]
}
const createdBySpace = computed<CreatedGroup[]>(() => {
  const groups = new Map<string, CreatedGroup>()
  for (const page of payload.value?.created ?? []) {
    let group = groups.get(page.spaceId)
    if (!group) {
      group = {
        spaceId: page.spaceId,
        space: spaceById.value.get(page.spaceId) ?? null,
        pages: [],
      }
      groups.set(page.spaceId, group)
    }
    group.pages.push(page)
  }
  const list = Array.from(groups.values()).map((g) => ({
    ...g,
    pages: g.pages.slice().sort((a, b) => b.updatedAt - a.updatedAt),
  }))
  list.sort((a, b) => {
    const aTop = a.pages[0]?.updatedAt ?? 0
    const bTop = b.pages[0]?.updatedAt ?? 0
    return bTop - aTop
  })
  return list
})

/* handlers — 顶部快速操作条 3 个 tile + 反向 "在管理后台邀请" 跳路由 */
async function quickCreatePage(): Promise<void> {
  const target = writableSharedSpace.value ?? personalSpace.value
  if (!target) return
  if (!canCreateInSpaceOf(auth.user, target)) return
  spacesStore.setActiveSpace(target.id)
  const id = newId()
  void router.push(`/p/${id}/edit`)
  try {
    await pagesStore.createPage({ id, parentId: null, spaceId: target.id })
  } catch {
    // store surfaces errors
  }
}

function quickImport(): void {
  /* ImportMarkdownModal 的 PathPicker 默认值用个人空间 id(target = 用户
   * 私有空间,导入新页一般先在自己的空间里起草);没个人空间时 fallback 到
   * 空字符串,modal 内部会从 spacesStore 选默认 active。*/
  const sid = personalSpace.value?.id ?? ''
  uiStore.openImport({ defaultSpaceId: sid })
}

function quickPersonalSpace(): void {
  const space = personalSpace.value
  if (!space) return
  spacesStore.setActiveSpace(space.id)
  if (router.currentRoute.value.path !== '/') {
    void router.push('/')
  }
}

function goActiveSpaceHome(): void {
  /* 回到当前 active space 的首页(/ 路由渲染 SpaceHomeView);
   * 如果 active space 没有设置,自动挑第一个 shared,没 shared 才退 personal。
   * 不提前预加载 pages roots:`/` 路由挂载时自己拉,避免双跳抖动。*/
  if (router.currentRoute.value.path !== '/') {
    void router.push('/')
  }
}

function goManagerHome(): void {
  void router.push('/manager')
}

function goManagerUsers(): void {
  void router.push('/manager/users')
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
        <div class="profile-identity">
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
            <!-- identity 纵向填充块:role chip + 注册时间 + 上次登录 —
                 跟 .ms-role-* 同款配色对齐,平衡右侧 stats panel 的视觉重量,
                 让 cover 左列在 2560 视口下不再过松。-->
            <div v-if="profileMeta" class="profile-meta">
              <span class="profile-role-chip" :class="`profile-role-${auth.user?.role ?? 'user'}`">
                <span class="material-symbols-outlined">{{ profileMeta.roleIcon }}</span>
                {{ profileMeta.roleLabel }}
              </span>
              <span class="profile-meta-item">
                <span class="material-symbols-outlined">how_to_reg</span>
                {{ profileMeta.joinedLabel }}
              </span>
              <span v-if="profileMeta.lastLabel" class="profile-meta-item">
                <span class="material-symbols-outlined">schedule</span>
                {{ profileMeta.lastLabel }}
              </span>
            </div>
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
        </div>
        <!-- 2560x1440 下 cover 左侧身份块只占 ~480px,中间大量留白。
             cover 改成 3 列布局:identity | center pulse | stats panel,
             让 cover 在 2560 宽下视觉上撑满。
             · identity:头像 + 名字 + 邮箱 + bio + 草稿入口(不变)
             · center pulse:取 created + personalSpace + recent 合并、按
               updatedAt desc 取最近 3 条,每条显示「icon + 标题 + 时间」,
               作为「最近活动」一行式 timeline。无 fetch,纯前端派生。
             · stats panel:6 格 stats tile(3 列 × 2 行),数字 + icon +
               label,mention > 0 走 alert 配色。-->
        <div class="profile-pulse" aria-label="最近活动">
          <div class="profile-pulse-head">
            <span class="profile-pulse-eyebrow">最近活动</span>
            <span class="profile-pulse-date">{{ pulseDateLabel }}</span>
          </div>
          <ul v-if="pulseItems.length > 0" class="profile-pulse-list">
            <li
              v-for="entry in pulseItems"
              :key="entry.id"
              class="profile-pulse-row"
              role="button"
              tabindex="0"
              @click="openPage(entry.id)"
              @keydown.enter="openPage(entry.id)"
              @keydown.space.prevent="openPage(entry.id)"
            >
              <span class="material-symbols-outlined profile-pulse-icon">{{ entry.icon }}</span>
              <span class="profile-pulse-title" :title="entry.title">{{ entry.title }}</span>
              <span class="profile-pulse-time">{{ relativeTime(entry.timestamp) }}</span>
            </li>
          </ul>
          <p v-else class="profile-pulse-empty">
            今天还没有动态 — 浏览空间 / 创建第一页试试
          </p>
        </div>
        <div class="profile-stats" aria-label="工作台统计">
          <div
            v-for="stat in profileStats"
            :key="stat.key"
            class="stat-tile"
            :class="{ 'stat-tile-alert': stat.alert }"
          >
            <span class="stat-tile-icon material-symbols-outlined">{{ stat.icon }}</span>
            <span class="stat-tile-value">{{ stat.value }}</span>
            <span class="stat-tile-label">{{ stat.label }}</span>
          </div>
        </div>
      </header>

      <!-- ─── 3.2 P1 · 顶部快速操作条 ─────────────────────────────
           2560 视口下旧的 3-tile + 1-todo 排版过于"左聚右散"。
           改为 5 个均匀分布的圆形大 tile:快速新建 / 快速导入 / 个人空间 /
           团队首页(回家) / 管理后台(admin 专属)。todo 卡信息挪到 cover
           stats panel 的「未读提到」格,这里只承载"做点啥"的入口。-->
      <div class="quick-action-strip">
        <QuickActionTile
          icon="note_add"
          label="快速新建"
          title="在第一个可写空间创建新页"
          :disabled="!canQuickCreate"
          @click="quickCreatePage"
        />
        <QuickActionTile
          icon="upload_file"
          label="快速导入"
          title="从 Markdown 文件创建新页"
          @click="quickImport"
        />
        <QuickActionTile
          icon="cottage"
          label="个人空间"
          title="进入你的个人空间首页"
          :disabled="!personalSpace"
          @click="quickPersonalSpace"
        />
        <QuickActionTile
          icon="home"
          label="团队首页"
          title="回到当前活跃的团队空间首页"
          @click="goActiveSpaceHome"
        />
        <QuickActionTile
          v-if="isAdminUser"
          icon="admin_panel_settings"
          label="管理后台"
          title="进入管理后台"
          @click="goManagerHome"
        />
      </div>

      <div v-if="error" class="personal-home-error">
        <span class="material-symbols-outlined">error</span>
        <span>{{ error }}</span>
        <button class="link-btn" type="button" @click="load">重试</button>
      </div>

      <!-- ─── 3.1 P1 · 主区 + 次区 2 列结构 ──────────────────────
           mainSection 拿到的是"第一个非空 section",优先 mentions → created →
           personalSpace → watched → recent → shared。拿不到就走 §3.5 todo 卡。
           次区是剩余 sections,每格用 DashboardCard 'compact'(单行紧凑)。-->
      <template v-if="mainSection">
        <div class="personal-layout">
          <section class="personal-main personal-section">
            <template v-if="mainSection.kind === 'shared'">
              <header class="section-head">
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon">workspaces</span>
                  共享空间与角色
                </h2>
                <span class="section-meta">{{ sharedSpacesMeta }}</span>
              </header>
              <ul class="ms-list">
                <li
                  v-for="space in sharedSpacesRows"
                  :key="space.id"
                  class="ms-row"
                  :class="{ 'ms-row-archived': !!space.archivedAt }"
                >
                  <SpaceAvatar :space="space" :size="20" />
                  <span class="ms-row-name">{{ space.name }}</span>
                  <span v-if="spaceSubLabel(space)" class="ms-row-sub">
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
            </template>

            <template v-else-if="mainSection.kind === 'mentions'">
              <header class="section-head">
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon mention-icon">alternate_email</span>
                  @提到我
                </h2>
                <span class="section-meta">{{ payload!.mentions.length }} 条未读</span>
              </header>
              <ul class="section-list">
                <li v-for="notification in payload!.mentions" :key="notification.id">
                  <DashboardCard
                    variant="mention"
                    :notification="notification"
                    @open-mention="(pageId, commentId) => openMention(pageId, commentId)"
                  />
                </li>
              </ul>
            </template>

            <template v-else-if="mainSection.kind === 'recent'">
              <header class="section-head">
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon">history</span>
                  最近访问
                </h2>
                <span class="section-meta">{{ recentItems.length }} 个</span>
              </header>
              <ul class="stored-list">
                <li v-for="item in recentItems" :key="item.id">
                  <button
                    type="button"
                    class="stored-row"
                    :class="{ 'stored-row-dead': !item.alive, 'stored-row-frequent': frequentIds.has(item.id) }"
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
                    <span
                      v-if="frequentIds.has(item.id)"
                      class="material-symbols-outlined recent-star"
                      :title="`常读 · 访问过 ${recentList.find((e) => e.id === item.id)?.visits ?? 0} 次`"
                      aria-label="常读"
                    >star</span>
                  </button>
                </li>
              </ul>
            </template>

            <template v-else-if="mainSection.kind === 'created'">
              <header class="section-head">
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon">edit_note</span>
                  我创建的
                </h2>
                <span class="section-meta">最近 {{ payload!.created.length }} 个 · {{ createdBySpace.length }} 个空间</span>
              </header>
              <ul class="cpg-wrap">
                <li v-for="group in createdBySpace" :key="group.spaceId">
                  <CreatedPageGroup
                    :space="group.space"
                    :space-name="describeSpace(group.spaceId).name"
                    :pages="group.pages"
                    @open-page="openPage"
                    @prefetch="ensurePageLoaded"
                  />
                </li>
              </ul>
            </template>

            <template v-else-if="mainSection.kind === 'personalSpace'">
              <header class="section-head">
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon personal-space-icon">lock_person</span>
                  我在个人空间起草的
                </h2>
                <span class="section-meta">最近 {{ payload!.personalSpace.length }} 个</span>
              </header>
              <ul class="section-list">
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
            </template>

            <template v-else-if="mainSection.kind === 'watched'">
              <header class="section-head">
                <h2 class="section-title">
                  <span class="material-symbols-outlined section-icon watched-icon">notifications_active</span>
                  我关注的页面
                </h2>
                <span class="section-meta">最近 {{ watchedPages.length }} 个</span>
              </header>
              <ul class="section-list">
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
            </template>
          </section>

          <!-- ─── 次区(2 列 grid,compact variant) ───────────────────── -->
          <div v-if="secondarySections.length > 0" class="personal-secondary">
            <section
              v-for="kind in secondarySections"
              :key="kind"
              :id="`section-${kind}`"
              class="personal-section"
            >
              <template v-if="kind === 'shared'">
                <header class="section-head">
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon">workspaces</span>
                    共享空间与角色
                  </h2>
                  <span class="section-meta">{{ sharedSpacesMeta }}</span>
                </header>
                <ul class="section-list compact-list">
                  <li v-for="space in sharedSpacesRows.slice(0, 5)" :key="space.id" class="compact-row">
                    <SpaceAvatar :space="space" :size="16" class="compact-space-avatar" />
                    <span class="compact-row-name">{{ space.name }}</span>
                    <span
                      v-if="space.viewerRole"
                      class="compact-row-role"
                      :class="`ms-role-${space.viewerRole}`"
                    >
                      <span class="material-symbols-outlined">{{ ROLE_INFO[space.viewerRole].icon }}</span>
                      {{ ROLE_INFO[space.viewerRole].label }}
                    </span>
                    <button
                      type="button"
                      class="compact-row-enter"
                      :title="`进入「${space.name}」`"
                      @click="goToSpace(space)"
                    >
                      <span class="material-symbols-outlined">arrow_forward</span>
                    </button>
                  </li>
                </ul>
              </template>

              <template v-else-if="kind === 'mentions'">
                <header class="section-head">
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon mention-icon">alternate_email</span>
                    @提到我
                  </h2>
                  <span class="section-meta">{{ payload!.mentions.length }} 条未读</span>
                </header>
                <!-- mention row 用 inline 模板代替 DashboardCard:页面对象可能不在
                     payload.created / personalSpace 里(DashboardCard 需要
                     PageNode-shaped 字段构造完整),改走 直接 emit openMention,
                     渲染 chip = actor 名字,时间 = 通知 createdAt。 -->
                <ul class="mention-compact-list">
                  <li
                    v-for="notification in payload!.mentions.slice(0, 4)"
                    :key="notification.id"
                    class="mention-compact-row"
                    role="button"
                    tabindex="0"
                    @click="openMention(notification.pageId, notification.commentId ?? null)"
                    @keydown.enter="openMention(notification.pageId, notification.commentId ?? null)"
                    @keydown.space.prevent="openMention(notification.pageId, notification.commentId ?? null)"
                  >
                    <span class="mention-compact-actor">{{ notification.actorName ?? '(已删除用户)' }}</span>
                    <UserAvatar
                      :size="20"
                      :label="notification.actorName ?? '?'"
                      :color="notification.actorColor ?? undefined"
                      :avatar-kind="notification.actorAvatarKind ?? null"
                      :avatar-ref="notification.actorAvatarRef ?? null"
                      :user-id="notification.actorId ?? null"
                    />
                    <span class="mention-compact-title">{{ notification.pageTitle || '(无标题)' }}</span>
                    <span class="mention-compact-meta">{{ relativeTime(notification.createdAt) }}</span>
                  </li>
                </ul>
              </template>

              <template v-else-if="kind === 'created'">
                <header class="section-head">
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon">edit_note</span>
                    我创建的
                  </h2>
                  <span class="section-meta">{{ payload!.created.length }} 个 · {{ createdBySpace.length }} 个空间</span>
                </header>
                <ul class="cpg-wrap">
                  <li v-for="group in createdBySpace" :key="group.spaceId">
                    <CreatedPageGroup
                      :space="group.space"
                      :space-name="describeSpace(group.spaceId).name"
                      :pages="group.pages"
                      @open-page="openPage"
                      @prefetch="ensurePageLoaded"
                    />
                  </li>
                </ul>
              </template>

              <template v-else-if="kind === 'recent'">
                <header class="section-head">
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon">history</span>
                    最近访问
                  </h2>
                  <span class="section-meta">{{ recentItems.length }} 个</span>
                </header>
                <ul class="stored-list">
                  <li v-for="item in recentItems.slice(0, 5)" :key="item.id">
                    <button
                      type="button"
                      class="stored-row"
                      :class="{ 'stored-row-dead': !item.alive, 'stored-row-frequent': frequentIds.has(item.id) }"
                      :disabled="!item.alive"
                      @click="openStoredPage(item)"
                    >
                      <SpaceAvatar
                        v-if="recentSpaceById(item.spaceId)"
                        :space="recentSpaceById(item.spaceId)"
                        :size="16"
                        class="stored-avatar stored-avatar-sm"
                      />
                      <span v-else class="material-symbols-outlined stored-icon">history</span>
                      <span class="stored-title">{{ item.title }}</span>
                      <span class="stored-meta">{{ relativeTime(item.timestamp) }}</span>
                      <span
                        v-if="frequentIds.has(item.id)"
                        class="material-symbols-outlined recent-star"
                        :title="`常读 · 访问过 ${recentList.find((e) => e.id === item.id)?.visits ?? 0} 次`"
                        aria-label="常读"
                      >star</span>
                    </button>
                  </li>
                </ul>
              </template>

              <template v-else-if="kind === 'personalSpace'">
                <header class="section-head">
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon personal-space-icon">lock_person</span>
                    我在个人空间起草的
                  </h2>
                  <span class="section-meta">最近 {{ payload!.personalSpace.length }} 个</span>
                </header>
                <ul class="section-list">
                  <li
                    v-for="page in payload!.personalSpace"
                    :key="page.id"
                    @mouseenter="ensurePageLoaded(page)"
                  >
                    <DashboardCard
                      variant="compact"
                      :page="page"
                      :space-name="personalSpaceName"
                      :space-color="personalSpaceColor"
                      space-kind="personal"
                      @open-page="openPage"
                    />
                  </li>
                </ul>
              </template>

              <template v-else-if="kind === 'watched'">
                <header class="section-head">
                  <h2 class="section-title">
                    <span class="material-symbols-outlined section-icon watched-icon">notifications_active</span>
                    我关注的页面
                  </h2>
                  <span class="section-meta">最近 {{ watchedPages.length }} 个</span>
                </header>
                <ul class="section-list">
                  <li
                    v-for="page in watchedPages"
                    :key="page.id"
                    @mouseenter="ensurePageLoaded(page)"
                  >
                    <DashboardCard
                      variant="compact"
                      :page="page"
                      :space-name="describeSpace(page.spaceId).name"
                      :space-color="describeSpace(page.spaceId).color"
                      :space-kind="describeSpace(page.spaceId).kind"
                      @open-page="openPage"
                    />
                  </li>
                </ul>
              </template>
            </section>
          </div>
        </div>
      </template>

      <!-- ─── 3.5 P2 · 空态合并 todo 卡 ──────────────────────────────
           mainSection === null 时(新注册 / 数据全空)显示 3 CTA;
           admin 看邀请入口,普通用户看静态文案。背景跟 cover / strip
           节奏一致,居中布局让"接下来做什么"成为整页焦点。-->
      <div v-else class="personal-todo">
        <div class="todo-illustration" aria-hidden="true">
          <svg viewBox="0 0 200 140" width="200" height="140">
            <rect x="32" y="22" width="100" height="14" rx="3" fill="var(--accent-soft)" />
            <rect x="42" y="44" width="70" height="8" rx="2" fill="var(--bg-subtle)" />
            <rect x="42" y="58" width="86" height="8" rx="2" fill="var(--bg-subtle)" />
            <rect x="42" y="72" width="60" height="8" rx="2" fill="var(--bg-subtle)" />
            <rect x="120" y="14" width="60" height="80" rx="6" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5" />
            <rect x="132" y="26" width="36" height="6" rx="2" fill="var(--accent)" />
            <rect x="132" y="40" width="44" height="4" rx="2" fill="var(--border)" />
            <rect x="132" y="50" width="36" height="4" rx="2" fill="var(--border)" />
            <rect x="132" y="60" width="40" height="4" rx="2" fill="var(--border)" />
            <rect x="132" y="70" width="32" height="4" rx="2" fill="var(--border)" />
            <circle cx="152" cy="106" r="18" fill="var(--accent)" />
            <path d="M 144 106 L 150 112 L 160 100" stroke="var(--bg)" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <h2 class="todo-title">开始使用你的工作台</h2>
        <p class="todo-lead">
          建第一个页面开始记录想法、邀请队友共建空间,或者先到处看看。
        </p>
        <div class="todo-grid">
          <article class="todo-card">
            <span class="material-symbols-outlined todo-card-icon">note_add</span>
            <h3 class="todo-card-title">建第一页</h3>
            <p class="todo-card-desc">在个人空间起草一份草稿,稍后再决定放到哪个团队空间。</p>
            <button
              type="button"
              class="btn primary todo-card-cta"
              :disabled="!canCreatePersonalPage"
              :title="canCreatePersonalPage ? '在个人空间创建新页' : '你在此空间只有只读权限,无法创建新页'"
              @click="createPersonalPage"
            >
              在个人空间起草
            </button>
          </article>

          <article class="todo-card">
            <span class="material-symbols-outlined todo-card-icon">workspaces</span>
            <h3 class="todo-card-title">浏览空间</h3>
            <p v-if="sharedSpacesRows.length > 0" class="todo-card-desc">
              你已加入 {{ sharedSpacesRows.length }} 个团队空间,从空间首页开始。
            </p>
            <p v-else class="todo-card-desc">
              你还没加入任何团队空间。联系管理员把你加入,稍后再回来看看。
            </p>
            <button
              v-if="sharedSpacesRows.length > 0"
              type="button"
              class="btn ghost todo-card-cta"
              @click="router.push('/')"
            >
              查看共享空间
            </button>
            <span v-else class="todo-static-hint">
              <span class="material-symbols-outlined">hourglass_empty</span>
              暂无共享空间
            </span>
          </article>

          <article class="todo-card">
            <span class="material-symbols-outlined todo-card-icon">group_add</span>
            <h3 class="todo-card-title">{{ isAdminUser ? '邀请队友' : '等别人邀请你' }}</h3>
            <p v-if="isAdminUser" class="todo-card-desc">
              你有管理后台权限,可以直接邀请用户加入。
            </p>
            <p v-else class="todo-card-desc">
              等同事邀请你加入团队空间,本页内容会越来越丰富。
            </p>
            <button
              v-if="isAdminUser"
              type="button"
              class="btn ghost todo-card-cta"
              @click="goManagerUsers"
            >
              邀请用户
            </button>
            <span v-else class="todo-static-hint">
              <span class="material-symbols-outlined">hourglass_empty</span>
              暂无邀请
            </span>
          </article>
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
.profile-cover {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(360px, 520px) minmax(420px, 1fr);
  align-items: stretch;
  column-gap: 28px;
  padding: 22px 28px;
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
}
.profile-identity {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  column-gap: 24px;
  min-width: 0;
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

/* identity 纵向填充块 —— role chip + 注册时间 + 上次登录。
   role chip 走 ms-role-* 同款配色(纯信息显示,CLAUDE.md "read-only
   roles are not buttons"),让左列在 2560 视口下视觉重量跟右 stats 平衡。*/
.profile-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-top: 12px;
}
.profile-role-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.3;
}
.profile-role-chip .material-symbols-outlined {
  font-size: 14px !important;
  color: inherit;
}
.profile-role-admin {
  color: #6F2DBD;
  background: rgba(155, 89, 224, 0.12);
}
.profile-role-user {
  color: #1F66B5;
  background: rgba(76, 154, 255, 0.12);
}
.profile-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.profile-meta-item .material-symbols-outlined {
  font-size: 14px !important;
  color: var(--text-3);
}

/* cover 中部「最近活动」timeline —— 2560 视口下填 identity 与 stats panel
   之间的留白。每行 = icon + 标题 + 时间,3 行竖排;hover 时整体加 accent
   色;row 可点击(直接跳页面)。无 fetch,纯前端派生(从 created +
   personalSpace + recentItems 合并)。*/
.profile-pulse {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: 4px 8px 4px 24px;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
}
.profile-pulse-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.profile-pulse-eyebrow {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.profile-pulse-date {
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.profile-pulse-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.profile-pulse-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out);
}
.profile-pulse-row:hover,
.profile-pulse-row:focus-visible {
  background: var(--accent-soft);
  outline: 0;
}
.profile-pulse-icon {
  font-size: 16px !important;
  color: var(--text-2);
}
.profile-pulse-row:hover .profile-pulse-icon { color: var(--accent); }
.profile-pulse-title {
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.profile-pulse-time {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.profile-pulse-empty {
  margin: 0;
  padding: 8px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}

/* cover 右侧 stats panel —— 2560 视口填充横向留白。6 格 stats 走 6×1 单行
   grid(替代旧的 3×2 拥挤布局),每格 icon 居顶 + 数字 + label,横向排开
   视觉更松,匹配 cover 整体节奏。mention > 0 走 alert 配色(soft 背景
   + danger 文字)。*/
.profile-stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(64px, 1fr));
  grid-auto-rows: minmax(72px, auto);
  gap: 8px;
  align-self: stretch;
  align-content: center;
  min-width: 0;
}
.stat-tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: var(--radius-md);
  transition: background var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.stat-tile:hover {
  background: var(--accent-soft);
}
.stat-tile-icon {
  font-size: 18px !important;
  color: var(--text-2);
}
.stat-tile:hover .stat-tile-icon { color: var(--accent); }
.stat-tile-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.stat-tile-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  line-height: 1.2;
  letter-spacing: 0.02em;
}
/* mention > 0 走 alert 配色,提示用户优先处理。*/
.stat-tile-alert {
  background: var(--danger-soft, #FFEAE5);
}
.stat-tile-alert .stat-tile-icon { color: var(--danger); }
.stat-tile-alert .stat-tile-value { color: var(--danger); }

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

/* ─── 3.2 P1 · 顶部快速操作条 ─────────────────────────────────────── */
/* 5 tile 均匀分布:用 flex + space-evenly 让任意 tile 数(普通 4 / admin 5)
   都居中撑满 strip 横向。2560 视口下,5 tile 之间间距约 400px,刚好让
   每个 tile 中心对齐到 5 等分点 — 这是 Confluence / Notion 仪表盘常用的
   横向节奏。 */
.quick-action-strip {
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  gap: 16px;
  padding: 18px 24px;
  margin-bottom: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
}

/* ─── 3.1 P1 · 主区 + 次区 2 列结构 ───────────────────────────── */
.personal-layout {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.personal-main,
.personal-section {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  scroll-margin-top: calc(var(--topbar-h) + var(--sub-h) + var(--space-4));
}
.personal-main { min-width: 0; }
.personal-secondary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  grid-auto-rows: min-content;
  /* 让 personal-secondary 自适应,不会因内容不齐导致行高错位 */
  align-content: start;
}
.personal-secondary .personal-section { min-width: 0; }

/* 当窄屏(主区 1280px 视口大但 todo 卡要撑满) —— 不改 grid,大屏优先。*/

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
/* 3.4 P2 · 「常读」频次 badge —— visits >= 3 的 row 在右侧加 star,
   视觉上跟纯灰色 row 区分但不抢眼。2026-08-04 优化:之前是 14px 平面图标
   在 2560 视口下太小容易扫不到,加 warning-soft 圆形底 + 16px 字号 +
   1px ring + drop-shadow,让"这是你的常读页"信号能穿过 row 列表。*/
.stored-row-frequent .recent-star { opacity: 1; }
.recent-star {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 16px !important;
  color: var(--warning);
  background: var(--warning-soft, #FFF4DC);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(217, 119, 6, 0.25),
    0 1px 2px rgba(217, 119, 6, 0.18);
  margin-left: 6px;
  line-height: 1;
}
.recent-star::before {
  /* 把 material icon 居中,避免 baseline 偏移 */
  display: inline-block;
}
.stored-icon {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 20px !important;
}
.stored-avatar {
  flex-shrink: 0;
}
/* compact 模式(次区 stored-row)avatar 缩到 16,跟 row 整体高度协调 */
.stored-avatar-sm { transform: scale(0.8); transform-origin: left center; }
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

/* ─── 模块 1 P1 · 共享空间与角色 ───────────────────────────────────── */
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
.ms-spacer {
  flex: 1;
  min-width: 0;
}
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

/* ─── 3.3 P1 · "我创建的" 分组 wrap ─────────────────────────── */
.cpg-wrap {
  list-style: none;
  margin: 0;
  padding: 0;
}
.cpg-wrap > li + li {
  border-top: 1px solid var(--border);
}

/* ─── 3.1 P1 · 次区 compact(shared) row 紧凑渲染 ─────────────── */
.compact-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.compact-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  transition: background var(--duration-fast) var(--ease-out);
}
.compact-row:last-child { border-bottom: 0; }
.compact-row:hover { background: var(--bg-subtle); }
.compact-space-avatar { flex-shrink: 0; }
.compact-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
}
.compact-row-role {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  font-weight: 500;
  flex-shrink: 0;
}
.compact-row-role .material-symbols-outlined {
  font-size: 13px !important;
  line-height: 1;
}
.compact-row-enter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.compact-row-enter:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.compact-row-enter .material-symbols-outlined {
  font-size: 14px !important;
  line-height: 1;
}

/* ─── 3.1 P1 · 次区 compact(mentions)行 ─────────────────────────── */
.mention-compact-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.mention-compact-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.mention-compact-row:last-child { border-bottom: 0; }
.mention-compact-row:hover { background: var(--bg-subtle); }
.mention-compact-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.mention-compact-actor {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mention-compact-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
}
.mention-compact-meta {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* ─── 3.5 P2 · 空态合并 todo 卡 ────────────────────────────────── */
.personal-todo {
  max-width: 880px;
  margin: 16px auto 0;
  padding: 32px 8px 40px;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
}
.todo-illustration {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}
.todo-title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-1);
}
.todo-lead {
  margin: 0 0 24px;
  font-size: 14px;
  color: var(--text-2);
  line-height: 1.5;
}
.todo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  text-align: left;
}
.todo-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.todo-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}
.todo-card-icon {
  font-size: 28px;
  color: var(--accent);
  line-height: 1;
}
.todo-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}
.todo-card-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  margin: 0;
  flex: 1;
}
.todo-card-cta {
  align-self: flex-start;
  margin-top: 4px;
}
.todo-card-cta[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
}
.todo-static-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.todo-static-hint .material-symbols-outlined {
  font-size: 14px !important;
}
</style>
