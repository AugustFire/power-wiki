<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useConfirm } from '@/composables/useConfirm'
import PublishToSpaceMenu from './PublishToSpaceMenu.vue'
import type { PageNode, TreeNode } from '@power-wiki/shared'

const props = defineProps<{
  node: TreeNode
  depth?: number
}>()

const uiStore = useUiStore()
const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const route = useRoute()
const router = useRouter()
const { confirm } = useConfirm()

const depth = computed(() => props.depth ?? 0)
const isExpanded = computed(() => uiStore.isExpanded(props.node.id))
const hasChildren = computed(() => props.node.children.length > 0)
const isActive = computed(() => route.params.id === props.node.id)
const isMenuOpen = computed(() => uiStore.openMenuId === props.node.id)
const isRenaming = computed(() => uiStore.renamingId === props.node.id)

const renameValue = ref(props.node.title)
const renameInputRef = ref<HTMLInputElement | null>(null)

/* ─── Drag & drop ──────────────────────────────────────────────────────
 *  HTML5 drag API, scoped to row drags inside the tree. Drop semantics:
 *    - top half of row  → insert ABOVE this row (same parent)
 *    - bottom half      → insert BELOW this row (same parent)
 *  No "drop on row to make it a child" — use ⋯ menu → "在此页下添加子页面".
 *  Reorders within the same parent + cross-parent moves go through
 *  pagesStore.movePage which handles cycle protection + sibling reorder.
 *
 *  `dragState` MUST live at module scope (not per-instance): when row A
 *  starts dragging, every other PageTree instance's `onDragOver` checks
 *  the dragging id to decide whether to call `preventDefault()` (which is
 *  what allows the browser to fire `drop` at all). A per-instance ref
 *  would be null on rows that aren't the source, so they would early-
 *  return and the drop event would never fire. This is the bug we're
 *  explicitly fixing here.
 */
type DropHint = 'before' | 'after'
const dragState = reactive<{ draggingId: string | null; dropTarget: { id: string; position: DropHint } | null }>({
  draggingId: null,
  dropTarget: null,
})

const isDragSource = computed(() => dragState.draggingId === props.node.id)
const dropHint = computed<DropHint | null>(
  () => (dragState.dropTarget?.id === props.node.id ? dragState.dropTarget.position : null),
)

function onDragStart(e: DragEvent) {
  if (isRenaming.value) {
    e.preventDefault()
    return
  }
  if (!e.dataTransfer) return
  dragState.draggingId = props.node.id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', props.node.id)
}

function onDragEnd() {
  dragState.draggingId = null
  dragState.dropTarget = null
}

