<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { newId } from '@/lib/id'
import { ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import EmptyState from '@/components/ui/EmptyState.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import PageTree from './PageTree.vue'
import WatchedSidebar from './WatchedSidebar.vue'
import SidebarTopSection from './SidebarTopSection.vue'
import SidebarSectionHeader from './SidebarSectionHeader.vue'
import { canCreateInSpace as canCreateInSpaceOf } from '@/lib/permissions'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const authStore = useAuthStore()
const uiStore = useUiStore()
const router = useRouter()
const route = useRoute()

/**
 * Sidebar 自身 overflow-y: auto(styles/components.css:223),是侧栏的滚动
 * 容器。scrollTop 反映用户在侧栏里的浏览位置。
 *
 * 持久化:每个 space 各自记一份(uiStore.scrollBySpace),reload 后
 * 恢复;避免"我明明滚到 50% 看了很深的子树,刷新一下就回到顶"。
 */
const sidebarRef = ref<HTMLElement | null>(null)
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null
function onSidebarScroll() {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  scrollSaveTimer = setTimeout(() => {
    const sid = spacesStore.activeSpaceId.value
    const el = sidebarRef.value
    if (sid && el) uiStore.setSidebarScroll(sid, el.scrollTop)
  }, 200)
}

// Tree is scoped to the active space. Server already filters by accessibility
// but the local store holds pages from every accessible space — scoping the
// render keeps the sidebar clean.
const tree = computed(() => pagesStore.getTreeForSpace(spacesStore.activeSpaceId.value))

// P1-9: 加载中状态 —— 切空间时 `ensureRootsLoaded` 异步跑,期间 tree.length
// 是 0,跟真空态视觉冲突。`isRootsLoaded` 仍 false 时显示「加载中…」分支,
// 加载完成后才是真空态「还没有页面」。
const treeLoading = computed(() => {
  const id = spacesStore.activeSpaceId.value
  return id ? !pagesStore.isRootsLoaded(id) : false
})

const totalPages = computed(() => pagesStore.pages.length)

/**
 * 「此空间的页面」折叠态 —— 跟「此空间的关注」共用 uiStore 的 section 折叠
 * 机制(持久化到 localStorage)。默认**展开**:页面树是侧栏主导航,关注
 * 只是辅助列表,两者默认态不同是有意的。
 */
const PAGES_SECTION_KEY = 'pages'
const pagesCollapsed = computed(() => uiStore.isSectionCollapsed(PAGES_SECTION_KEY, false))

function togglePagesSection(): void {
  uiStore.toggleSection(PAGES_SECTION_KEY, false)
}

// Active-space quick-nav. Mirrors the topbar's SpaceSwitcher trigger but
// stays inside the sidebar so users get a "where am I" anchor that scrolls
// with the page. Replaces the old always-personal-space entry that was
// confusing when the active space was a shared space — the sidebar now
// always reflects the active space, full stop.
const active = computed(() => spacesStore.activeSpace.value)
const isActivePersonal = computed(() => active.value?.kind === 'personal')
const activePageCount = computed(() => {
  const id = active.value?.id
  if (!id) return 0
  // P1-9: 过滤 trashed 页(soft-deleted,deletedAt !== null)。
  // 之前含 trashed → 软删后 chip 计数不减少,用户困惑(列表少了 1 条,
  // 但 chip 仍显示原数)。现在跟 PageTree / getTreeForSpace 行为一致,
  // 用户软删 → chip 立即减 1,跟视觉一致。
  return pagesStore.pages.filter((p) => p.spaceId === id && p.deletedAt == null).length
})

// P1-9: 归档空间 UI 标识 —— 用 spacesStore.isArchived 派生,模板里挂
// 「已归档」badge。事实来源在 store,避免 component 里散落
// `active.archivedAt` 重复判定。
const isActiveArchived = computed(() => spacesStore.isArchived(active.value?.id))

// Personal-space shortcut 已被 SidebarTopSection 取代(P1-7):sticky 顶部
// 「我的工作台」单行始终可见,不再需要底部虚线分隔的快捷链接。
// `personalSpace` computed 和 `showMySpaceShortcut` 删掉,死代码清理。

// 与 HomeView.canCreateInSpace 对齐:viewer 在团队空间里看不到创建入口,
// 否则他们点了会撞后端 404。让 UI 提前表达"这里只读"。
// 个人空间写矩阵(P0-3):global admin 即使 own 自己的 personal space 也按
// supervisor 处理 —— 不能新建。统一用 lib/permissions.canCreateInSpace。
const canCreateInSpace = computed(() =>
  canCreateInSpaceOf(authStore.user, active.value),
)

/**
 * v0.7: 当前 active space 是否可由本用户管理(全局 admin OR 该 space 是
 * space-admin)。基于 `s.viewerRole` 推断 —— 后端空间 GET 已经注入这个
 * 字段(viewerRole 来自 `effectiveSpaceRole(me, spaceId)`),前端直接用,
 * 不另查 `canAdminSpace`。切换 active space 时,spacesStore 会刷 Space,
 * `s.viewerRole` 自动更新。
 */
async function createRoot() {
  uiStore.closeMenu()
  // Stage B.3: same client-side nanoid pattern as EditView. URL jumps
  // immediately to /p/<id>/edit before the server round-trip
  // completes — no blank flash waiting for the create to return.
  const clientId = newId()
  router.push(`/p/${clientId}/edit`)
  try {
    await pagesStore.createPage({ id: clientId, parentId: null })
  } catch {
    // store already shows the error banner; user can retry or close the editor
  }
}

/**
 * P1-9: `/` 快捷键绑 createRoot —— 跟 sidebar 底部 create-page-btn 上
 * 那个 kbd 提示对齐。之前只有 kbd 文字没 handler,user 按了无反应。
 *
 * 守卫:
 *   - focus 在 input/textarea/contenteditable 里 → 跳过,让用户正常输
 *     入 `/`。Tiptap 编辑器是 contenteditable,这条也覆盖 EditView 焦点。
 *   - 没创建权限(viewer / 锁定空间) → 跳过,不偷走键。
 *   - 修饰键组合(Cmd+/、Ctrl+/)→ 跳过,避免跟未来可能的全局搜索
 *     快捷键冲突。裸 `/` 才是 create page。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== '/') return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const target = e.target as HTMLElement | null
  if (!target) return
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
  if (!canCreateInSpace.value) return
  e.preventDefault()
  void createRoot()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/**
 * Sidebar 底部的「导入 Markdown」入口 — 无 sourceRow 时直接打开 modal,
 * 落到 active space 根(parentId = null)。
 */
function openImportRoot(): void {
  if (!active.value) return
  uiStore.closeMenu()
  uiStore.openImport({ defaultSpaceId: active.value.id })
}

function goHome() {
  // Active space's home — the `/` route renders HomeView for whatever
  // activeSpaceId is set. Clicking the chip while already on '/' is a no-op.
  void router.push('/')
}

/**
 * 打开一个页面时,让侧栏自动展开到它、并滚动定位到对应行。
 *
 * 为什么需要:懒加载后 `pages.value` 是稀疏缓存,从正文点一个子页面链接
 * (或直接深链进一个深层页)时,目标页所在的那条子树在侧栏里可能整条都是
 * 折叠的、甚至祖先节点都还没进缓存。用户会「迷路」——正文在看子页,侧栏
 * 却没有任何高亮。Confluence / Notion 的标准行为是:侧栏跟随当前页,自动
 * 展开祖先链并把当前行滚进视野。
 *
 * 流程:
 *   1. `ensureAncestorsLoaded` 向上补齐目标页 + 祖先链(缺失的逐个拉回)
 *   2. 若当前页不在活动空间,把活动空间切过去(侧栏才会渲染对应树)
 *   3. 逐个展开祖先,并把每个祖先的完整子列表拉全(树能渲染出整条路径)
 *   4. `nextTick` 后按 `data-page-id` 找到当前行,滚进视野
 *
 * 空间切换后的竞态:当用户点跨空间链接,`setActiveSpace` 是同步翻
 * `activeSpaceId.value`,但下面 `ensureAncestorsLoaded` / `ensureChildrenLoaded`
 * 在 `pages.value` 里找节点 —— 新空间的根可能还没进缓存。`ensureRootsLoaded`
 * 必须先 await,把新空间根加载完,否则树渲染是空的,scroll 进视野也
 * `.tree-row[data-page-id=...]` 找不到节点 → no-op。
 */
async function autoExpandAndLocate(pageId: string): Promise<void> {
  const chain = await pagesStore.ensureAncestorsLoaded(pageId)
  if (chain.length === 0) return
  const page = chain[chain.length - 1]!
  // 侧栏跟随当前页所在空间:跨空间点链接时切过去,同空间是 no-op。
  if (page.spaceId && spacesStore.activeSpaceId.value !== page.spaceId) {
    spacesStore.setActiveSpace(page.spaceId)
  }
  const sid = page.spaceId ?? spacesStore.activeSpaceId.value ?? ''
  // 跨空间跳转时,新空间的根可能还没加载(`pagesStore.init()` 只加载
  // active space 的根)。先 await 根加载,保证下面 ensureChildrenLoaded 找
  // 节点时 ancestors 已经在 pages.value 里,scroll-into-view 也能找到 row。
  if (sid) await pagesStore.ensureRootsLoaded(sid)
  // 展开每个祖先(不含当前页自身)。ensureChildrenLoaded 把该祖先的完整子
  // 列表拉全并标记缓存,这样展开后看到的是全部兄弟,而不只是路径上的一个。
  for (const anc of chain.slice(0, -1)) {
    try {
      await pagesStore.ensureChildrenLoaded(anc.id)
    } catch {
      // 拉子列表失败不阻断:祖先节点已在缓存里,路径仍能渲染
    }
    uiStore.expand(sid, anc.id)
  }
  await nextTick()
  const el = sidebarRef.value
  const targetRow = document.querySelector<HTMLElement>(
    `.tree-row[data-page-id="${pageId}"]`,
  )
  // 优先恢复用户上次滚到的位置(每个 space 独立记)。
  // 仅在该位置把目标行完全滚出视野时,才补一次 scrollIntoView 把当前页
  // 拉进视野,避免 reload 后首次进入时"明明在 X 页却看不到侧栏当前位置"。
  const stored = uiStore.getSidebarScroll(sid)
  if (el && stored > 0) {
    el.scrollTop = stored
    if (targetRow) {
      const rowRect = targetRow.getBoundingClientRect()
      const containerRect = el.getBoundingClientRect()
      const outOfView =
        rowRect.top < containerRect.top || rowRect.bottom > containerRect.bottom
      if (outOfView) {
        targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  } else {
    targetRow?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

/**
 * active space 变化时,确保该空间的根节点已加载。
 *
 * 覆盖 3 个场景:
 *   1. Sidebar mount 时(浏览器刷新 + 已 authed + 落 `/`)—— activeSpaceId
 *      已被 main.ts 的 spacesStore.init() 设好,这里兜底拉根;
 *   2. SpaceSwitcher 切换空间 —— setActiveSpace 同步翻值,这里按需拉新空间根;
 *   3. autoExpandAndLocate 跨空间跳转 —— 同上。
 *
 * `immediate: true` 让 Sidebar mount 时立刻跑一次(覆盖场景 1)。
 * ensureRootsLoaded 自身 idempotent + inflight dedup,无副作用。
 */
async function ensureActiveRoots(id: string): Promise<void> {
  try {
    await pagesStore.ensureRootsLoaded(id)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'not_found') {
      pagesStore.clearSpaceCache(id)
      const changed = await spacesStore.invalidateActiveSpace(id)
      if (changed && router.currentRoute.value.path !== '/') {
        await router.replace('/')
      }
      return
    }
    uiStore.setError(`加载空间失败：${humanizeApiError(error)}`)
  }
}

watch(
  () => spacesStore.activeSpaceId.value,
  (id) => {
    if (id) void ensureActiveRoots(id)
  },
  { immediate: true },
)

// 路由页面切换 / 首次加载完成时触发。等 *active space 的根* 加载完才跑 ——
// 否则 autoExpandAndLocate 里的 ensureAncestorsLoaded 拿到祖先,但树根
// 还没在 pages.value 里(空间没切的话;新空间的话 sid 的根未加载),scroll-
// into-view 找不到 row。rootsLoaded 翻真后 watcher 会再触发一次补跑。
watch(
  [
    () => {
      if (route.name !== 'read' && route.name !== 'edit' && route.name !== 'history') return ''
      return typeof route.params.id === 'string' ? route.params.id : ''
    },
    () => spacesStore.activeSpaceId.value,
    () => pagesStore.isRootsLoaded(spacesStore.activeSpaceId.value),
  ],
  ([pageId, _sid, rootsReady]) => {
    if (!rootsReady) return
    if (pageId) void autoExpandAndLocate(pageId)
  },
  { immediate: true },
)
</script>

<template>
  <aside ref="sidebarRef" class="sidebar" @scroll="onSidebarScroll">
    <!-- Active-space chip 移到最顶部 ——「you are here」锚点永远先看到。
         视觉重量比之前大幅降低:去掉 accent-soft 背景,改用 3px 左侧 accent
         竖线 + muted 文字,跟下面的 sidebar row 视觉同款,不再是一块独立的色
         块。28px row,SpaceAvatar 20px,跟 sidebar 其它 row 视觉统一。 -->
    <div class="quick-nav">
      <button
        v-if="active"
        type="button"
        class="quick-nav-item quick-nav-active"
        :class="{ 'quick-nav-archived': isActiveArchived }"
        :title="`回到 ${active.name} 首页`"
        @click="goHome"
      >
        <SpaceAvatar
          :space="active"
          :size="20"
        />
        <span class="active-name">{{ active.name }}</span>
        <span
          v-if="isActiveArchived"
          class="active-archived-badge"
          title="此空间已归档"
        >已归档</span>
        <span
          v-if="!canCreateInSpace"
          class="material-symbols-outlined active-lock"
          title="你在此空间只有只读权限"
        >lock</span>
        <span class="active-count">{{ activePageCount }}</span>
      </button>
    </div>

    <!-- P1-7:sticky 顶部「我的工作台」单行入口,2026-07-29 收尾 P1-9 删
         掉「已固定 / 最近访问」两块(已在 /me 工作台完整呈现),避免
         sidebar + 页面两份重复。下方才是当前空间的 page tree,继续滚动。 -->
    <SidebarTopSection />

    <!-- M13 此空间的关注 (2026-07-29 由「我的关注」改名)—— 个人空间无 watch 语义,不渲染此 section。 -->
    <WatchedSidebar v-if="!isActivePersonal" />

    <div class="sidebar-section">
      <SidebarSectionHeader
        icon="layers"
        label="此空间的页面"
        :count="activePageCount"
        :collapsed="pagesCollapsed"
        @toggle="togglePagesSection"
      />
      <template v-if="!pagesCollapsed">
      <EmptyState
        v-if="tree.length === 0 && !treeLoading"
        class="tree-empty"
        variant="no-data"
        size="sm"
        icon="inbox"
        title="还没有页面"
      >
        <!-- v0.7+: viewer-role 不再显式说「只读」;Confluence 风格是
             撞墙反馈而非持续标签 —— 无 CTA 即表达 -->
        <button v-if="canCreateInSpace" class="tree-empty-cta" @click="createRoot">
          <span class="material-symbols-outlined icon-sm">add</span>
          创建第一个
        </button>
      </EmptyState>
      <!-- P1-9: 加载中显示 muted 文字,跟真空态区分。PageTree 顶层根加载
           由 ensureRootsLoaded 异步发起,期间切到新空间会闪一下「还没有
           页面」,用户会以为这空间是空的。让显示变成「加载中…」避免误判。 -->
      <div v-else-if="tree.length === 0 && treeLoading" class="tree-loading">
        加载中…
      </div>
      <div v-else class="tree">
        <PageTree
          v-for="root in tree"
          :key="root.id"
          :node="root"
        />
      </div>
      </template>
    </div>

    <div class="sidebar-bottom">
      <!-- v0.7+: 去掉 v-else 分支的 36px readonly pill —— Confluence 风格
           「hide-not-disable」:无 Create 按钮就是 read-only 的信号,
           hint 由 quick-nav chip 里空间名旁的 14px 小锁承担 -->
      <button v-if="canCreateInSpace" class="create-page-btn" @click="createRoot">
        <span class="material-symbols-outlined icon-lg">add</span>
        创建页面
        <kbd>/</kbd>
      </button>
      <button
        v-if="canCreateInSpace"
        class="import-md-btn"
        title="导入 Markdown (.md) 到当前空间根"
        aria-label="导入 Markdown"
        @click="openImportRoot"
      >
        <span class="material-symbols-outlined icon-md">file_upload</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* Active-space chip 视觉重量降低:
 *   - 28px row(跟 sidebar 其它 row 同款)
 *   - 左侧 3px accent 竖线代替大色块背景 —— 仍然能一眼认出「这是 active」,
 *     但不抢 sticky 顶部「我的工作台」的视觉重心
 *   - 文字 muted (text-2) + hover 才升到 text-1,跟 watched-row / tree-row 同款
 *   - 底部 1px border 跟 sticky 顶部「我的工作台」视觉分隔
 */
.quick-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 2026-07-29 sidebar polish:删 border-bottom + padding-bottom —— 旧版在
     chip 「激活的空间」跟下面 sticky「我的工作台」之间有一条 1px 分隔线,
     加上 SidebarTopSection 自带的 border-bottom,siderbar 顶部出现 2 条
     横线,把 4 个 section 切分成 (1)|(2)|(3+4) 三块,用户反馈"很割裂"。
     现在 chip 跟 sticky 「我的工作台」之间只用 4px 微间距衔接(原 12+1
     border 也分不开两个同字色/同字号的 row),sticky 「我的工作台」跟
     滚动内容(此空间的关注 + 此空间的页面)之间保留 SidebarTopSection 唯
     一一条 1px 分隔线——既维持 sticky 顶部边界,又消除视觉割裂。 */
  margin-bottom: 4px;
}
.quick-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  /* 2026-07-29:删 ::before 3px bar 后,padding-left 从 11 回到 8,跟 sh-item
     / watched-row / tree-row 统一,padding 不再为那条竖线特别让位。 */
  padding: 0 8px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 14px;
  text-decoration: none;
  transition: all var(--duration-fast);
  position: relative;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  width: 100%;
}
.quick-nav-item:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
  text-decoration: none;
}
.quick-nav-item .material-symbols-outlined {
  font-size: 18px;
  color: var(--text-3);
}
.quick-nav-item:hover .material-symbols-outlined { color: var(--text-1); }

/* Active-space chip:左侧 3px accent 竖线 + muted 文字 + 透明背景 —— 比之前
 * 整行 accent-soft 大色块轻得多,跟 sticky 顶部「我的工作台」+ 团队
 * 空间 watched 列表在视觉重量上对齐。
 * 文字仍是 var(--text-2) muted,hover 才升 text-1,跟下面的 row 同款。
 *
 * 设计决策(P1-9 文档化):quick-nav-active 故意**不**走 accent-soft 背景
 * + accent 字色 + 600 加粗这套「active」视觉 —— 跟 sticky 顶部「我的
 * 工作台」(sh-item-active)+ 团队空间 watched-row.active 故意不同。
 * quick-nav 是「我在这里」的持久锚点,顶部固定不滚走,视觉太重会跟
 * sticky 顶部 + page tree active 行争色。3px 竖线 + muted 文字是这条
 * 规则的最优解。
 *
 * 2026-07-29:删掉 SidebarPinnedSection / SidebarRecentsSection 后,sticky
 * 顶部只剩「我的工作台」一块;此处规则同步收紧,不再需要为「Pinned/
 * Recents active」让位。 */
.quick-nav-active {
  /* 2026-07-29:删 ::before 3px accent 竖线(下方注释展开)。padding-left
     跟着从 11px 回到 8px,跟 sh-item / watched-row row 节奏统一。 */
  padding: 0 8px;
  background: transparent;
  color: var(--text-2);
  font-weight: 500;
}
/* 2026-07-29 删除 .quick-nav-active::before —— 早期 P1-9 阶段为了让
   chip「激活的空间」语义可视化,加了永久显示的 3px accent 竖线代表
   "you are here" 锚点。但用户反馈它视觉上像"激活样式"(永远亮),
   跟 chip 不是导航项、只是状态指示的语义冲突。
   现在 chip 纯靠 muted 文字 + 名字 + count 跟 lock 表达"当前空间"
   语义 —— 这种极简风是 Notion / Linear 左 rail 的标准做法。
   「你点击它会跳到该空间 home」这件事交由 hover:bg-subtle 反馈
   (跟其它 sidebar row 一致);不需要常驻竖线作为"可点击性"提示。 */
.quick-nav-active .material-symbols-outlined { color: var(--text-3); }
.active-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.active-count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}
/* viewer-role 只读锁:名字与页数之间的 14px muted 小锁。放在这里而不是叠在
   20px 头像上 —— 头像太小,角标 glyph 会糊。lock 轮廓在小尺寸下比 visibility
   眼睛清晰,一眼能认出「只读」。 */
