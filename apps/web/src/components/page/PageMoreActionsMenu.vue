<script setup lang="ts">
/**
 * ReadView 顶栏 ⋮ 下拉 —— P0/5.3 重组 4 段(按使用频率降序):
 *   - 高频区:关注 toggle、页面历史
 *   - 导出:HTML / MD / PDF
 *   - 组织管理:限制 / 分享 / 移动 / 复制页面 / 复制整棵子树
 *   - 危险:删除
 *
 * 历史包袱(2026-08-03 UX 一致性整改):复制三档跟 PageTree 对齐 ——
 * 「复制页面」/「复制整棵子树」仍在菜单,「复制链接」(占比 80%)P0/5.3
 * 提到顶栏 icon 快捷按钮(跟 PageWatchButton 并列),菜单不再重复入口。
 *
 * 「关注」toggle 也搬到菜单里,跟 PageWatchButton 同步状态
 * (`watchedByMe` prop 透传) —— 顶栏的 PageWatchButton 仍是主入口,
 * 菜单里的菜单项是为了用户进 ⋯ 也能 toggle,无需先关菜单再点外面。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { PageNode } from '@power-wiki/shared'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import {
  exportPageAsHtml,
  exportPageAsMarkdown,
  exportPageAsPdf,
} from '@/lib/exportPage'

const props = withDefaults(
  defineProps<{
    page: PageNode
    canShare: boolean
    canManageRestrictions: boolean
    canMove: boolean
    canDelete: boolean
    /** 2026-08-03 UX 一致性:当前 page 是否有子页(true 时渲染「复制整棵
     *  子树」项;false 时整条不挂载)。ReadView 走 subPages.length > 0 计算
     *  后传入,跟 PageTree 菜单的「复制整棵子树」条件渲染同源。 */
    hasChildren?: boolean
    /** 顶栏 ⋯ 删除 gate —— 跟 PageTree 的 hasLiveChildren 同源语义:
     * true 时禁用「删除」菜单项 + tooltip 改为「请先删除子页面」,
     * 跟 PageTree 菜单 :disabled / :title 行为完全一致(用户在两个
     * 入口看到的删除可达性不能有分歧)。ReadView 透传
     * pagesStore.getLiveDescendantCount(pageId) > 0 的结果。 */
    hasLiveChildren?: boolean
    /** P0/5.3 关注 toggle 进菜单 —— 顶栏 PageWatchButton 仍是主入口,
     * 这里透传 page.watchedByMe 给菜单项,跟 PageWatchButton 同步状态。
     * 个人空间无 watch 语义:ReadView 传 canWatch=false,关注行不渲染,
     * 跟 PageWatchButton 的 v-if="!isPersonalSpace" 同源。 */
    watchedByMe?: boolean
    canWatch?: boolean
  }>(),
  { hasChildren: false, hasLiveChildren: false, watchedByMe: false, canWatch: true },
)

const emit = defineEmits<{
  (e: 'restrictions'): void
  (e: 'share'): void
  (e: 'delete'): void
}>()

const router = useRouter()
const uiStore = useUiStore()
const pagesStore = usePagesStore()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const busy = ref<'html' | 'md' | 'pdf' | null>(null)
// C-2:复制 in-flight 标记 —— 跟 export 的 busy 不同维度,互不阻塞。
// 用独立 ref 而不是合并进 `busy`,这样 export 进行时仍然能点复制。
const duplicating = ref(false)
// P0/5.3:关注 toggle 的 re-entry 守卫(跟 PageWatchButton 同款),
// 避免双击触发两次 store.togglePageWatch。
const togglingWatch = ref(false)

const showDeleteDivider = computed(() => props.canDelete)

function toggle() {
  open.value = !open.value
}
function close() {
  open.value = false
}
function onDocClick(e: MouseEvent) {
  if (!open.value || !rootEl.value) return
  if (!rootEl.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})

async function exportAs(fmt: 'html' | 'md' | 'pdf') {
  if (busy.value) return
  busy.value = fmt
  try {
    if (fmt === 'html') await exportPageAsHtml(props.page)
    else if (fmt === 'md') await exportPageAsMarkdown(props.page)
    else exportPageAsPdf(props.page)
    close()
  } catch (err) {
    console.error('[PageMoreActionsMenu] export failed', err)
    uiStore.notify('导出失败', 'error')
  } finally {
    busy.value = null
  }
}

function goHistory() {
  close()
  router.push(`/p/${props.page.id}/history`)
}

function doMove() {
  close()
  uiStore.openMoveDialog({ pageId: props.page.id })
}

