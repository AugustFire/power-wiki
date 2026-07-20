<script setup lang="ts">
/**
 * ImportMarkdownModal —— 从单个 .md 文件导入成新页。
 *
 * 入口:
 *   - PageTree ⋯ 菜单「导入 Markdown...」(带 source row,落到该行 sibling 组)
 *   - PageTree 拖入 .md 文件(带 source row + 预填 payload)
 *   - Sidebar 底部 icon button(无 source row,落到 active space 根)
 *
 * 三选一来源:粘贴 / 选择文件 / 拖文件入 modal(简化 v1 不做)。
 * 标题自动从 textarea 第一行 `# xxx` 解析(简单正则,后端会二次校验),
 * 用户可改。提交走 `pagesStore.importPage()`,等后端响应;成功跳到新页,
 * 跳过(skipped)弹 toast 让用户改名再试。
 *
 * v1 不做:多文件 batch、目录树、frontmatter 解析、图片上传 MinIO。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useBodyLock } from '@/composables/useBodyLock'
import { useEscape } from '@/composables/useEscape'
import PathPicker from './PathPicker.vue'

const uiStore = useUiStore()
const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const router = useRouter()

const { importModalOpen, importContext } = storeToRefs(uiStore)

const text = ref('')
const filename = ref<string | null>(null)
const title = ref('')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)

/** 从 textarea 第一行 `# xxx` 抽标题;无 H1 返 null。 */
function deriveH1(s: string): string | null {
  // 跳过开头的 frontmatter
  const stripped = s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const m = stripped.match(/^#\s+(.+?)\s*$/m)
  if (!m) return null
  const t = (m[1] ?? '').trim()
  return t || null
}

const autoTitle = computed(() => {
  const fromText = deriveH1(text.value)
  if (fromText) return fromText
  if (filename.value) return filename.value.replace(/\.[^.]+$/, '')
  return ''
})

/** 用户改过 = true;modal 打开时初始化为 false。 */
const titleEdited = ref(false)
const finalTitle = computed(() => (titleEdited.value ? title.value : autoTitle.value))

const space = computed(() => {
  const sid = importContext.value?.sourceRow?.spaceId ?? importContext.value?.defaultSpaceId
  if (!sid) return null
  return spacesStore.spaces.value.find((s) => s.id === sid) ?? null
})

/** 选定的目标空间 id — 优先 chosenParent(用户可能在 picker 里切了空间 —
 * 虽然 import 流程不期望跨空间,但 picker 仍按选定 space 渲染树)。
 * fallback 到 importContext 的 sourceRow / defaultSpaceId。 */
const targetSpaceId = computed<string | null>(() => {
  return chosenParent.value?.spaceId ?? space.value?.id ?? null
})

/**
 * 用户最终选定的「父页面」:null = 根。初始化 = importContext.sourceRow
 * (Sidebar 入口是 null),可在 PathPicker 里改。submit 拿这个走 payload。
 *
 * 为什么不当场改 importContext.sourceRow:importContext 是 uiStore 持有的
 * 入口上下文(从哪个 entry 来的),chosenParent 是 modal 内部的运行时选
 * 择,两者职责不同 —— 用户关掉 modal 再开,应该回到入口默认位置,而不是
 * 上次的选择。
 */
interface SourceRow {
  id: string
  title: string
  parentId: string | null
  spaceId: string
}
const chosenParent = ref<SourceRow | null>(null)

/** PathPicker 展开状态:Sidebar 入口(无 sourceRow)默认 true,PageTree
 * 入口(已有 sourceRow)默认 false —— 后者用户已知道位置,picker 收起
 * 避免视觉噪声;前者用户没位置,picker 自动展开提示「这里要选」。 */
const pickerOpen = ref(false)

/** 面包屑路径:从 root 一路到 chosenParent。空数组 = 根。 */
const chosenParentPath = computed<{ id: string; title: string }[]>(() => {
  const parent = chosenParent.value
  if (!parent) return []
  const chain: { id: string; title: string }[] = []
  let cur: { id: string; parentId: string | null; title: string } | undefined = parent
  while (cur) {
    chain.unshift({ id: cur.id, title: cur.title })
    cur = cur.parentId ? (pagesStore.getPage(cur.parentId) as typeof cur | undefined) : undefined
  }
  return chain
})

function pickParent(id: string | null): void {
  if (id == null) {
    chosenParent.value = null
    pickerOpen.value = false
    return
  }
  const page = pagesStore.getPage(id)
  if (!page) return
  chosenParent.value = {
    id: page.id,
    title: page.title,
    parentId: page.parentId,
    spaceId: page.spaceId,
  }
  pickerOpen.value = false
}

function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value
}

