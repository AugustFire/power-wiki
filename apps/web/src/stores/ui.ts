import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readJSON, writeJSON } from '@/lib/storage'
import { PERSIST_KEYS } from '@power-wiki/shared/keys'

const KEY_EXPANDED = PERSIST_KEYS.TREE_EXPANDED
const LEGACY_KEY = '__legacy__'

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

export const useUiStore = defineStore('ui', () => {
  const expanded = ref<ExpandedBySpace>(readInitial())

  watch(expanded, (val) => writeJSON(KEY_EXPANDED, val), { deep: true })

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

  return {
    expanded,
    openMenuId,
    menuPos,
    renamingId,
    topSearchOpen,
    cheatSheetOpen,
    error,
    isExpanded,
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
  }
})