/**
 * 复制链路 —— 跟 PageTree.duplicatePage 共用 store API,失败由 store 自
 * 己的 setError banner 兜底。本菜单的「复制页面」/「复制整棵子树」共用同一
 * 套 store + 跳转路径:
 *   - 复制页面:duplicatePage(id) — 默认(无 withChildren)
 *   - 复制整棵子树:duplicatePage(id, { withChildren: true })
 * 复制成功后导航到新页 read view,跟 PageTree 同款(立即给用户看到新页
 * 的「复制自 XXX」标题 + 落地内容)。Store 自己负责 banner 报错。
 */
async function doDuplicate(withChildren: boolean): Promise<void> {
  if (duplicating.value) return
  duplicating.value = true
  try {
    const created = await pagesStore.duplicatePage(props.page.id, { withChildren })
    await router.push(`/p/${created.id}`)
    close()
  } catch {
    // banner shown by store; user can retry from the menu
  } finally {
    duplicating.value = false
  }
}

/**
 * P0/5.3:菜单里的「关注/取消关注」toggle —— 跟 PageWatchButton 走同一份
 * store.togglePageWatch(乐观翻转 + 失败回滚 + banner 报错)。Menu 中改完
 * 顶栏 PageWatchButton 的 label / active class 也会同步(都是 reactive 透
 * 读 page.watchedByMe)。
 *
 * 个人空间无 watch 语义,ReadView 透传 watchedByMe=false 时这条不渲染
 * (v-if 在模板里包,跟 PageWatchButton 的 v-if="!isPersonalSpace" 同源)。
 */
async function onToggleWatch(): Promise<void> {
  if (togglingWatch.value) return
  togglingWatch.value = true
  try {
    await pagesStore.togglePageWatch(props.page.id)
    close()
  } finally {
    togglingWatch.value = false
  }
}

function onRestrictions() {
  close()
  emit('restrictions')
}
function onShare() {
  close()
  emit('share')
}
function onDeleteClick() {
  close()
  emit('delete')
}
</script>