const dropZoneActive = ref(false)
const pasteMaxBytes = 2_000_000
const textByteSize = computed(() => new Blob([text.value]).size)

function reset(): void {
  text.value = ''
  filename.value = null
  title.value = ''
  titleEdited.value = false
  submitting.value = false
  errorMsg.value = null
  dropZoneActive.value = false
  chosenParent.value = null
  pickerOpen.value = false
  if (fileInput.value) fileInput.value.value = ''
}

function resetAndFocus(): void {
  reset()
  const ctx = importContext.value
  // 初始化 chosenParent:PageTree 入口 = 菜单所在行(用户已经知道在哪),
  // Sidebar 入口 = null(根,picker 默认展开让用户主动选)。
  if (ctx?.sourceRow) {
    chosenParent.value = {
      id: ctx.sourceRow.id,
      title: ctx.sourceRow.title,
      parentId: ctx.sourceRow.parentId,
      spaceId: ctx.sourceRow.spaceId,
    }
    pickerOpen.value = false
  } else {
    chosenParent.value = null
    pickerOpen.value = true
  }
  if (ctx?.payload) {
    text.value = ctx.payload.text
    filename.value = ctx.payload.filename
  }
  // 等 modal 入场后再聚焦
  nextTick(() => textareaEl.value?.focus())
}

function close(): void {
  uiStore.closeImport()
}

/** Esc 关闭由 useEscape 处理;这里只兜 Ctrl/Cmd+Enter 提交 */
function onKey(e: KeyboardEvent): void {
  if (!importModalOpen.value) return
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    void submit()
  }
}
useBodyLock(importModalOpen)
useEscape(importModalOpen, close)
watch(importModalOpen, (open) => {
  if (open) {
    resetAndFocus()
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
})

function onTitleInput(e: Event): void {
  titleEdited.value = true
  title.value = (e.target as HTMLInputElement).value
}

async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > pasteMaxBytes) {
    errorMsg.value = `文件超过 2MB 上限(${(file.size / 1024 / 1024).toFixed(2)}MB)`
    return
  }
  filename.value = file.name
  // 简单走 FileReader 读成文本 — v1 不走 /upload-url,见 plan
  text.value = await file.text()
  titleEdited.value = false
  errorMsg.value = null
}

function onDropZoneOver(e: DragEvent): void {
  if (!e.dataTransfer) return
  e.preventDefault()
  dropZoneActive.value = true
}
function onDropZoneLeave(): void {
  dropZoneActive.value = false
}
async function onDropZoneDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  dropZoneActive.value = false
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (file.size > pasteMaxBytes) {
    errorMsg.value = `文件超过 2MB 上限(${(file.size / 1024 / 1024).toFixed(2)}MB)`
    return
  }
  filename.value = file.name
  text.value = await file.text()
  titleEdited.value = false
  errorMsg.value = null
}

