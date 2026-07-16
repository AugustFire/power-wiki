import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readJSON, writeJSON } from '@/lib/storage'
import { PERSIST_KEYS } from '@power-wiki/shared/keys'

const KEY_EXPANDED = PERSIST_KEYS.TREE_EXPANDED
const KEY_SCROLL = PERSIST_KEYS.TREE_SCROLL
const KEY_TOC_COLLAPSED = PERSIST_KEYS.TOC_COLLAPSED
const LEGACY_KEY = '__legacy__'

/**
 * Toast 通知形状(成功 / 错误 / 信息 反馈)。
 *
 * - id:用单调递增整数作为 key;只在本会话内去重,不持久化。
 * - kind:决定图标 + 颜色。success(绿) / error(红) / info(蓝)。
 * - message:1-2 句话;过长用户在右下角读不全。
 * - action(可选):toast 右侧附加按钮。典型用途是附件上传失败时挂
 *   「重试」按钮 —— 用户拖文件失败后能直接原地重试,不用回原文件
 *   重新拖。action.onClick 是闭包,可直接持有 file 等运行时对象。
 *
 * 替代原本可能误用于成功反馈的顶部 banner —— 顶部 banner 仍专用于
 * 持续展示的全局错误,toast 适用于"刚做完一个动作,短促告诉用户"。
 */
export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
  action?: {
    label: string
    onClick: () => void
  }
}

/**
 * Stage 7: tree expansion is now keyed by `spaceId`, so a user who
 * collapses the team space's tree doesn't lose that state when they
 * switch to their personal space. Shape: `{ [spaceId]: pageId[] }`.
 *
 * The old v0.5 format was a flat `string[]` shared across all spaces.
 * On read we promote it to a per-space record under a sentinel key
 * (`__legacy__`); any space that hasn't been toggled yet transparently
 * falls back to the legacy list, so existing users don't suddenly
 * see their tree collapse when they reload. Once they toggle an
 * expansion in a given space, that space gets its own materialized
 * list and the legacy fallback is no longer consulted.
 */
type ExpandedBySpace = Record<string, string[]>
type ScrollBySpace = Record<string, number>

function readInitial(): ExpandedBySpace {
  const raw = readJSON<unknown>(KEY_EXPANDED, {})
  if (Array.isArray(raw)) {
    return { [LEGACY_KEY]: raw as string[] }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as ExpandedBySpace
  }
  return {}
}

function readScrollInitial(): ScrollBySpace {
  const raw = readJSON<unknown>(KEY_SCROLL, {})
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as ScrollBySpace
  }
  return {}
}

