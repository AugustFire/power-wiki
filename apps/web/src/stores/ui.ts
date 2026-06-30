import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readJSON, writeJSON } from '@/lib/storage'
import { PERSIST_KEYS } from '@power-wiki/shared/keys'

const KEY_EXPANDED = PERSIST_KEYS.TREE_EXPANDED

export const useUiStore = defineStore('ui', () => {
  const expanded = ref<string[]>(readJSON<string[]>(KEY_EXPANDED, []))

  watch(expanded, (val) => writeJSON(KEY_EXPANDED, val), { deep: true })

  // 树节点 ⋯ 菜单状态(全树共享,同一时刻只有一个菜单打开)
  const openMenuId = ref<string | null>(null)
  // 菜单坐标(基于视口,用于 position: fixed 定位)
  const menuPos = ref<{ x: number; y: number }>({ x: 0, y: 0 })
  // 当前正在重命名的节点 id
  const renamingId = ref<string | null>(null)
  // 顶栏搜索框开关 — 提到 store 让 HomeView / Sidebar / 任意位置都能唤起
  const topSearchOpen = ref(false)
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

  function isExpanded(id: string): boolean {
    return expanded.value.includes(id)
  }

  function toggle(id: string): void {
    const idx = expanded.value.indexOf(id)
    if (idx >= 0) expanded.value.splice(idx, 1)
    else expanded.value.push(id)
  }

  function expand(id: string): void {
    if (!isExpanded(id)) expanded.value.push(id)
  }

  function setExpanded(ids: string[]): void {
    expanded.value = [...ids]
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
    error,
    isExpanded,
    toggle,
    expand,
    setExpanded,
    openMenu,
    closeMenu,
    startRename,
    endRename,
    openTopSearch,
    closeTopSearch,
    setError,
    clearError,
    commentsPageId,
    commentsOpen,
    openComments,
    closeComments,
  }
})
