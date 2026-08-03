<script setup lang="ts">
/**
 * ReadView 顶栏 ⋮ 下拉 —— 把低频操作(导出 / 历史 / 限制 / 分享 / 移动 /
 * 复制 / 删除)集中到一个 popover。简单动作内部消化,复杂动作 emit
 * 给父组件(dialog / confirm 链路)。Popover 模式镜像 ExportMenu。
 *
 * 「复制」项语义(2026-08-03 UX 一致性整改):对齐 PageTree 的三档复制
 * 标签 —— 「复制页面」/「复制整棵子树」/「复制链接」。
 *   - 「复制页面」:仅本页复制,等价 PageTree.vue:722 的 primary 条目
 *   - 「复制整棵子树」:仅当 `hasChildren=true` 时渲染,等价
 *     PageTree.vue:746-757 的 more 条目
 *   - 「复制链接」:D-1 智能路由(有缓存公开 token → 公开 URL,否则内部 URL)
 * 顶栏(ReadView 顶栏 actions)单挂一个「复制页面」快捷按钮 —— 1280 视口
 * 顶栏只能塞 4 个元素,完整三档走 ⋯ 菜单。原先 C-2 设计的「行级 submenu
 * + parent/sub 两行复制动作」被用户反馈为「标签跟侧栏 PageTree 不一致」,
 * 改成扁平的 3 行 popover item,跟 PageTree 的三档复制入口一一对应。
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
  }>(),
  { hasChildren: false },
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
 * 己的 setError banner 兜底。ReadView 顶栏的「复制页面」快捷按钮 + 本
 * 菜单的「复制页面」/「复制整棵子树」共用同一套 store + 跳转路径:
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
 * D-1 (2026-08-03):智能 copyLink —— 当 page 存在 active public share 且
 * store 缓存了明文 token 时,复制公开 URL(${origin}/#/public/pages/<token>);
 * 否则回到内部 URL。ShareDialog 创建 share 后 1.2s banner 收起就丢 token
 * 的旧行为修掉:owner 「刚创建 share → 顶栏 ⋯ → 复制链接 → 给外群发」的
 * 路径现在能直接拿到正确 URL,不用再回去 ShareDialog 复制 banner。
 *
 * 失败 / cache miss 容错:list 拉失败(token 缓存空 / 网络错)→ 走内部 URL,
 * 跟 v0 行为一致;用户感知是「复制了内部链接」(legacy toast 文案保留)。
 *
 * 多 active share 场景:取最新一个的 token(由 firstActiveShareToken 内
 * 按 createdAt DESC 决定),picker UI 是后续 P2 工作量,不在 D-1 范围。
 */
async function copyLink(): Promise<void> {
  const active = await pagesStore.firstActiveShareToken(props.page.id)
  const publicUrl = active
    ? `${window.location.origin}/#/public/pages/${active.token}`
    : null
  const internalUrl = `${window.location.origin}${window.location.pathname}#/p/${props.page.id}`
  const url = publicUrl ?? internalUrl
  const onOk = () => {
    uiStore.notify(publicUrl ? '已复制公开链接' : '已复制链接')
    close()
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(onOk, fallback)
  } else {
    fallback()
  }
  function fallback() {
    const ta = document.createElement('textarea')
    ta.value = url
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      onOk()
    } catch {
      uiStore.notify('复制失败,请手动复制', 'error')
    } finally {
      document.body.removeChild(ta)
    }
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

        <button
          type="button"
          class="more-item"
          role="menuitem"
          @click="goHistory"
        >
          <span class="material-symbols-outlined more-icon">history</span>
          <span class="more-label-inline">页面历史</span>
        </button>

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

        <div class="more-sep"></div>

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

        <!-- 2026-08-03 UX 一致性:复制三档跟 PageTree 标签对齐 ——
             「复制页面」/「复制整棵子树」/「复制链接」。
             三条都挂「复制」语义组下,扁平排列(原先 C-2 设计的 submenu
             + parent row 被替换:parent row 跟「仅本页」重复触发同一动
             作,用户反馈为「冗余 + 标签不一致」)。Popover 菜单里直接
             扁平展示,跟 PageTree 的 primary/more 条目命名一一对应。

             duplicate 期间整个 menu 禁用,跟 export 的 busy 同款语义:
             避免用户对同一页连点两次触发两次 POST(第一次 in-flight 时
             第二次会撞 store 的 tempId 重复键)。 -->
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

        <button
          type="button"
          class="more-item"
          role="menuitem"
          @click="copyLink"
        >
          <span class="material-symbols-outlined more-icon">link</span>
          <span class="more-label-inline">复制链接</span>
        </button>

        <div v-if="showDeleteDivider" class="more-sep"></div>

        <button
          v-if="canDelete"
          type="button"
          class="more-item more-item-danger"
          role="menuitem"
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