.active-lock {
  font-size: 14px !important;
  color: var(--text-3);
  flex-shrink: 0;
}
/* P1-9: 归档空间 badge —— 跟 .active-count 同款半透白底 + text-3 字体尺寸,
   「已归档」三个字作为 chip 标识。位置在名字后 / lock 前,跟 lock 共存
   (archived 是空间级,readonly 是用户级,两者正交)。 */
.active-archived-badge {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  flex-shrink: 0;
}
/* 归档空间的 quick-nav 整体视觉降级 —— 名字颜色降低到 text-3,跟
   archivedBadge 视觉重量对齐。不影响 3px accent 竖线 (它是固定
   active 标识,跟 archived 正交)。 */
.quick-nav-archived .active-name {
  color: var(--text-3);
}
.quick-nav-archived .active-count {
  /* 归档空间的页数跟生产环境脱钩,弱化显示 */
  opacity: 0.6;
}

/* 2026-07-29:section title 的 `.count` chip 样式不再在此 scoped 声明 ——
   标题栏搬进 SidebarSectionHeader.vue 后,scoped 选择器打不到子组件内部;
   chip 视觉由 styles/components.css 的全局 `.sidebar-section-title .count`
   提供(两块 section 共用同一份)。 */

/* Sidebar 三个 section 之间用 sticky top 自身的 border-bottom 做分隔 —
   见 SidebarTopSection.vue。WatchedSidebar / page-tree section 跟 sticky 顶
   部之间的 visual divider 由 sticky 底边提供,这里只补上 12px margin-top 给
   一点呼吸空间,不要再叠 border-top(避免双线夹一缝的难看效果)。 */
