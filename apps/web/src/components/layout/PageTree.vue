<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useConfirm } from '@/composables/useConfirm'
import type { TreeNode } from '@power-wiki/shared'

const props = defineProps<{
  node: TreeNode
  depth?: number
}>()

const uiStore = useUiStore()
const pagesStore = usePagesStore()
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
  const descendantCount = countDescendants(props.node.id)
  const message =
    descendantCount > 0
      ? `这将同时删除 ${descendantCount} 个子页面,且无法恢复。`
      : '页面删除后无法恢复。'
  confirm({
    title: `删除「${props.node.title}」?`,
    message,
    danger: true,
    confirmText: '删除',
    cancelText: '取消',
  }).then(async (ok) => {
    if (!ok) return
    const wasCurrent = route.params.id === props.node.id
    try {
      await pagesStore.deletePage(props.node.id)
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

function countDescendants(id: string): number {
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

// 当外部关闭重命名(比如点别处),把输入值还原
watch(isRenaming, (val) => {
  if (val) renameValue.value = props.node.title
})
</script>

<template>
  <div class="tree-branch">
    <div
      class="tree-row"
      :class="{ active: isActive }"
      @click="navigate"
      @contextmenu.prevent="onMoreClick"
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
        <button class="menu-item danger" @click="deletePage">
          <span class="material-symbols-outlined icon-md">delete</span>
          <span>删除</span>
        </button>
      </div>
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
</style>


