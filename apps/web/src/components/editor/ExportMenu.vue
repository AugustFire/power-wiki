<script setup lang="ts">
/**
 * ExportMenu — ReadView 页面操作区的"导出"按钮 + popover。
 *
 * 三种导出格式,点击各自触发:
 *   - HTML  → exportPageAsHtml (含语法高亮的自包含 .html)
 *   - Markdown → exportPageAsMarkdown (.md)
 *   - PDF   → exportPageAsPdf (走 window.print(),用户选"另存为 PDF")
 *
 * Popover pattern 沿用 UserMenu.vue:
 *   - container-anchored position:absolute(不是 viewport 锚定,不需要 uiStore)
 *   - document mousedown outside-click + Esc keydown 关闭
 *   - busy 状态:导出在跑时 disable 所有项,防连点
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { exportPageAsHtml, exportPageAsMarkdown, exportPageAsPdf } from '@/lib/exportPage'

const props = defineProps<{ pageId: string }>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const busy = ref<'html' | 'md' | 'pdf' | null>(null)
const error = ref<string | null>(null)
const pagesStore = usePagesStore()

function toggle() {
  open.value = !open.value
  if (open.value) error.value = null
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
  const page = pagesStore.getPage(props.pageId)
  if (!page) return
  busy.value = fmt
  error.value = null
  try {
    if (fmt === 'html') await exportPageAsHtml(page)
    else if (fmt === 'md') await exportPageAsMarkdown(page)
    else exportPageAsPdf(page)
    close()
  } catch (err) {
    console.error('[ExportMenu] export failed', err)
    error.value = err instanceof Error ? err.message : '导出失败'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div ref="rootEl" class="export-menu">
    <button
      type="button"
      class="btn ex-trigger"
      :class="{ open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      :disabled="!pagesStore.getPage(props.pageId)"
      @click="toggle"
    >
      <span class="material-symbols-outlined icon-md">ios_share</span>
      导出
    </button>

    <transition name="ex-fade">
      <div v-if="open" class="ex-popover" role="menu">
        <button
          type="button"
          class="ex-item"
          role="menuitem"
          :disabled="busy !== null"
          @click="exportAs('html')"
        >
          <span class="material-symbols-outlined ex-icon">code</span>
          <div class="ex-text">
            <div class="ex-label">HTML</div>
            <div class="ex-meta">.html · 可离线浏览</div>
          </div>
          <span v-if="busy === 'html'" class="ex-spinner material-symbols-outlined">progress_activity</span>
        </button>

        <button
          type="button"
          class="ex-item"
          role="menuitem"
          :disabled="busy !== null"
          @click="exportAs('md')"
        >
          <span class="material-symbols-outlined ex-icon">description</span>
          <div class="ex-text">
            <div class="ex-label">Markdown</div>
            <div class="ex-meta">.md · 适合二次编辑</div>
          </div>
          <span v-if="busy === 'md'" class="ex-spinner material-symbols-outlined">progress_activity</span>
        </button>

        <button
          type="button"
          class="ex-item"
          role="menuitem"
          :disabled="busy !== null"
          @click="exportAs('pdf')"
        >
          <span class="material-symbols-outlined ex-icon">picture_as_pdf</span>
          <div class="ex-text">
            <div class="ex-label">PDF</div>
            <div class="ex-meta">通过打印对话框保存</div>
          </div>
          <span v-if="busy === 'pdf'" class="ex-spinner material-symbols-outlined">progress_activity</span>
        </button>

        <div v-if="error" class="ex-error">{{ error }}</div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.export-menu {
  position: relative;
  display: inline-flex;
}

.ex-trigger {
  /* 复用全局 .btn 的浅灰底 + 32px 高 + 6px gap;open 态用 .btn:hover 的颜色
     给出"已点击"的微反馈 */
  position: relative;
}
.ex-trigger.open {
  background: var(--border);
  color: var(--text-1);
}
.ex-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ex-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 240px;
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

.ex-item {
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
.ex-item:hover:not(:disabled) {
  background: var(--bg-canvas);
}
.ex-item:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.ex-item:disabled {
  opacity: 0.5;
  cursor: progress;
}

.ex-icon {
  font-size: 18px;
  color: var(--text-2);
  flex-shrink: 0;
}

.ex-text {
  flex: 1;
  min-width: 0;
}
.ex-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  line-height: 1.3;
}
.ex-meta {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.3;
  margin-top: 2px;
}

.ex-spinner {
  font-size: 18px;
  color: var(--accent);
  animation: ex-spin 1s linear infinite;
  flex-shrink: 0;
}
@keyframes ex-spin {
  to { transform: rotate(360deg); }
}

.ex-error {
  font-size: 12px;
  color: var(--danger);
  padding: 6px 10px;
  background: var(--danger-soft);
  border-radius: var(--radius-sm, 3px);
  margin: 4px 0 0;
}

.ex-fade-enter-active,
.ex-fade-leave-active {
  transition: opacity 120ms var(--ease-out, ease-out), transform 120ms var(--ease-out, ease-out);
}
.ex-fade-enter-from,
.ex-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
