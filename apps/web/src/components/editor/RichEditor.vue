<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import extensions from '@/editor/extensions'
import { normalizeLegacyMarks } from '@/editor/htmlToJson'
import { uploadAndInsert, isAllowedFile, UploadError } from '@/editor/uploadAndInsert'
import type { UploadErrorKind } from '@/editor/uploadAndInsert'
import { useActivePageId } from '@/composables/useActivePageId'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import { useUploadsStore } from '@/stores/uploads'
import { MAX_UPLOAD_BYTES_DEFAULT } from '@power-wiki/shared'
import { formatBytes } from '@/editor/imageAttachmentExtension'

const toast = useToast()
const { confirm: askConfirm } = useConfirm()
const uploadsStore = useUploadsStore()
import SlashMenu from './SlashMenu.vue'
import EditorBubbleMenu from './EditorBubbleMenu.vue'

/**
 * 把 UploadError / 其它 Error 的 kind 翻译成人话文案 —— 模块 6 P0-2。
 * 单一事实来源,RichEditor.runUpload catch + UploadStatus 显示失败时
 * 都走这里,避免「网络中断」和「服务不可达」被笼统说成「上传失败」。
 */
function humanizeUploadError(err: unknown): string {
  if (err instanceof UploadError) {
    switch (err.kind) {
      case 'size_exceeded':
        return `文件超过 ${formatBytes(MAX_UPLOAD_BYTES_DEFAULT)} 上限,请压缩或换小文件`
      case 'mime_not_allowed':
        return `不支持的文件类型${err.detail ? `(${err.detail})` : ''}`
      case 'network_error':
        return '网络中断,请检查连接后重试'
      case 'server_unavailable':
        return '存储服务暂不可达,请稍后重试'
      case 'upload_failed':
        return `上传被拒绝${err.detail ? `(HTTP ${err.detail})` : ''},请重试`
    }
  }
  return '上传失败,请重试'
}

// @tiptap/vue-3 的 useEditor 返回 Ref<Editor> 但其 Editor 类型与 @tiptap/core 的
// Editor 在 marks/props 上不完全一致(实际可互转),这里直接用 core 的 Editor,
// 比 `any` 安全得多。

const props = defineProps<{
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, unknown>): void
  (e: 'update:html', html: string): void
  (e: 'ready', editor: Editor): void
  (e: 'word-count', value: { words: number }): void
  // 编辑器挂载 / 内容 setContent 后,ProseMirror DOM 已就绪;
  // 父组件用这个事件抓 .ProseMirror 节点(TocPanel scroll-spy 依赖它)
  (e: 'content-mount'): void
}>()

// 字数统计:中文按字符计,英文按词计(行业惯例)
function computeWordCount(html: string): { words: number } {
  // 去掉 HTML 标签和代码块内容(代码不算字数)
  const noTags = html.replace(/<[^>]+>/g, '')
  const noCode = noTags.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '')
  // 还原常见转义,用于正确切词
  const text = noCode
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  const cjk = (text.match(/[一-龥㐀-䶿]/g) || []).length
  // 英文/数字/拼音词:连续 ASCII 字母或数字
  const en = (text.match(/[A-Za-z0-9]+/g) || []).length
  return { words: cjk + en }
}

// 防抖:编辑后 800ms 同步到父组件 / store
let saveTimer: number | null = null
function scheduleSave(editor: Editor) {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const json = editor.getJSON()
    const html = editor.getHTML()
    emit('update:modelValue', json as Record<string, unknown>)
    emit('update:html', html)
    emit('word-count', computeWordCount(html))
  }, 800)
}

const { activePageId } = useActivePageId()

