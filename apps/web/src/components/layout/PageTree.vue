<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useConfirm } from '@/composables/useConfirm'
import { usePageTreeDrag, type DropHint } from '@/composables/usePageTreeDrag'
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
// tree-expanded state is keyed by activeSpaceId (Stage 7); each space keeps
// its own expansion set so collapsing team-space tree doesn't affect personal.
const spaceId = computed(() => spacesStore.activeSpaceId.value ?? '')
// 当前页所在 space(从 pages.value 反查)。用于 isChildrenLoaded 的 cache key。
const currentSpaceId = computed(() => {
  const page = pagesStore.getPage(props.node.id)
  return page?.spaceId ?? spacesStore.activeSpaceId.value ?? null
})
const isExpanded = computed(() => uiStore.isExpanded(spaceId.value, props.node.id))
/**
 * 是否显示 caret + 展开按钮。完全用服务端的 `hasChildren`(EXISTS 子查询
 * 计算的真实子节点存在性),不用 children 数组 —— 懒加载模式下 children
 * 数组在用户展开前都是空的,拿它判断会让 leaf 节点也显示 caret,误导用户
 * 点开发现是空的。
 *
 * 乐观插入的页(server 还没回响应)hasChildren 是 undefined,这里 fallback
 * 为 false 不显示 caret —— 新建页肯定没子,这个 fallback 是正确的。
 */
const hasChildren = computed(() => {
  const page = pagesStore.getPage(props.node.id)
  return page?.hasChildren === true
})
const isActive = computed(() => route.params.id === props.node.id)
const isMenuOpen = computed(() => uiStore.openMenuId === props.node.id)
const isRenaming = computed(() => uiStore.renamingId === props.node.id)

// 懒加载状态:展开一个未加载过的父节点时显示小 spinner
const loadingChildren = ref(false)

const renameValue = ref(props.node.title)
const renameInputRef = ref<HTMLInputElement | null>(null)

/* ─── Drag & drop ──────────────────────────────────────────────────────
 *  HTML5 drag API, scoped to row drags inside the tree. Drop semantics
 *  (Confluence / Notion 3-zone),适用于任何行 — root 行也能接收子节点:
 *    - top 1/3 of row    → insert BEFORE this row (same parent)
 *    - middle 1/3 of row → drop AS CHILD of this row (newParentId = target)
 *    - bottom 1/3 of row → insert AFTER this row (same parent)
 *
 *  dragState / autoExpandTimer 来自 usePageTreeDrag(module-scope 共享,
 *  详见 composables/usePageTreeDrag.ts)。如果放回 <script setup> 内部
 *  reactive 创建 → 退化为 per-instance → drop 永不触发(原 bug)。
 */
const { dragState, autoExpandTimer } = usePageTreeDrag()

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
  if (autoExpandTimer.value) {
    clearTimeout(autoExpandTimer.value)
    autoExpandTimer.value = null
  }
  dragState.draggingId = null
  dragState.dropTarget = null
}

function onDragOver(e: DragEvent) {
  // dragState 是 module-scope 共享(见 usePageTreeDrag.ts),source 行设的
  // draggingId 在任何其他 PageTree 实例都能读到。这里必须 preventDefault,
  // 否则浏览器不会触发 drop —— 这是原来 bug 的根因。
  if (dragState.draggingId === null) return       // 没在拖
  if (dragState.draggingId === props.node.id) return  // source 行(自己不管自己)
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const row = e.currentTarget as HTMLElement
  const rect = row.getBoundingClientRect()
  const third = rect.height / 3
  const relY = e.clientY - rect.top
  // 任何行(root 或嵌套)都可以接收"成为其子节点"。中 1/3 = child,前后 1/3 = 兄弟。
  // 早先版本对 parentId === null 的 root 行把中 1/3 强制当 before/after,理由是
  // "root 没有 parent 所以没有 child 概念"——但 target 行的 parentId 与它能否
  // 接收子节点无关,root 行完全可以有子(子节点的 parentId 就是 root.id,非 null)。
  // 那条规则让 case 1(无子的 root 行之间互拖)和 case 2(root 上的非空折叠父节点
  // 接收新子)都失效 —— 用户把 page 拖到中 1/3 期待"成为子",实际变成"插入后面"。
  const position: DropHint =
    relY < third ? 'before' : relY > 2 * third ? 'after' : 'child'
  if (dragState.dropTarget?.id !== props.node.id || dragState.dropTarget.position !== position) {
    dragState.dropTarget = { id: props.node.id, position }
    // 中区 hover 折叠节点 → 300ms 后自动展开(用户预知落点)
    if (position === 'child' && !isExpanded.value) {
      scheduleAutoExpand()
    } else if (autoExpandTimer.value) {
      // 移到了非中区,取消待执行的展开
      clearTimeout(autoExpandTimer.value)
      autoExpandTimer.value = null
    }
  }
}