function onDragOver(e: DragEvent) {
  // Reject self-drag and drags from outside this tree.
  if (!dragState.draggingId || dragState.draggingId === props.node.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const row = e.currentTarget as HTMLElement
  const rect = row.getBoundingClientRect()
  const position: DropHint = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
  // Avoid re-triggering reactivity if nothing changed.
  if (dragState.dropTarget?.id !== props.node.id || dragState.dropTarget.position !== position) {
    dragState.dropTarget = { id: props.node.id, position }
  }
}

function onDragLeave(e: DragEvent) {
  // relatedTarget can be null when leaving the window — treat that as a clean exit.
  if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return
  if (dragState.dropTarget?.id === props.node.id) dragState.dropTarget = null
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  const target = dragState.dropTarget
  const draggedId = dragState.draggingId
  dragState.draggingId = null
  dragState.dropTarget = null
  if (!target) return
  if (!draggedId || draggedId === target.id) return

  const targetPage = pagesStore.getPage(target.id)
  if (!targetPage) return

  // Refuse cycles: can't drop a page onto itself or one of its descendants.
  if (isAncestor(draggedId, target.id)) return

  // Compute the new sortOrder for the dragged page in the target parent's
  // sibling list. The page is being inserted at the same level as `target`,
  // so the target's parent is the new parent.
  const newParentId = targetPage.parentId
  const siblings = pagesStore.pages
    .filter((p) => p.parentId === newParentId && p.id !== draggedId)
    .sort((a, b) => a.order - b.order)
  let insertAt = siblings.findIndex((p) => p.id === target.id)
  if (insertAt < 0) insertAt = siblings.length
  if (target.position === 'after') insertAt += 1

  try {
    await pagesStore.movePage(draggedId, newParentId, insertAt)
  } catch {
    // banner already shown by store
  }
}

/**
 * Walk parent chain from `startId`; return true if `ancestorId` appears.
 * Used to refuse drops that would create a cycle (X onto a descendant of X).
 */
function isAncestor(startId: string, ancestorId: string): boolean {
  let cur: ReturnType<typeof pagesStore.getPage> = pagesStore.getPage(startId)
  let guard = 0
  while (cur && guard++ < 64) {
    if (cur.id === ancestorId) return true
    cur = cur.parentId ? pagesStore.getPage(cur.parentId) : undefined
  }
  return false
}

const menuStyle = computed(() => {
  const { x, y } = uiStore.menuPos
  // 视口边缘裁剪 —— 在右下角点击 ⋯ 时,菜单会溢出。
  // 菜单宽 ~220px / 高 ~150px,留 8px 安全边距。
  const MENU_W = 220
  const MENU_H = 150
  const SAFE = 8
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0
  let left = x + 8
  let top = y + 4
  if (left + MENU_W + SAFE > vw) left = Math.max(SAFE, vw - MENU_W - SAFE)
  if (top + MENU_H + SAFE > vh) top = Math.max(SAFE, vh - MENU_H - SAFE)
  return { top: `${top}px`, left: `${left}px` }
})

function toggleCaret(e: MouseEvent) {
  e.stopPropagation()
  if (hasChildren.value) uiStore.toggle(props.node.id)
}

function navigate() {
  if (isRenaming.value) return
  window.location.hash = `#/p/${props.node.id}`
}

function onMoreClick(e: MouseEvent) {
  e.stopPropagation()
  if (isMenuOpen.value) {
    uiStore.closeMenu()
  } else {
    uiStore.openMenu(props.node.id, e.clientX, e.clientY)
  }
}

async function addChild() {
  uiStore.closeMenu()
  uiStore.expand(props.node.id)
  try {
    const p = await pagesStore.createPage({ parentId: props.node.id })
    router.push(`/p/${p.id}/edit`)
  } catch {
    // banner already shown by store
  }
}

async function addSibling() {
  uiStore.closeMenu()
  try {
    const p = await pagesStore.createPage({ parentId: null })
    router.push(`/p/${p.id}/edit`)
  } catch {
    // banner already shown by store
  }
}

function startRename() {
  renameValue.value = props.node.title
  uiStore.startRename(props.node.id)
  nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

function commitRename() {
  if (!isRenaming.value) return
  const next = renameValue.value.trim()
  if (next && next !== props.node.title) {
    // 重命名失败时 store 会回滚 + banner 提示;这里不阻塞 UI
    void pagesStore.renamePage(props.node.id, next)
  }
  uiStore.endRename()
}

function cancelRename() {
  uiStore.endRename()
}

function openInNewTab() {
  uiStore.closeMenu()
  window.open(`#/p/${props.node.id}`, '_blank', 'noopener')
}

const copyFlash = ref<string | null>(null)
let copyFlashTimer: ReturnType<typeof setTimeout> | null = null

async function copyLink() {
  uiStore.closeMenu()
  const url = `${window.location.origin}${window.location.pathname}#/p/${props.node.id}`
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      // Fallback for non-secure contexts where clipboard API is gated.
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    copyFlash.value = '已复制'
    if (copyFlashTimer) clearTimeout(copyFlashTimer)
    copyFlashTimer = setTimeout(() => { copyFlash.value = null }, 1500)
  } catch {
    uiStore.setError('复制失败,请手动复制链接')
  }
}

function onRenameKey(e: KeyboardEvent) {
  // 仅处理单个按键的 Enter / Escape,不做任何 Ctrl/Meta 组合键绑定
  if (e.key === 'Enter') {
    e.preventDefault()
    commitRename()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelRename()
  }
}

function deletePage() {
  uiStore.closeMenu()
  // Stage 5: refuse to delete a page with non-trashed children. The server
  // also enforces this (409 has_children) but UX is much better if the
  // menu item itself is disabled (see template below) — this branch only
  // fires if the menu was reached some other way (keyboard, automation).
  const descendantCount = countLiveDescendants(props.node.id)
  if (descendantCount > 0) {
    uiStore.setError('请先删除子页面')
    return
  }
  confirm({
    title: `删除「${props.node.title}」?`,
    message: '页面将进入回收站,可联系管理员恢复。',
    danger: true,
    confirmText: '删除',
    cancelText: '取消',
  }).then(async (ok) => {
    if (!ok) return
    const wasCurrent = route.params.id === props.node.id
    try {
      await pagesStore.softDeletePage(props.node.id)
    } catch {
      return // banner shown by store; stay on current page
    }
    if (wasCurrent) router.push('/')
  })
}

function promoteToRoot() {
  uiStore.closeMenu()
  if (props.node.parentId === null) return
  // 父级变更走 movePage 而不是 updatePage — updatePage 会过滤掉 parentId
  void pagesStore.movePage(props.node.id, null)
}

/**
 * Count non-trashed descendants of `id`. Stage 5: a page can only be
 * soft-deleted when it has zero live children, mirroring the backend's
 * 409 `has_children` guard. `getChildren` already filters out trashed
 * rows, so this count is "live children" by construction.
 */
function countLiveDescendants(id: string): number {
  let count = 0
  const stack: string[] = [id]
  while (stack.length) {
    const cur = stack.pop()!
    const children = pagesStore.getChildren(cur)
    for (const c of children) {
      count++
      stack.push(c.id)
    }
  }
  return count
}

const hasLiveChildren = computed(() => countLiveDescendants(props.node.id) > 0)

/**
 * Cross-space "发布到" UI: clicking "发布到..." in the ⋯ menu opens a
 * popover listing the user's accessible team spaces. The popover is
 * mounted conditionally as a sibling of the menu backdrop, anchored at
 * the click coordinates so it visually flows out of the trigger.
 *
 * 跟老的"移动到"在 UX 上**完全一样**(同位置、同菜单),但底层是**复制**
 * 而非搬家 — 源页保留在 personal space,新页由后端加 "(来自 X 的个人分享)"
 * 后缀,跳到新页。原页不受影响。
 */
const publishToOpen = ref(false)
const publishToAnchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })

