<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import extensions from '@/editor/extensions'
import SlashMenu from './SlashMenu.vue'
import EditorBubbleMenu from './EditorBubbleMenu.vue'

// 避开 vue-3/core Editor 类型不兼容问题
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, unknown>): void
  (e: 'update:html', html: string): void
  (e: 'ready', editor: AnyEditor): void
}>()

// 防抖:编辑后 800ms 同步到父组件 / store
let saveTimer: number | null = null
function scheduleSave(editor: AnyEditor) {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const json = editor.getJSON()
    const html = editor.getHTML()
    emit('update:modelValue', json as Record<string, unknown>)
    emit('update:html', html)
  }, 800)
}

const editor = useEditor({
  extensions,
  content: props.modelValue,
  editorProps: {
    attributes: {
      class: 'tiptap',
    },
    // editorProps.handleKeyDown 在所有 keymap 插件之前调用。
    // 这里只拦截 Cmd/Ctrl+S,防止浏览器弹出"保存网页"对话框;
    // 其余快捷键(Cmd+B/I/U/E/Z/Y 等)放行给 Tiptap 默认 keymap。
    // 配合 extensions.ts 的 BlockBrowserSave plugin 形成双层防御。
    handleKeyDown(_view, event) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return false
      if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        return true
      }
      return false
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
  if (val) emit('ready', val)
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