.sidebar-section {
  margin-top: 12px;
}

.tree-empty {
  /* EmptyState 自带 padding 28px 16px,挤压 row 视觉。P1-9 (sidebar polish)
     收紧:EmptyState 内部 padding 改为 8px,左对齐 + icon 紧随其后,让
     "还没有页面"跟 row 文字起点(X=20)对齐,跟 watched-empty
     的 0 8px 同款节奏。 */
  margin-top: 4px;
}
/* P1-9: 加载中分支 —— 跟 watched-empty 同款 28px / 12px / 0 8px / text-3,
   跟 row 文字起点对齐。 */
.tree-loading {
  min-height: 28px;
  line-height: 28px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--text-3);
}
.tree-empty :deep(.empty-state) {
  padding: 8px;
  align-items: flex-start;
  text-align: left;
  gap: 0;
}
.tree-empty :deep(.empty-icon) {
  margin: 0 8px 0 0;
  width: 28px;
  height: 28px;
}
.tree-empty :deep(.empty-icon .material-symbols-outlined) {
  font-size: 18px;
}
.tree-empty-cta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
}
.tree-empty-cta:hover {
  background: var(--accent);
  color: white;
}

.create-page-btn {
  position: relative;
  font-weight: 500;
  flex: 1 1 auto;
}
/* viewer-role 用户无 Create 按钮时,sidebar-bottom 整段不渲染内容;
   不挂 min-height 占位 —— 空间名旁的 14px 小锁是只读信号。
   import-md-btn 等仍可以保留,在 viewer-role 空间导入 markdown 仍合理
   (创建页面权限和导入 markdown 权限是分离的,导入对应后端 admin/space-
   admin 能力)。 */
