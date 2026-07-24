<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { newId } from '@/lib/id'
import EmptyState from '@/components/ui/EmptyState.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import PageTree from './PageTree.vue'
import WatchedSidebar from './WatchedSidebar.vue'

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

const totalPages = computed(() => pagesStore.pages.length)

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
  return pagesStore.pages.filter((p) => p.spaceId === id).length
})

// Personal-space shortcut: separate from the active-space chip so users have
// a one-click path back to their personal space when they're working in a
// shared space. Rendered as a small bottom-anchor link — not a primary nav item.
const personalSpace = computed(() => spacesStore.personalSpace.value)
const showMySpaceShortcut = computed(
  () => personalSpace.value && active.value && !isActivePersonal.value,
)

// 与 HomeView.canCreateInSpace 对齐:viewer 在团队空间里看不到创建入口,
// 否则他们点了会撞后端 404。让 UI 提前表达"这里只读"。
// 个人空间 owner 始终可写(admin 也可写),不挂这个 gate。
const canCreateInSpace = computed(() => {
  const s = active.value
  if (!s) return false
  if (authStore.isAdmin) return true
  if (s.kind === 'personal') return true
  return s.viewerRole === 'editor' || s.viewerRole === 'admin'
})

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

function goMySpace() {
  // Prefer the canonical URL so /me shows up in the address bar and the
  // browser history — refreshing /me re-runs the redirect, which is what
  // we want when the personal space id changes (e.g. user renamed).
  void router.push('/me')
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
watch(
  () => spacesStore.activeSpaceId.value,
  (id) => {
    if (id) void pagesStore.ensureRootsLoaded(id)
  },
  { immediate: true },
)

// 路由页面切换 / 首次加载完成时触发。等 *active space 的根* 加载完才跑 ——
// 否则 autoExpandAndLocate 里的 ensureAncestorsLoaded 拿到祖先,但树根
// 还没在 pages.value 里(空间没切的话;新空间的话 sid 的根未加载),scroll-
// into-view 找不到 row。rootsLoaded 翻真后 watcher 会再触发一次补跑。
watch(
  [() => route.params.id, () => spacesStore.activeSpaceId.value, () => pagesStore.isRootsLoaded(spacesStore.activeSpaceId.value)],
  ([id, _sid, rootsReady]) => {
    if (!rootsReady) return
    if (typeof id === 'string' && id) void autoExpandAndLocate(id)
  },
  { immediate: true },
)
</script>

<template>
  <aside ref="sidebarRef" class="sidebar" @scroll="onSidebarScroll">
    <div class="quick-nav">
      <!-- Active-space chip: always reflects the currently active space (any
           kind) so the sidebar's identity matches the topbar. The chip is
           itself a "home" button — clicking it returns to the active space's
           home view. Old behavior rendered the personal space here regardless
           of the active space, which was confusing when working in a team
           space. -->
      <button
        v-if="active"
        type="button"
        class="quick-nav-item quick-nav-active"
        :title="`回到 ${active.name} 首页`"
        @click="goHome"
      >
        <!-- v0.7+: viewer-role → 空间名旁挂一个 14px lock 图标;
             不在头像上叠角标(20px 头像 + 9px glyph 会糊),
             跟 Confluence 「hide-not-disable」对齐 —— 无创建按钮 + 小锁即表达只读 -->
        <SpaceAvatar
          :space="active"
          :size="20"
        />
        <span class="active-name">{{ active.name }}</span>
        <span
          v-if="!canCreateInSpace"
          class="material-symbols-outlined active-lock"
          title="你在此空间只有只读权限"
        >lock</span>
        <span class="active-count">{{ activePageCount }}</span>
      </button>
    </div>

    <!-- M13 我的关注 —— 个人空间无 watch 语义,不渲染此 section。 -->
    <WatchedSidebar v-if="!isActivePersonal" />

    <div class="sidebar-section">
      <div class="sidebar-section-title">
        <span>
          <span class="material-symbols-outlined section-icon">layers</span>
          此空间的页面
        </span>
        <span class="count">{{ tree.length }}</span>
      </div>
      <EmptyState
        v-if="tree.length === 0"
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
      <div v-else class="tree">
        <PageTree
          v-for="root in tree"
          :key="root.id"
          :node="root"
        />
      </div>
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
.quick-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 20px;
}
.quick-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
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

/* Active-space chip: a small colored avatar chip replaces the plain icon
 * so users can spot the current space at a glance. Mirrors the topbar
 * SpaceSwitcher's avatar treatment for visual consistency. The chip is
 * always the active space (any kind), so it doesn't need an "active" state
 * — it's always in that state. */
.quick-nav-active {
  padding: 0 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.quick-nav-active .material-symbols-outlined { color: var(--accent); }
.active-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.active-count {
  font-size: 11px;
  color: var(--accent);
  background: rgba(255, 255, 255, 0.6);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
}
/* viewer-role 只读锁:名字与页数之间的 14px muted 小锁。放在这里而不是叠在
   20px 头像上 —— 头像太小,角标 glyph 会糊。lock 轮廓在小尺寸下比 visibility
   眼睛清晰,一眼能认出「只读」。 */
.active-lock {
  font-size: 14px !important;
  color: var(--text-3);
  flex-shrink: 0;
}

/* "我的空间" anchor: a quiet bottom-of-section shortcut back to the user's
 * personal space when the active space is something else. Rendered as a
 * small inline button so it doesn't compete with the active-space chip
 * above or the create-page button at the very bottom. */
.sidebar-myspace-anchor {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.msa-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  border-radius: var(--radius);
  color: var(--text-3);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.msa-btn:hover { background: var(--bg-subtle); color: var(--text-1); }
.msa-icon { font-size: 16px !important; color: var(--text-3); flex-shrink: 0; }
.msa-btn:hover .msa-icon { color: var(--text-1); }
.msa-label { font-weight: 500; }
.msa-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.sidebar-section-title .count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}

.tree-empty {
  /* EmptyState 自带 padding,这里仅约束外层居中即可 */
  margin-top: 8px;
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