// 附件上传:从 paste / drop 拿到的 File 走 uploadAndInsert 三步流程。
// 进度实时写进 uploadStore,UploadStatus 组件渲染进度条 + 失败重试。
// 成功时不需要单独 toast —— uploadAndInsert 已把节点插入到编辑器里
// (可见反馈),并从 store 移除 task。
async function runUpload(file: File, pos?: number) {
  const ed = editor.value
  const pageId = activePageId.value
  if (!ed || !pageId) return
  // 注册 task;retry 闭包持有 file / pos,失败时点重试按钮即原地重跑
  // runUpload。多次重试不会产生新 task —— store.retry 复用同一个 id,
  // 这样 UploadStatus 上同一行的「重试」按钮一直可见。
  const taskId = uploadsStore.start({
    filename: file.name || '附件',
    sizeBytes: file.size,
    retry: () => { void runUpload(file, pos) },
  })
  try {
    await uploadAndInsert(file, ed, pageId, pos, (loaded, total) => {
      uploadsStore.updateProgress(taskId, loaded, total)
    })
    uploadsStore.complete(taskId)
  } catch (err) {
    console.error('[RichEditor] attachment upload failed', err)
    const kind: UploadErrorKind | undefined =
      err instanceof UploadError ? err.kind : undefined
    const detail = err instanceof UploadError ? err.detail : undefined
    uploadsStore.fail(taskId, kind ?? 'upload_failed', detail)
    // 同时挂 toast 让用户立即看到 —— UploadStatus 在 EditView 顶部,
    // 用户可能视线不在那。toast 复用 errorWithAction(模块 2 P0-2)
    // 让用户从 toast 也能直接重试。
    toast.errorWithAction(`「${file.name || '附件'}」${humanizeUploadError(err)}`, {
      label: '重试',
      onClick: () => uploadsStore.retry(taskId),
    })
  }
}

/**
 * 从粘贴的 text/html / text/plain 里提取外部图片 src。只看白名单外的
 * 协议(https / http / data / blob 等),内部 `/api/attachments/*` 视为合法
 * —— 不需要二次上传。返回第一个外部 src,没有则返回 null。
 */
function extractExternalImageSrc(html: string, textUrl: string): string | null {
  // 1) HTML 优先:浏览器复制网页图片时同时塞 HTML + text,HTML 信息完整
  if (html) {
    const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)
    if (m && m[1] && !m[1].startsWith('/api/attachments/')) return m[1]
  }
  // 2) text/plain 兜底:某些浏览器(Mac Safari 复制纯图片)只给 URL
  if (textUrl && /^https?:\/\//i.test(textUrl) && /\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i.test(textUrl)) {
    return textUrl
  }
  return null
}

/**
 * 外部图片粘贴拦截的引导:弹 confirm 让用户选择「选文件上传」或「取消」。
 * 选文件后调 runUpload(走正常上传 pipeline);取消则什么都不做。
 * 确认对话框是已有的 ConfirmDialog,不需要新组件。
 */
async function promptUploadInstead(src: string): Promise<void> {
  const preview = src.length > 60 ? src.slice(0, 60) + '…' : src
  const ok = await askConfirm({
    title: '外部图片无法直接粘贴',
    message: `出于安全考虑,power-wiki 不支持粘贴外部 URL 图片(${preview})。请改用本地上传:把图片文件拖入编辑器,或点击「上传附件」从本地选择。`,
    confirmText: '上传附件',
    cancelText: '取消',
  })
  if (!ok) return
  triggerFilePicker()
}

/**
 * 触发隐藏的 file input 让用户从本地选附件。选完走 runUpload。
 * 单一 input 复用,挂到 body(组件卸载时清理)。accept 限定 image/* 是
 * 引导「外图上传」场景;但本地选文件可能选其它类型,实际 MIME 由
 * uploadAndInsert 的 isAllowedFile 守门。
 */
let fileInputEl: HTMLInputElement | null = null
function triggerFilePicker(): void {
  if (!fileInputEl) {
    fileInputEl = document.createElement('input')
    fileInputEl.type = 'file'
    fileInputEl.accept = 'image/*'
    fileInputEl.style.position = 'fixed'
    fileInputEl.style.top = '-1000px'
    fileInputEl.style.left = '-1000px'
    fileInputEl.style.opacity = '0'
    fileInputEl.setAttribute('aria-hidden', 'true')
    fileInputEl.addEventListener('change', () => {
      const file = fileInputEl?.files?.[0]
      if (file) void runUpload(file)
      // 重置 value,允许重选同一个文件
      if (fileInputEl) fileInputEl.value = ''
    })
    document.body.appendChild(fileInputEl)
  }
  fileInputEl.click()
}