function onDragLeave(e: DragEvent) {
  // relatedTarget can be null when leaving the window — treat that as a clean exit.
  if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return
  if (dragState.dropTarget?.id === props.node.id) {
    dragState.dropTarget = null
    if (autoExpandTimer.value) {
      clearTimeout(autoExpandTimer.value)
      autoExpandTimer.value = null
    }
  }
}

/**
 * 中区 hover 折叠节点 300ms 后自动展开(并按需懒加载)。让用户在被 drop 前
 * 看到目标节点的现有子节点,落点直观。
 */
function scheduleAutoExpand() {
  if (autoExpandTimer.value) clearTimeout(autoExpandTimer.value)
  autoExpandTimer.value = setTimeout(async () => {
    autoExpandTimer.value = null
    // Re-check:用户在 300ms 内可能移到了 before/after 或离开了
    if (
      dragState.dropTarget?.id !== props.node.id ||
      dragState.dropTarget.position !== 'child'
    ) return
    uiStore.toggle(spaceId.value, props.node.id)
    if (!pagesStore.isChildrenLoaded(props.node.id, currentSpaceId.value)) {
      loadingChildren.value = true
      try {
        await pagesStore.ensureChildrenLoaded(props.node.id)
      } catch {
        // banner 由 store 处理
      } finally {
        loadingChildren.value = false
      }
    }
  }, 300)
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  const target = dragState.dropTarget
  const draggedId = dragState.draggingId
  if (autoExpandTimer.value) {
    clearTimeout(autoExpandTimer.value)
    autoExpandTimer.value = null
  }
  dragState.draggingId = null
  dragState.dropTarget = null
  if (!target) return
  if (!draggedId || draggedId === target.id) return

  const targetPage = pagesStore.getPage(target.id)
  if (!targetPage) return

  // Refuse cycles: can't drop a page onto itself or one of its descendants.
  if (isAncestor(draggedId, target.id)) return

  // 'child' 位置 → 作为目标节点的子节点插入到该 parent 子列表末尾
  // before/after → 作为 target 的兄弟,target 的 parent 即新 parent
  const newParentId = target.position === 'child' ? target.id : targetPage.parentId
  // Siblings 必须按 spaceId 过滤,不能只看 parentId —— pagesStore.pages 是
  // 全局所有 space 的页(普通用户 + admin 都能见多个 space),如果只按
  // parentId 过滤,跨 space 的根页会混进 siblings,findIndex 返回的是
  // 全局索引。本地乐观更新会用这个全局索引当 order 写回,server clamp
  // 后只覆盖移动页的 order,siblings 的高 order 不动 → 移动页变最顶。
  // 源页和目标页必须同 space(跨 space 走 movePageToSpace,本路径不支持)。
  const sourcePage = pagesStore.getPage(draggedId)
  if (!sourcePage) return
  const spaceId = sourcePage.spaceId
  if (targetPage.spaceId !== spaceId) {
    // 跨 space 拖拽:UI 没禁用,但语义上是另一个流程(发布到),这里静默拒绝
    // 避免发出一个会被 server 拒掉的请求 + 一次无意义的乐观更新。
    return
  }
  const siblings = pagesStore.pages
    .filter((p) => p.spaceId === spaceId && p.parentId === newParentId && p.id !== draggedId)
    .sort((a, b) => a.order - b.order)
  let insertAt: number
  if (target.position === 'child') {
    insertAt = siblings.length
  } else {
    insertAt = siblings.findIndex((p) => p.id === target.id)
    if (insertAt < 0) insertAt = siblings.length
    if (target.position === 'after') insertAt += 1
  }

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

async function toggleCaret(e: MouseEvent) {
  e.stopPropagation()
  if (!hasChildren.value) return
  uiStore.toggle(spaceId.value, props.node.id)
  // 第一次展开时如果 children 还没加载过 → 懒加载
  if (!pagesStore.isChildrenLoaded(props.node.id, currentSpaceId.value)) {
    loadingChildren.value = true
    try {
      await pagesStore.ensureChildrenLoaded(props.node.id)
    } catch {
      uiStore.setError('加载子页面失败')
    } finally {
      loadingChildren.value = false
    }
  }
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
  uiStore.expand(spaceId.value, props.node.id)
  try {
    const p = await pagesStore.createPage({ parentId: props.node.id })
    router.push(`/p/${p.id}/edit`)
  } catch {
    // banner already shown by store
  }
}

async function addSibling() {
  uiStore.closeMenu()
  // 「添加同级」必须在 *node 自己的 parent* 下,而不是 root。如果 node
  // 本身就是 root(parentId === null),这条路径就退化为「加根级」——
  // 这跟 root 上 ⋯ 菜单的预期一致。之前的实现写死 parentId: null
  // 是 bug:在深层节点上点「添加同级」会跳到空间根,跟文案不符。
  try {
    const p = await pagesStore.createPage({ parentId: props.node.parentId })
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

async function duplicatePage() {
  uiStore.closeMenu()
  try {
    // Mirror the post-success navigation pattern from publishPageToSpace:
    // land on the new copy's read view so the user immediately sees the
    // 复制自-prefixed title with the duplicated content. Failures
    // surface via the store's `ui().setError` banner — no inner catch.
    const created = await pagesStore.duplicatePage(props.node.id)
    await router.push(`/p/${created.id}`)
  } catch {
    // banner shown by store; user can retry from the menu
  }
}

function deletePage() {
  uiStore.closeMenu()
  // Stage 5: refuse to delete a page with non-trashed children. The server
  // also enforces this (409 has_children) but UX is much better if the
  // menu item itself is disabled (see template below) — this branch only
  // fires if the menu was reached some other way (keyboard, automation).
  // `liveDescendantCount` is pre-computed in pagesStore.getTree() during
  // the post-order walk, so we read it directly instead of doing a BFS.
  if (props.node.liveDescendantCount > 0) {
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
 * Live-descendant count for `id`. Read off the precomputed
 * `liveDescendantCount` field on the current TreeNode (populated by
 * pagesStore.getTree's post-order walk). Used to gate the delete action
 * and disable the menu item when a page still has live children.
 */
const hasLiveChildren = computed(() => props.node.liveDescendantCount > 0)

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
      :data-page-id="node.id"
      :class="{
        active: isActive,
        'is-dragging': isDragSource,
        'drop-before': dropHint === 'before',
        'drop-after': dropHint === 'after',
        'drop-child': dropHint === 'child',
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
        <button class="menu-item" @click="duplicatePage">
          <span class="material-symbols-outlined icon-md">content_copy</span>
          <span>复制页面</span>
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
      <div v-if="loadingChildren" class="loading-row">
        <span class="material-symbols-outlined icon-sm spin">progress_activity</span>
      </div>
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
.tree-row { position: relative; }
.tree-row.is-dragging { opacity: 0.4; }
/* before / after:细线 + 两端三角箭头(Confluence 风) */
.tree-row.drop-before,
.tree-row.drop-after {
  position: relative;
}
.tree-row.drop-before { box-shadow: inset 0 2px 0 0 var(--accent); }
.tree-row.drop-after { box-shadow: inset 0 -2px 0 0 var(--accent); }
.tree-row.drop-before::before,
.tree-row.drop-before::after,
.tree-row.drop-after::before,
.tree-row.drop-after::after {
  content: '';
  position: absolute;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--accent);
  pointer-events: none;
}
.tree-row.drop-before::before { left: 18px; top: -2px; }
.tree-row.drop-before::after { right: 4px; top: -2px; }
.tree-row.drop-after::before { left: 18px; bottom: -2px; }
.tree-row.drop-after::after { right: 4px; bottom: -2px; }
/* child:整行高亮 + 左侧 3px accent 条 */
.tree-row.drop-child {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}

/* ─── Lazy-load spinner ──────────────────────────────────────────────── */
.loading-row {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 8px 0 4px;
  color: var(--text-3);
}
.loading-row .spin {
  animation: spin 0.9s linear infinite;
  font-size: 14px;
  margin-left: 4px; /* 对齐 .tree-row 的 doc-icon 位置 */
}
.icon-sm {
  font-size: 14px;
  width: 14px;
  height: 14px;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>


