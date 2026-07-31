<script setup lang="ts">
/**
 * ReadView 顶栏 ⋮ 下拉 —— 把低频操作(导出 / 历史 / 限制 / 分享 / 移动 /
 * 复制链接 / 删除)集中到一个 popover。简单动作内部消化,复杂动作 emit
 * 给父组件(dialog / confirm 链路)。Popover 模式镜像 ExportMenu。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { PageNode } from '@power-wiki/shared'
import { useUiStore } from '@/stores/ui'
import {
  exportPageAsHtml,
  exportPageAsMarkdown,
  exportPageAsPdf,
} from '@/lib/exportPage'

const props = defineProps<{
  page: PageNode
  canShare: boolean
  canManageRestrictions: boolean
  canMove: boolean
  canDelete: boolean
}>()

const emit = defineEmits<{
  (e: 'restrictions'): void
  (e: 'share'): void
  (e: 'delete'): void
}>()

const router = useRouter()
const uiStore = useUiStore()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const busy = ref<'html' | 'md' | 'pdf' | null>(null)

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

function copyLink() {
  const url = `${window.location.origin}${window.location.pathname}#/p/${props.page.id}`
  const onOk = () => {
    uiStore.notify('已复制链接')
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