const editor = useEditor({
  extensions,
  content: normalizeLegacyMarks(props.modelValue),
  editorProps: {
    attributes: {
      class: 'tiptap',
    },
    // Cmd/Ctrl+S 由 extensions.ts 的 BlockBrowserSave plugin 拦截(priority:1000),
    // 这里不再重复实现。其余快捷键放行给 Tiptap 默认 keymap。
    //
    // 粘贴图片 / 附件:剪贴板里有文件(截图 Cmd+V、复制文件)且 MIME 在白名单内
    // 时,拦截默认行为改走上传;否则放行(让 ProseMirror 处理文本 / HTML 粘贴)。
    //
    // 外部图片拦截(2026-07-16 P0):从网页「复制图片」时,剪贴板只有
    // text/html 含 `<img src="https://...">`,files 是空。CLAUDE.md
    // 硬约束:外部 URL 粘贴图片不做。直接放行会让 ProseMirror 插入
    // <img src="https://...">,read 端 sanitize 时被替换成
    // blocked-image 占位符,用户体感「图片消失了」。这里提前拦截:
    // 检测到非 /api/attachments/ 开头的 img src → 弹 confirm 引导用户
    // 改用「选文件上传」,Notion 风格。不做 fetch + 转 Blob 上传
    // (data: URL 提取 base64 在跨域/性能上不可靠,且 Notion 也要求
    // 用户重新提供文件)。
    handlePaste(_view, event) {
      const cd = event.clipboardData
      const files = cd?.files
      const file = files && files.length > 0 ? files[0] : null
      if (file && isAllowedFile(file)) {
        event.preventDefault()
        void runUpload(file)
        return true
      }
      // 剪贴板里有图(file 对象没拿到)但没有 file —— 走外部图片
      // 拦截逻辑。优先看 text/html,因为浏览器复制网页图片时会同时
      // 携带 HTML 和纯文本,前者有完整 <img> 信息;后者通常只有 URL。
      const html = cd?.getData('text/html') ?? ''
      const textUrl = cd?.getData('text/plain')?.trim() ?? ''
      const externalSrc = extractExternalImageSrc(html, textUrl)
      if (externalSrc) {
        event.preventDefault()
        void promptUploadInstead(externalSrc)
        return true
      }
      return false
    },
    // 拖拽文件进编辑区:内部节点拖动(moved=true)不管,只处理外部文件。
    // pos 用 posAtCoords 定位落点,失败则追加到末尾(pos=undefined)。
    handleDrop(view, event, _slice, moved) {
      if (moved) return false
      const files = event.dataTransfer?.files
      const file = files && files.length > 0 ? files[0] : null
      if (!file || !isAllowedFile(file)) return false
      event.preventDefault()
      const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
      void runUpload(file, coords?.pos)
      return true
    },
  },
  onUpdate({ editor }) {
    scheduleSave(editor)
  },
})

watch(
  () => props.modelValue,
  (val) => {
    const ed = editor.value
    if (!ed) return
    const current = JSON.stringify(ed.getJSON())
    if (JSON.stringify(val) !== current) {
      ed.commands.setContent(normalizeLegacyMarks(val), false)
    }
  }
)

// 暴露 editor 给父组件(toolbar 需要)
watch(editor, (val) => {
  if (val) {
    emit('ready', val)
    emit('word-count', computeWordCount(val.getHTML()))
    // EditorContent 挂完才出 .ProseMirror,等下一帧再发,
    // 父组件收到时 DOM 节点可查
    void nextTick(() => {
      // 再多等一帧,确保 ProseMirror 内部 mount 完
      requestAnimationFrame(() => emit('content-mount'))
    })
  }
}, { immediate: true })

// 拖拽手柄(DragHandle)被 tippy 挂到 body,默认常驻显示容易抢眼。
// 用 body 上的 .editor-hover 标记,只在鼠标进入编辑区时才显示手柄。
let unbindHover: (() => void) | null = null

onMounted(() => {
  const root = document.querySelector('.rich-editor') as HTMLElement | null
  if (!root) return
  const onEnter = () => document.body.classList.add('editor-hover')
  const onLeave = () => document.body.classList.remove('editor-hover')
  root.addEventListener('mouseenter', onEnter)
  root.addEventListener('mouseleave', onLeave)
  unbindHover = () => {
    root.removeEventListener('mouseenter', onEnter)
    root.removeEventListener('mouseleave', onLeave)
  }
})

onBeforeUnmount(() => {
  if (saveTimer) window.clearTimeout(saveTimer)
  unbindHover?.()
  if (fileInputEl) {
    fileInputEl.remove()
    fileInputEl = null
  }
  editor.value?.destroy()
})
</script>

<template>
  <div class="rich-editor">
    <EditorContent :editor="editor" />
    <EditorBubbleMenu v-if="editor" :editor="editor" />
    <SlashMenu :editor="editor" />
  </div>
</template>

<style scoped>
.rich-editor {
  position: relative;
}
</style>

