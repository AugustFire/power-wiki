<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import extensions from '@/editor/extensions'
import { uploadAndInsert, isAllowedFile } from '@/editor/uploadAndInsert'
import { useActivePageId } from '@/composables/useActivePageId'
import { useToast } from '@/composables/useToast'

const toast = useToast()
import SlashMenu from './SlashMenu.vue'
import EditorBubbleMenu from './EditorBubbleMenu.vue'

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
// 失败仅 alert + console(项目暂无 toast 系统)。pos 可选,drop 时定点插入。
async function runUpload(file: File, pos?: number) {
  const ed = editor.value
  const pageId = activePageId.value
  if (!ed || !pageId) return
  try {
    await uploadAndInsert(file, ed, pageId, pos)
  } catch (err) {
    console.error('[RichEditor] attachment upload failed', err)
    toast.error('附件上传失败,请重试')
  }
}

const editor = useEditor({
  extensions,
  content: props.modelValue,
  editorProps: {
    attributes: {
      class: 'tiptap',
    },
    // Cmd/Ctrl+S 由 extensions.ts 的 BlockBrowserSave plugin 拦截(priority:1000),
    // 这里不再重复实现。其余快捷键放行给 Tiptap 默认 keymap。
    //
    // 粘贴图片 / 附件:剪贴板里有文件(截图 Cmd+V、复制文件)且 MIME 在白名单内
    // 时,拦截默认行为改走上传;否则放行(让 ProseMirror 处理文本 / HTML 粘贴)。
    handlePaste(_view, event) {
      const files = event.clipboardData?.files
      const file = files && files.length > 0 ? files[0] : null
      if (!file || !isAllowedFile(file)) return false
      event.preventDefault()
      void runUpload(file)
      return true
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
      ed.commands.setContent(val, false)
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

