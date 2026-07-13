<script setup lang="ts">
/**
 * PathPicker —— 「导入 Markdown」modal 内的目标位置选择器。
 *
 * 显示 active space 的页面树(根在顶,展开/收起),点行 = 选中该节点作
 * 为新页的父节点。根目录用单独的 home 行(null = parentId=null)。
 *
 * 懒加载:展开一个未加载子节点的行,触发 ensureChildrenLoaded。tree 由
 * pagesStore.getTreeForSpace() 读 pages.value 现算,所以加载完后立即
 * 出现在 UI 里。
 *
 * 故意不做:
 *   - 搜索/过滤(v1 假设 space 体量小,目测足够)
 *   - 跨空间选择(picker 锁定 importContext 那个 space,跨空间是 publish
 *     流程,不在 import 范畴)
 */
import { computed, ref } from 'vue'
import { usePagesStore } from '@/stores/pages'
import type { TreeNode } from '@power-wiki/shared'

const props = defineProps<{
  spaceId: string
  selectedId: string | null
}>()
const emit = defineEmits<{
  select: [id: string | null]
}>()

const pagesStore = usePagesStore()
const tree = computed(() => pagesStore.getTreeForSpace(props.spaceId))

interface FlatRow {
  id: string
  title: string
  depth: number
  hasChildren: boolean
  expanded: boolean
}

/** 用户展开过的节点。root 默认全部展开,让顶层结构一目了然;深层节点
 * 默认折叠,需要时再点 caret 加载(懒加载,不阻塞 picker 打开)。 */
const expanded = ref(new Set<string>())

/** 初始化:把当前 selectedId 的祖先链全展开 — 这样选中态一定可见,
 * 用户打开 picker 就能看到自己原本的位置被高亮。 */
function ensureAncestorsExpanded(id: string | null): void {
  if (!id) return
  let cur = pagesStore.getPage(id)
  const path: string[] = []
  let guard = 0
  while (cur && guard++ < 64) {
    path.push(cur.id)
    cur = cur.parentId ? pagesStore.getPage(cur.parentId) : undefined
  }
  for (const pid of path) expanded.value.add(pid)
  expanded.value = new Set(expanded.value)
}
ensureAncestorsExpanded(props.selectedId)
// 顶层根全展开(深度 0 的 roots),方便用户浏览整个 space 结构
function expandRoots(): void {
  for (const root of tree.value) expanded.value.add(root.id)
  expanded.value = new Set(expanded.value)
}
expandRoots()

const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  function walk(nodes: TreeNode[], depth: number) {
    for (const node of nodes) {
      const expandedNow = expanded.value.has(node.id)
      // hasChildren:tree 里的 children 数组非空 OR 服务端 hasChildren 标记
      // 表明后面还有子(只是还没懒加载)。后者驱动 caret 显示,点 caret 才 fetch。
      const hasLoadedChildren = node.children.length > 0
      const hasMore = hasLoadedChildren || node.liveDescendantCount > 0
      out.push({
        id: node.id,
        title: node.title,
        depth,
        hasChildren: hasMore,
        expanded: expandedNow,
      })
      if (hasLoadedChildren && expandedNow) {
        walk(node.children, depth + 1)
      }
    }
  }
  walk(tree.value, 0)
  return out
})

async function toggleExpand(id: string): Promise<void> {
  if (expanded.value.has(id)) {
    expanded.value.delete(id)
    expanded.value = new Set(expanded.value)
    return
  }
  expanded.value.add(id)
  expanded.value = new Set(expanded.value)
  // 如果子节点还没加载过,触发 fetch。fetch 完后 pages.value 更新,
  // tree computed 自动重算,flatRows 重新展开这一支。
  if (!pagesStore.isChildrenLoaded(id, props.spaceId)) {
    try {
      await pagesStore.ensureChildrenLoaded(id)
    } catch {
      // 拉子列表失败不阻断 — picker 仍可点选,失败由 store banner 兜底
    }
  }
}

function pickRoot(): void {
  emit('select', null)
}
function pickRow(id: string): void {
  emit('select', id)
}
</script>

<template>
  <div class="path-picker" role="listbox" aria-label="选择父页面">
    <button
      type="button"
      class="picker-row root-row"
      :class="{ selected: selectedId == null }"
      role="option"
      :aria-selected="selectedId == null"
      @click="pickRoot"
    >
      <span class="picker-expand-spacer" />
      <span class="material-symbols-outlined picker-icon">home</span>
      <span class="picker-title">根目录(顶层)</span>
    </button>
    <div v-for="row in flatRows" :key="row.id" class="picker-row-wrap">
      <div
        class="picker-row"
        :class="{ selected: selectedId === row.id }"
        role="option"
        :aria-selected="selectedId === row.id"
        :style="{ paddingLeft: `${8 + row.depth * 18}px` }"
        @click="pickRow(row.id)"
      >
        <button
          v-if="row.hasChildren"
          type="button"
          class="picker-expand"
          :class="{ expanded: row.expanded }"
          :aria-label="row.expanded ? '收起' : '展开'"
          @click.stop="toggleExpand(row.id)"
        >
          <span class="material-symbols-outlined">chevron_right</span>
        </button>
        <span v-else class="picker-expand-spacer" />
        <span class="material-symbols-outlined picker-icon">description</span>
        <span class="picker-title">{{ row.title }}</span>
      </div>
    </div>
    <div v-if="tree.length === 0" class="picker-empty">此空间还没有页面</div>
  </div>
</template>

<style scoped>
.path-picker {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 4px;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 26px;
  padding: 4px 8px 4px 0;
  border: 0;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  text-align: left;
  border-radius: 4px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.picker-row:hover {
  background: var(--bg-subtle);
}
.picker-row.selected {
  background: var(--accent-soft);
  color: var(--accent);
}
.picker-row.selected .picker-icon {
  color: var(--accent);
}

.picker-row.root-row {
  border-bottom: 1px dashed var(--border);
  margin-bottom: 4px;
  padding-bottom: 6px;
}

.picker-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  border-radius: 3px;
  transition: transform var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}
.picker-expand:hover {
  background: var(--bg-muted);
  color: var(--text-1);
}
.picker-expand.expanded {
  transform: rotate(90deg);
}
.picker-expand .material-symbols-outlined {
  font-size: 16px;
}

.picker-expand-spacer {
  display: inline-block;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.picker-icon {
  font-size: 16px;
  color: var(--text-3);
  flex-shrink: 0;
}

.picker-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
</style>