export const useUiStore = defineStore('ui', () => {
  const expanded = ref<ExpandedBySpace>(readInitial())

  watch(expanded, (val) => writeJSON(KEY_EXPANDED, val), { deep: true })

  /**
   * Sidebar scrollTop per space. Persisted so a reload restores the
   * user's last position — Confluence / Notion both do this. The watcher
   * is throttled by the caller (Sidebar.vue) to avoid hammering
   * localStorage on every wheel tick.
   */
  const scrollBySpace = ref<ScrollBySpace>(readScrollInitial())

  watch(scrollBySpace, (val) => writeJSON(KEY_SCROLL, val), { deep: true })

  /**
   * TOC 折叠态 —— 持久化到 localStorage,刷新后保留用户偏好。
   * 读端兼容旧数据(无 key 视为未折叠);写端只存 boolean,不存其他形态。
   * 命名跟 sidebar tree 折叠(`expanded`)区分:这个是 ReadView 右侧 TOC,
   * 不是侧边栏页面树。
   */
  function readTocCollapsedInitial(): boolean {
    return readJSON<unknown>(KEY_TOC_COLLAPSED, false) === true
  }
  const tocCollapsed = ref(readTocCollapsedInitial())
  watch(tocCollapsed, (val) => writeJSON(KEY_TOC_COLLAPSED, val))

  function setTocCollapsed(v: boolean): void {
    tocCollapsed.value = v
  }
  function toggleTocCollapsed(): void {
    tocCollapsed.value = !tocCollapsed.value
  }

  // 树节点 ⋯ 菜单状态(全树共享,同一时刻只有一个菜单打开)
  const openMenuId = ref<string | null>(null)
  // 菜单坐标(基于视口,用于 position: fixed 定位)
  const menuPos = ref<{ x: number; y: number }>({ x: 0, y: 0 })
  // 当前正在重命名的节点 id
  const renamingId = ref<string | null>(null)
  // 顶栏搜索框开关 — 提到 store 让 HomeView / Sidebar / 任意位置都能唤起
  const topSearchOpen = ref(false)
  // 快捷键速查表(⌘/ 唤起)开关 — 全局共享,App.vue 挂 CheatSheetModal
  const cheatSheetOpen = ref(false)
  // Toast 通知队列 — 成功 / 错误 / 信息 反馈(替代顶部 banner 用于成功反馈;
  // banner 仍用于持续展示的全局错误)。每个 toast 自动 3 秒后消失,也可手动关闭。
  const toasts = ref<Toast[]>([])
  // 全局错误信息(API 失败 / 乐观更新回滚时被 setError)。App.vue 顶部 banner 用。
  // null = 无错误。多次 setError 取最后一次。
  const error = ref<string | null>(null)

  /**
   * Stage 6 — Comments drawer state (预留 v0.1,当前 v0 直接嵌 section)。
   * 全局共享,任何 view 都能唤起评论侧栏。`commentsPageId` 保留在关后
   * 以便再次打开不丢失上下文。组件路径:
   *   apps/web/src/components/comments/CommentsSection.vue
   */
  const commentsPageId = ref<string | null>(null)
  const commentsOpen = ref(false)

  /**
   * P1-6 — Settings drawer state. UserMenu 「设置」入口唤起,SettingsDrawer
   * 渲染。挂 uiStore 而不是 provide/inject 是因为 UserMenu 和 SettingsDrawer
   * 不在同一组件树里(UserMenu 在 TopBar 内,SettingsDrawer 顶层 teleport),
   * 走 store 更直白。
   */
  const settingsDrawerOpen = ref(false)
  function openSettings(): void {
    settingsDrawerOpen.value = true
  }
  function closeSettings(): void {
    settingsDrawerOpen.value = false
  }

  /**
   * Resolve the expansion list for a given space, falling back to the
   * legacy single-list state when the space hasn't been toggled yet.
   * Returns a fresh array each call to avoid giving callers a live
   * reference into the store (which would let them bypass the toggle
   * helpers and mutate state without going through reactivity).
   */
  function listFor(spaceId: string): string[] {
    return expanded.value[spaceId] ?? expanded.value[LEGACY_KEY] ?? []
  }

  function isExpanded(spaceId: string, id: string): boolean {
    return listFor(spaceId).includes(id)
  }

  function getSidebarScroll(spaceId: string): number {
    return scrollBySpace.value[spaceId] ?? 0
  }

  function setSidebarScroll(spaceId: string, scrollTop: number): void {
    if (scrollBySpace.value[spaceId] === scrollTop) return
    scrollBySpace.value = { ...scrollBySpace.value, [spaceId]: scrollTop }
  }

  /**
   * Whether the user has ever toggled expansion in this space. Used by
   * PageTree to decide whether root rows should default to expanded
   * (first time entering the space) vs. follow the (collapsed) record.
   * Returns false for the legacy single-list state too — that record
   * was a flat list shared across all spaces, not a per-space intent.
   */
  function hasRecord(spaceId: string): boolean {
    return Array.isArray(expanded.value[spaceId])
  }

  /**
   * Materialize the space's expansion list from the legacy fallback (if
   * any) before mutating it. We only do this on the first user-driven
   * toggle for a given space — subsequent toggles operate on the
   * space's own list. Without this step, the first click in a new
   * space would inherit the entire legacy state and clobber it on the
   * next mutation.
   */
  function ensureList(spaceId: string): string[] {
    if (!expanded.value[spaceId]) {
      const seed = expanded.value[LEGACY_KEY]
      expanded.value[spaceId] = seed ? [...seed] : []
    }
    return expanded.value[spaceId]!
  }

  function toggle(spaceId: string, id: string): void {
    const list = ensureList(spaceId)
    const idx = list.indexOf(id)
    if (idx >= 0) list.splice(idx, 1)
    else list.push(id)
  }

  function expand(spaceId: string, id: string): void {
    const list = ensureList(spaceId)
    if (!list.includes(id)) list.push(id)
  }

  function openMenu(id: string, x: number, y: number): void {
    openMenuId.value = id
    menuPos.value = { x, y }
  }

  function closeMenu(): void {
    openMenuId.value = null
  }

  function startRename(id: string): void {
    renamingId.value = id
    openMenuId.value = null
  }

  function endRename(): void {
    renamingId.value = null
  }

  function openTopSearch(): void {
    topSearchOpen.value = true
  }
  function closeTopSearch(): void {
    topSearchOpen.value = false
  }

  function openCheatSheet(): void {
    cheatSheetOpen.value = true
  }
  function closeCheatSheet(): void {
    cheatSheetOpen.value = false
  }

  function setError(message: string | null): void {
    error.value = message
  }
  function clearError(): void {
    error.value = null
  }

  function openComments(pageId: string): void {
    commentsPageId.value = pageId
    commentsOpen.value = true
  }
  function closeComments(): void {
    commentsOpen.value = false
  }

  // ─── Toast 通知 ────────────────────────────────────────────
  let nextToastId = 1
  /**
   * 弹一个 toast。默认 3 秒后自动消失(durationMs=0 表示常驻,需手动关)。
   * 返回 id 可用于后续 dismiss(例如展示一条带「撤销」按钮的 toast)。
   */
  function notify(
    message: string,
    kind: Toast['kind'] = 'success',
    durationMs = 3000,
    action?: Toast['action'],
  ): number {
    const id = nextToastId++
    toasts.value = [...toasts.value, { id, kind, message, action }]
    if (durationMs > 0) {
      setTimeout(() => dismiss(id), durationMs)
    }
    return id
  }
  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  /**
   * MD 导入 modal 全局开关。`context.sourceRow` 可选 — 没传时落到
   * active space 根(从 Sidebar 底部 icon button 唤起)。`payload` 是
   * PageTree 拖文件入时预填的文本 + filename,modal 打开后回填。
   */
  const importModalOpen = ref(false)
  const importContext = ref<{
    sourceRow?: { id: string; title: string; parentId: string | null; spaceId: string }
    defaultSpaceId: string
    payload?: { text: string; filename: string }
  } | null>(null)
  function openImport(ctx: NonNullable<typeof importContext.value>): void {
    importContext.value = ctx
    importModalOpen.value = true
  }
  function closeImport(): void {
    importModalOpen.value = false
    // 保留 context 一帧,以便 close 动画期间 modal 仍能渲染。
    setTimeout(() => {
      if (!importModalOpen.value) importContext.value = null
    }, 200)
  }

  return {
    expanded,
    openMenuId,
    menuPos,
    renamingId,
    topSearchOpen,
    cheatSheetOpen,
    tocCollapsed,
    setTocCollapsed,
    toggleTocCollapsed,
    error,
    isExpanded,
    hasRecord,
    getSidebarScroll,
    setSidebarScroll,
    toggle,
    expand,
    openMenu,
    closeMenu,
    startRename,
    endRename,
    openTopSearch,
    closeTopSearch,
    openCheatSheet,
    closeCheatSheet,
    setError,
    clearError,
    commentsPageId,
    commentsOpen,
    openComments,
    closeComments,
    settingsDrawerOpen,
    openSettings,
    closeSettings,
    toasts,
    notify,
    dismiss,
    importModalOpen,
    importContext,
    openImport,
    closeImport,
  }
})