function openPublishTo() {
  publishToAnchor.value = { x: uiStore.menuPos.x, y: uiStore.menuPos.y }
  publishToOpen.value = true
}
function closePublishTo() {
  publishToOpen.value = false
}

/**
 * 源 page 必须是 current user's personal space — 后端在 POST /:id/publish
 * 里校验 `space.kind === 'personal' && space.ownerId === me.id`。前端在
 * 可见性这一层就过滤掉"team space 页"和"别人 personal space 页"(personal
 * space 的 ownerId 不是 me.id 在 SpaceEditView 才看得到,这里简化处理)。
 *
 * 目标:至少一个团队空间,且不等于源 space(同一空间再"发布"无意义)。
 */
const canPublish = computed(() => {
  const page = pagesStore.getPage(props.node.id)
  if (!page) return false
  const sourceSpace = spacesStore.spaces.value.find((s) => s.id === page.spaceId)
  if (!sourceSpace || sourceSpace.kind !== 'personal') return false
  return spacesStore.spaces.value.some(
    (s) => s.kind !== 'personal' && s.id !== page.spaceId,
  )
})

const currentPage = computed<PageNode | undefined>(() =>
  pagesStore.getPage(props.node.id),
)

// 当外部关闭重命名(比如点别处),把输入值还原
watch(isRenaming, (val) => {
  if (val) renameValue.value = props.node.title
})
</script>