function onBackdrop(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

async function submit(): Promise<void> {
  if (submitting.value) return
  errorMsg.value = null
  if (!text.value.trim()) {
    errorMsg.value = '请粘贴 Markdown 文本或选择一个 .md 文件'
    return
  }
  if (textByteSize.value > pasteMaxBytes) {
    errorMsg.value = `内容超过 2MB 上限(${(textByteSize.value / 1024 / 1024).toFixed(2)}MB)`
    return
  }
  const ctx = importContext.value
  if (!ctx) {
    errorMsg.value = '导入上下文丢失,请重试'
    return
  }
  // 用 chosenParent(用户在 picker 里改的可能 ≠ 入口 sourceRow)
  const parent = chosenParent.value
  const spaceId = parent?.spaceId ?? ctx.defaultSpaceId
  if (!spaceId) {
    errorMsg.value = '未选择目标 space'
    return
  }
  const payload = {
    source: (filename.value ? 'file' : 'paste') as 'file' | 'paste',
    text: text.value,
    spaceId,
    parentId: parent?.id ?? null,
    title: finalTitle.value.trim() || undefined,
    filename: filename.value ?? undefined,
  }
  submitting.value = true
  try {
    const result = await pagesStore.importPage(payload)
    if (result.created) {
      const created = result.created
      uiStore.notify('已导入新页', 'success')
      close()
      // 子页导入:先把 chosenParent(若有)展开,新页才能在侧栏里立刻可见。
      // Sidebar 的 autoExpandAndLocate watcher 在路由切换时也会兜底展开
      // 整条祖先链,但本步立即触发,modal 关闭 → 用户看到侧栏时已经是
      // 展开后的状态,不需要等 router.push 完成。root 导入(parent=null)
      // 直接进根列表,不需要展开。
      if (parent) {
        uiStore.expand(spaceId, parent.id)
        // 重新拉 parent 的完整 children,让新页进侧栏并纠正 order
        try {
          await pagesStore.ensureChildrenLoaded(parent.id)
        } catch {
          // 拉取失败不阻断跳转 — sidebar 后续 lazy load 也会纠正
        }
      }
      // 跳到新页(用 path-based 跳转避免依赖 route name,跟 duplicate 等其它
      // post-write navigation 一致)。侧栏 Sidebar.vue 的 route watcher 会再
      // 跑一次 autoExpandAndLocate 做最终定位 + scrollIntoView。
      void router.push(`/p/${created.id}`)
    } else if (result.skipped) {
      const reasonText =
        result.skipped.reason === 'duplicate_title'
          ? '已存在同名页面'
          : result.skipped.reason === 'empty'
            ? '内容为空'
            : '内容超过大小上限'
      uiStore.notify(`跳过:${reasonText}`, 'info', 4000)
      // 不关 modal,让用户改名后再试
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '导入失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="import-fade">
      <div
        v-if="importModalOpen"
        class="import-backdrop"
        @mousedown.self="onBackdrop"
      >
        <div
          class="import-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-title"
          @mousedown.stop
        >
          <header class="import-head">
            <h2 id="import-title" class="import-title">导入 Markdown</h2>
            <button
              type="button"
              class="import-close"
              aria-label="关闭"
              @click="close"
            >
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>

          <div class="import-body">
            <!-- 落点路径 + 路径选择器(Picker 展开时内嵌显示) -->
            <div class="import-row">
              <div class="import-label-row">
                <label class="import-label">目标位置</label>
                <button
                  type="button"
                  class="import-dest-change"
                  :aria-expanded="pickerOpen"
                  @click="togglePicker"
                >
                  <span class="material-symbols-outlined icon-sm">
                    {{ pickerOpen ? 'expand_less' : 'edit' }}
                  </span>
                  {{ pickerOpen ? '收起' : '更改位置' }}
                </button>
              </div>
              <div
                class="import-dest"
                :class="{ 'picker-active': pickerOpen }"
              >
                <span class="import-dest-space" :style="{ color: space?.color }">
                  {{ space?.name ?? '...' }}
                </span>
                <template v-if="chosenParentPath.length">
                  <span class="sep">/</span>
                  <span
                    v-for="(seg, i) in chosenParentPath"
                    :key="seg.id"
                    class="import-dest-seg"
                  >
                    {{ seg.title }}
                    <span v-if="i < chosenParentPath.length - 1" class="sep">/</span>
                  </span>
                </template>
                <template v-else>
                  <span class="sep">/</span>
                  <span class="import-dest-hint">根(顶层)</span>
                </template>
                <span class="sep">/</span>
                <span class="import-dest-new">新页</span>
              </div>
              <PathPicker
                v-if="pickerOpen && targetSpaceId"
                :space-id="targetSpaceId"
                :selected-id="chosenParent?.id ?? null"
                class="import-dest-picker"
                @select="pickParent"
              />
            </div>

            <!-- 来源:拖拽 + 选择文件 + textarea 三选一 -->
            <div class="import-row">
              <label class="import-label">来源</label>
              <div
                class="import-dropzone"
                :class="{ active: dropZoneActive, hasFile: !!filename }"
                @dragover="onDropZoneOver"
                @dragleave="onDropZoneLeave"
                @drop="onDropZoneDrop"
                @click="fileInput?.click()"
              >
                <span class="material-symbols-outlined dz-icon">
                  {{ filename ? 'description' : 'upload_file' }}
                </span>
                <div class="dz-text">
                  <template v-if="filename">
                    <strong>{{ filename }}</strong>
                    <span class="dz-hint">点击重新选择</span>
                  </template>
                  <template v-else>
                    <strong>点击选择 .md 文件</strong>
                    <span class="dz-hint">或拖拽文件到此处</span>
                  </template>
                </div>
                <input
                  ref="fileInput"
                  type="file"
                  accept=".md,text/markdown,text/x-markdown"
                  class="dz-input"
                  @change="onFileChange"
                />
              </div>
            </div>

            <div class="import-row">
              <label class="import-label">或粘贴 Markdown 文本</label>
              <textarea
                ref="textareaEl"
                v-model="text"
                class="import-textarea"
                rows="10"
                spellcheck="false"
                placeholder="# 标题&#10;&#10;在此粘贴 Markdown 内容..."
                @input="errorMsg = null"
              ></textarea>
              <div class="import-bytes">
                {{ (textByteSize / 1024).toFixed(1) }} KB / {{ (pasteMaxBytes / 1024 / 1024).toFixed(0) }} MB
              </div>
            </div>

            <!-- 标题 -->
            <div class="import-row">
              <label class="import-label" for="import-title-input">
                标题
                <span class="import-label-hint">
                  {{ autoTitle ? `自动从 ${filename ? '文件名' : 'H1'} 解析,可改` : '手动填写' }}
                </span>
              </label>
              <input
                id="import-title-input"
                type="text"
                class="import-title-input"
                :value="finalTitle"
                :placeholder="autoTitle || '请输入标题'"
                @input="onTitleInput"
              />
            </div>

            <!-- 错误 banner -->
            <div v-if="errorMsg" class="import-error" role="alert">
              <span class="material-symbols-outlined">error</span>
              <span>{{ errorMsg }}</span>
            </div>
          </div>

          <footer class="import-foot">
            <button
              type="button"
              class="btn ghost"
              :disabled="submitting"
              @click="close"
            >
              取消
            </button>
            <button
              type="button"
              class="btn primary"
              :disabled="submitting || !text.trim()"
              @click="submit"
            >
              <span v-if="submitting" class="ip-spinner" aria-hidden="true"></span>
              {{ submitting ? '导入中…' : '导入' }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.import-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim-2);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 32px;
}
.import-dialog {
  width: 640px;
  max-width: calc(100vw - 64px);
  max-height: calc(100vh - 64px);
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.import-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.import-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}
.import-close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.import-close:hover { background: var(--bg-canvas); }
.import-close .material-symbols-outlined { font-size: 20px; }

.import-body {
  padding: 18px 24px 8px;
  overflow-y: auto;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.import-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.import-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.import-label-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}

.import-dest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: var(--bg-subtle);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.import-dest.picker-active {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.import-dest-space { font-weight: 600; }
.import-dest-seg { color: var(--text-2); }
.import-dest-new { color: var(--accent); font-weight: 600; }
.import-dest-hint { color: var(--text-3); font-style: italic; }

.import-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.import-dest-change {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}
.import-dest-change:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.import-dest-change .material-symbols-outlined {
  font-size: 14px !important;
}

.import-dest-picker {
  margin-top: 6px;
}
.sep { color: var(--text-3); }

.import-dropzone {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1.5px dashed var(--border);
  border-radius: 8px;
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color var(--duration-fast) ease, background var(--duration-fast) ease;
  position: relative;
}
.import-dropzone:hover { border-color: var(--accent); }
.import-dropzone.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.import-dropzone.hasFile { background: var(--accent-soft); border-style: solid; border-color: var(--accent); }
.dz-icon { font-size: 24px; color: var(--text-2); flex-shrink: 0; }
.import-dropzone.active .dz-icon,
.import-dropzone.hasFile .dz-icon { color: var(--accent); }
.dz-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dz-text strong { font-size: 13px; color: var(--text-1); font-weight: 600; }
.dz-hint { font-size: 12px; color: var(--text-3); }
.dz-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  pointer-events: none;
}

.import-textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-1);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  min-height: 140px;
}
.import-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.import-bytes {
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
}

.import-title-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-1);
  font-size: 14px;
}
.import-title-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.import-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 13px;
  border-radius: 6px;
}
.import-error .material-symbols-outlined { font-size: 18px; flex-shrink: 0; }

.import-foot {
  padding: 14px 24px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
  background: var(--bg-subtle);
}
.ip-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: white;
  border-radius: 50%;
  animation: ip-spin 0.8s linear infinite;
  margin-right: 4px;
  vertical-align: middle;
}
@keyframes ip-spin { to { transform: rotate(360deg); } }

.import-fade-enter-active,
.import-fade-leave-active {
  transition: opacity var(--duration-fast) ease;
}
.import-fade-enter-active .import-dialog,
.import-fade-leave-active .import-dialog {
  transition: transform var(--duration-base) var(--ease-out);
}
.import-fade-enter-from,
.import-fade-leave-to { opacity: 0; }
.import-fade-enter-from .import-dialog,
.import-fade-leave-to .import-dialog {
  transform: translateY(-8px) scale(0.97);
}
</style>