import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readJSON, writeJSON } from '@/lib/storage'

const KEY_EXPANDED = 'power-wiki:tree-expanded'

export const useUiStore = defineStore('ui', () => {
  const expanded = ref<string[]>(readJSON<string[]>(KEY_EXPANDED, []))

  watch(expanded, (val) => writeJSON(KEY_EXPANDED, val), { deep: true })

  // 树节点 ⋯ 菜单状态(全树共享,同一时刻只有一个菜单打开)
  const openMenuId = ref<string | null>(null)
  // 菜单坐标(基于视口,用于 position: fixed 定位)
  const menuPos = ref<{ x: number; y: number }>({ x: 0, y: 0 })
  // 当前正在重命名的节点 id
  const renamingId = ref<string | null>(null)

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

  return {
    expanded,
    openMenuId,
    menuPos,
    renamingId,
    isExpanded,
    toggle,
    expand,
    setExpanded,
    openMenu,
    closeMenu,
    startRename,
    endRename,
  }
})