<template>
  <div class="tree-branch">
    <div
      class="tree-row"
      :class="{
        active: isActive,
        'is-dragging': isDragSource,
        'drop-before': dropHint === 'before',
        'drop-after': dropHint === 'after',
      }"
      :draggable="!isRenaming"
      @click="navigate"
      @contextmenu.prevent="onMoreClick"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <span
        class="caret"
        :class="{ leaf: !hasChildren, open: isExpanded && hasChildren }"
        @click="toggleCaret"
      >
        <span v-if="hasChildren" class="material-symbols-outlined icon-md">chevron_right</span>
      </span>
      <span class="material-symbols-outlined doc-icon" style="font-size:18px">description</span>
      <input
        v-if="isRenaming"
        ref="renameInputRef"
        v-model="renameValue"
        class="rename-input"
        @click.stop
        @blur="commitRename"
        @keydown="onRenameKey"
      />
      <span v-else class="label">{{ node.title }}</span>
      <button
        v-show="!isRenaming"
        class="menu-btn"
        title="更多操作"
        @click="onMoreClick"
      >
        <span class="material-symbols-outlined icon-md">more_horiz</span>
      </button>
    </div>

    <!-- 菜单 (position: fixed) -->
    <template v-if="isMenuOpen">
      <div class="menu-backdrop" @click="uiStore.closeMenu()"></div>
      <div class="menu" :style="menuStyle" @click.stop>
        <button class="menu-item" @click="addSibling">
          <span class="material-symbols-outlined icon-md">add</span>
          <span>添加同级页面</span>
        </button>
        <button class="menu-item" @click="addChild">
          <span class="material-symbols-outlined icon-md">subdirectory_arrow_right</span>
          <span>在此页下添加子页面</span>
        </button>
        <button class="menu-item" v-if="node.parentId !== null" @click="promoteToRoot">
          <span class="material-symbols-outlined icon-md">format_indent_decrease</span>
          <span>提升为根级</span>
        </button>
        <div class="menu-sep"></div>
        <button class="menu-item" @click="startRename">
          <span class="material-symbols-outlined icon-md">edit</span>
          <span>重命名</span>
        </button>
        <button
          v-if="canPublish"
          class="menu-item"
          @click="openPublishTo"
        >
          <span class="material-symbols-outlined icon-md">publish</span>
          <span>发布到...</span>
        </button>
        <button class="menu-item" @click="openInNewTab">
          <span class="material-symbols-outlined icon-md">open_in_new</span>
          <span>在新窗口打开</span>
        </button>
        <button class="menu-item" @click="copyLink">
          <span class="material-symbols-outlined icon-md">{{ copyFlash === null ? 'link' : 'check' }}</span>
          <span>{{ copyFlash ?? '复制链接' }}</span>
        </button>
        <div class="menu-sep"></div>
        <button
          class="menu-item danger"
          :disabled="hasLiveChildren"
          :title="hasLiveChildren ? '请先删除子页面' : '删除此页面(可在回收站恢复)'"
          @click="deletePage"
        >
          <span class="material-symbols-outlined icon-md">delete</span>
          <span>删除</span>
        </button>
      </div>
      <PublishToSpaceMenu
        v-if="publishToOpen && currentPage"
        :page="currentPage"
        :anchor="publishToAnchor"
        @close="closePublishTo"
      />
    </template>

    <div v-if="hasChildren && isExpanded" class="tree-children">
      <PageTree
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'PageTree' }
</script>

<style scoped>
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 199;
  background: transparent;
}

.menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  color: var(--text-3);
}
.menu-item:disabled:hover {
  background: transparent;
  color: var(--text-3);
}

/* ─── Drag & drop ────────────────────────────────────────────────────── */
.tree-row.is-dragging { opacity: 0.4; }
.tree-row.drop-before {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.tree-row.drop-after {
  box-shadow: inset 0 -2px 0 0 var(--accent);
}
</style>