<template>
  <div ref="rootEl" class="more-menu">
    <button
      type="button"
      class="btn more-trigger"
      :class="{ open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      aria-label="更多操作"
      title="更多操作"
      @click="toggle"
    >
      <span class="material-symbols-outlined icon-md">more_horiz</span>
    </button>

    <transition name="more-fade">
      <div v-if="open" class="more-popover" role="menu">
        <!-- 高频区(P0/5.3 重组):关注 toggle + 页面历史。
             无分隔线,跟前面顶栏的复制链接 icon 共同构成「最高频动作集」。
             关注 / 取消关注 toggle 透传 page.watchedByMe 决定 label + icon
             实心/空心。 -->
        <button
          v-if="canWatch"
          type="button"
          class="more-item"
          role="menuitem"
          :disabled="togglingWatch"
          @click="onToggleWatch"
        >
          <span class="material-symbols-outlined more-icon">
            {{ watchedByMe ? 'visibility_off' : 'visibility' }}
          </span>
          <span class="more-label-inline">
            {{ watchedByMe ? '取消关注' : '关注' }}
          </span>
          <span
            v-if="togglingWatch"
            class="more-spinner material-symbols-outlined"
            aria-hidden="true"
          >progress_activity</span>
        </button>
        <button
          type="button"
          class="more-item"
          role="menuitem"
          @click="goHistory"
        >
          <span class="material-symbols-outlined more-icon">history</span>
          <span class="more-label-inline">页面历史</span>
        </button>

        <div class="more-sep"></div>

        <!-- 导出:HTML / MD / PDF。 -->
        <button
          type="button"
          class="more-item"
          role="menuitem"
          :disabled="busy !== null"
          @click="exportAs('html')"
        >
          <span class="material-symbols-outlined more-icon">code</span>
          <div class="more-text">
            <div class="more-label">导出 HTML</div>
            <div class="more-meta">.html · 可离线浏览</div>
          </div>
          <span v-if="busy === 'html'" class="more-spinner material-symbols-outlined">progress_activity</span>
        </button>
        <button
          type="button"
          class="more-item"
          role="menuitem"
          :disabled="busy !== null"
          @click="exportAs('md')"
        >
          <span class="material-symbols-outlined more-icon">description</span>
          <div class="more-text">
            <div class="more-label">导出 Markdown</div>
            <div class="more-meta">.md · 适合二次编辑</div>
          </div>
          <span v-if="busy === 'md'" class="more-spinner material-symbols-outlined">progress_activity</span>
        </button>
        <button
          type="button"
          class="more-item"
          role="menuitem"
          :disabled="busy !== null"
          @click="exportAs('pdf')"
        >
          <span class="material-symbols-outlined more-icon">picture_as_pdf</span>
          <div class="more-text">
            <div class="more-label">导出 PDF</div>
            <div class="more-meta">通过打印对话框保存</div>
          </div>
          <span v-if="busy === 'pdf'" class="more-spinner material-symbols-outlined">progress_activity</span>
        </button>

        <div class="more-sep"></div>

        <!-- 组织管理:限制 / 分享 / 移动 / 复制页面 / 复制整棵子树。
             P0/5.3:复制链接提到顶栏了,这里只保留「复制页面 / 子树」两档。 -->
        <button
          v-if="canManageRestrictions"
          type="button"
          class="more-item"
          role="menuitem"
          @click="onRestrictions"
        >
          <span class="material-symbols-outlined more-icon">lock</span>
          <span class="more-label-inline">限制</span>
        </button>

        <button
          v-if="canShare"
          type="button"
          class="more-item"
          role="menuitem"
          @click="onShare"
        >
          <span class="material-symbols-outlined more-icon">share</span>
          <span class="more-label-inline">分享</span>
        </button>

        <button
          v-if="canMove"
          type="button"
          class="more-item"
          role="menuitem"
          @click="doMove"
        >
          <span class="material-symbols-outlined more-icon">drive_file_move</span>
          <span class="more-label-inline">移动</span>
        </button>

        <!-- 复制:页面 / 子树。复制链接已 P0/5.3 提到顶栏 icon,这里
             只保留跟 PageTree 语义对齐的「复制页面」/「复制整棵子树」
             两档。duplicate 期间整个 menu 禁用,跟 export 的 busy 同款
             语义:避免用户对同一页连点两次触发两次 POST(第一次 in-flight
             时第二次会撞 store 的 tempId 重复键)。 -->
        <button
          type="button"
          class="more-item"
          role="menuitem"
          :disabled="duplicating || busy !== null"
          @click="doDuplicate(false)"
        >
          <span class="material-symbols-outlined more-icon">content_copy</span>
          <span class="more-label-inline">复制页面</span>
          <span
            v-if="duplicating"
            class="more-spinner material-symbols-outlined"
            aria-hidden="true"
          >progress_activity</span>
        </button>
        <button
          v-if="hasChildren"
          type="button"
          class="more-item"
          role="menuitem"
          :disabled="duplicating || busy !== null"
          @click="doDuplicate(true)"
        >
          <span class="material-symbols-outlined more-icon">copy_all</span>
          <span class="more-label-inline">复制整棵子树</span>
          <span
            v-if="duplicating"
            class="more-spinner material-symbols-outlined"
            aria-hidden="true"
          >progress_activity</span>
        </button>

        <div v-if="showDeleteDivider" class="more-sep"></div>

        <!-- 危险区:danger 色。删除 gate 跟 PageTree 同源 —— 有未删除
             子页时禁用 + tooltip 改为「请先删除子页面」,避免出现「左
             侧 page 树禁用删除 / 顶栏 � 菜单却能点删除」的不一致。 -->
        <button
          v-if="canDelete"
          type="button"
          class="more-item more-item-danger"
          role="menuitem"
          :disabled="hasLiveChildren"
          :title="hasLiveChildren ? '请先删除子页面' : '删除此页面(可在回收站恢复)'"
          @click="onDeleteClick"
        >
          <span class="material-symbols-outlined more-icon">delete</span>
          <span class="more-label-inline">删除</span>
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.more-menu {
  position: relative;
  display: inline-flex;
}

.more-trigger {
  position: relative;
  padding: 0 8px;
}
.more-trigger.open {
  background: var(--border);
  color: var(--text-1);
}

.more-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-md);
  padding: 4px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.more-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  text-align: left;
  cursor: pointer;
  width: 100%;
  transition: background var(--duration-fast, 120ms) var(--ease-out, ease-out);
}
.more-item:hover:not(:disabled) {
  background: var(--bg-canvas);
}
.more-item:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.more-item:disabled {
  opacity: 0.5;
  cursor: progress;
}

.more-item-danger {
  color: var(--danger);
}
.more-item-danger .more-icon {
  color: var(--danger);
}
.more-item-danger:hover:not(:disabled) {
  background: var(--danger-soft);
}

.more-icon {
  font-size: 18px;
  color: var(--text-2);
  flex-shrink: 0;
}

.more-text {
  flex: 1;
  min-width: 0;
}
.more-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  line-height: 1.3;
}
.more-label-inline {
  font-size: 14px;
  color: var(--text-1);
  line-height: 1.3;
}
.more-meta {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.3;
  margin-top: 2px;
}

.more-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}

.more-spinner {
  font-size: 18px;
  color: var(--accent);
  animation: more-spin 1s linear infinite;
  flex-shrink: 0;
}
@keyframes more-spin {
  to { transform: rotate(360deg); }
}

.more-fade-enter-active,
.more-fade-leave-active {
  transition: opacity 120ms var(--ease-out, ease-out), transform 120ms var(--ease-out, ease-out);
}
.more-fade-enter-from,
.more-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>