.sidebar-bottom {
  display: flex;
  align-items: stretch;
  gap: 6px;
}
.import-md-btn {
  flex: 0 0 auto;
  width: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-2);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all var(--duration-fast);
}
.import-md-btn:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

/* v0.7 移位: 管理空间按钮从 sidebar-bottom 移到 active space header
 * 右侧 —— 跟空间名称同语义层级。视觉上做成跟 .active-count 同款 chip
 * (半透白底 + accent 色),作为「数据的兄弟」而不是「孤立的 icon」——
 * 之前的 28px 裸 icon 跟 13 pill chip 类型不同,放一起割裂。 */
.create-page-btn kbd {
  margin-left: auto;
  background: var(--bg-subtle);
  color: var(--text-3);
  border-color: transparent;
}
.create-page-btn:hover kbd {
  background: var(--bg);
  color: var(--text-2);
}

/* v0.7+ 删除:
 *   .readonly-badge (viewer-role 时占据 sidebar-bottom 36px slot)
 *   .readonly-hint  (EmptyState 内 viewer 提示)
 * 二者的语义移到 quick-nav chip 里空间名旁的 .active-lock(14px lock)。
 * (曾短暂试过叠在 SpaceAvatar 头像右下角,但 20px 头像 + 9px glyph 糊成一团,
 *  改成名字旁行内小锁。)
 * 跟 Confluence 「hide-not-disable」对齐:无创建按钮就是 read-only 的信号,
 * 不必再挂显式 「只读」 pill。
 */
</style>
