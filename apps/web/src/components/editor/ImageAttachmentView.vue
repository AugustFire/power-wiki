<script setup lang="ts">
/**
 * ImageAttachment NodeView
 *
 * 与 ReadView 渲染分支(走 renderHTML)并存,本组件只在 EditView 用。
 * 负责:
 *   1. 渲染图(IMG)/文件卡(A + icon + name + size)
 *   2. figcaption 原地编辑(空/有内容都显示 input;blur 写回 attr)
 *   3. 选中时显示 hover 工具栏:左/中/右对齐 + alt 输入 + 替换 + 删除
 *
 * 与 CalloutView 不同的关键点:
 *   - atom 节点,prose 不会让光标进入,所有交互都走 contenteditable=false 的子元素
 *   - alt 是个独立的小 popover input(避免 toolbar 太挤);onBlur 写回
 *   - 工具栏按钮都用 mousedown.prevent / @click.stop 避免 ProseMirror 把点击当成
 *     "切换 node selection",造成工具栏闪烁或焦点跳走
 *   - 删除走 setNodeSelection(pos) + deleteSelection(),标准 PM 路径
 *   - 替换走 uploadAndReplace:保留 alt / caption / align 用户元数据,
 *     只换字节属性(id / mime / 文件名 / 大小),旧 attachment best-effort 清理
 */
import { computed, nextTick, ref } from 'vue'
import { NodeViewWrapper } from '@tiptap/vue-3'
import { formatBytes } from '@/editor/imageAttachmentExtension'
import { fileIconFor } from '@/editor/attachmentIcon'
import { openAttachmentPicker } from '@/lib/attachmentPicker'
import { uploadAndReplace } from '@/editor/uploadAndInsert'
import { useActivePageId } from '@/composables/useActivePageId'
import { useToast } from '@/composables/useToast'

const toast = useToast()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

type Alignment = 'left' | 'center' | 'right'

type Attrs = {
  id: string | null
  kind: 'image' | 'file'
  mime: string
  originalFilename: string
  sizeBytes: number
  alt: string
  caption: string
  align: Alignment
}

const props = defineProps<{
  node: { attrs: Attrs }
  editor: AnyEditor
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
  selected: boolean
}>()

const attrs = computed<Attrs>(() => props.node.attrs)
const isImage = computed(() => attrs.value.kind !== 'file')
const src = computed(() => (attrs.value.id ? `/api/attachments/${attrs.value.id}/raw` : ''))
const align = computed<Alignment>(() => {
  const a = attrs.value.align
  return a === 'center' || a === 'right' ? a : 'left'
})

// ─── MIME → 图标 / 颜色 映射(只用于文件卡;图片卡统一一个 accent 图标) ───
// 单一事实来源在 apps/web/src/editor/attachmentIcon.ts,EditView 和
// renderHTML(ReadView)共用 —— 否则用户在 ReadView 看到的 PDF 红色会丢。

const fileIcon = computed(() => {
  const mime = attrs.value.mime
  if (mime.startsWith('image/')) return { icon: 'image', color: 'var(--accent)' }
  return fileIconFor(mime)
})

// ─── caption 原地编辑 ────────────────────────────────────────
const captionEditing = ref(false)
const captionDraft = ref('')
const captionInputEl = ref<HTMLInputElement | null>(null)

function startCaptionEdit() {
  captionDraft.value = attrs.value.caption || ''
  captionEditing.value = true
  nextTick(() => captionInputEl.value?.focus())
}

function commitCaption() {
  const v = captionDraft.value
  if (v !== (attrs.value.caption || '')) {
    props.updateAttributes({ caption: v })
  }
  captionEditing.value = false
}

function cancelCaption() {
  captionEditing.value = false
}

function onCaptionKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitCaption()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelCaption()
  }
}

// ─── alt 原地编辑(小 popover) ────────────────────────────────
const altEditing = ref(false)
const altDraft = ref('')
const altInputEl = ref<HTMLInputElement | null>(null)

function startAltEdit() {
  altDraft.value = attrs.value.alt || ''
  altEditing.value = true
  nextTick(() => altInputEl.value?.focus())
}

function commitAlt() {
  const v = altDraft.value
  if (v !== (attrs.value.alt || '')) {
    props.updateAttributes({ alt: v })
  }
  altEditing.value = false
}

function cancelAlt() {
  altEditing.value = false
}

function onAltKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitAlt()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelAlt()
  }
}

// ─── 对齐 + 删除 + 替换 ─────────────────────────────────────────
function setAlign(a: Alignment) {
  if (a === align.value) return
  props.updateAttributes({ align: a })
}

function remove() {
  const ed = props.editor
  if (!ed) return
  const pos = props.getPos?.()
  if (typeof pos !== 'number') return
  ed.chain().focus().setNodeSelection(pos).deleteSelection().run()
}

/**
 * Replace:打开文件选择器,选中文件走 uploadAndReplace 三步上传流程。
 * 替换时保留 alt / caption / align 等用户元数据,只换字节属性(id / mime / 文件名 / 大小)。
 * 失败统一 alert + console,跟 Toolbar / SlashMenu / paste / drop 的错误处理对齐。
 */
const { activePageId } = useActivePageId()
function replace() {
  const ed = props.editor
  const oldId = attrs.value.id
  const pageId = activePageId.value
  if (!ed || !oldId || !pageId) return
  openAttachmentPicker((file) => {
    uploadAndReplace(file, ed, oldId, pageId).catch((err) => {
      console.error('[ImageAttachmentView] replace failed', err)
      toast.error('附件替换失败,请重试')
    })
  })
}

// ─── caption 显示条件:有内容时总是显示;空但节点被选中时也显示(空 input 提示) ──
const showCaptionArea = computed(() => !!attrs.value.caption || props.selected)
</script>

<template>
  <NodeViewWrapper
    as="figure"
    class="ia-figure"
    :class="[isImage ? `attachment-image align-${align}` : 'attachment-file', { 'is-selected': selected }]"
    :data-attachment-id="attrs.id || null"
    :data-attachment-kind="attrs.kind"
    :data-attachment-mime="attrs.mime"
    :data-attachment-filename="attrs.originalFilename"
    :data-attachment-size="attrs.sizeBytes"
    :data-align="align"
    contenteditable="false"
  >
    <!-- 图片分支 -->
    <template v-if="isImage">
      <img
        :src="src"
        :alt="attrs.alt || attrs.originalFilename"
        :draggable="false"
        loading="lazy"
        decoding="async"
        class="ia-img"
      />
    </template>

    <!-- 文件卡分支。
         整张卡不再是 <a download>,否则整卡可点击区域(包括文件名/icon/空白)都
         会触发下载,误触率高。改成 <div> + 角落 hover 才浮出的下载按钮。 -->
    <div
      v-else
      class="attachment-file-card"
      :title="attrs.originalFilename"
    >
      <span
        class="material-symbols-outlined attachment-file-icon"
        :style="{ color: fileIcon.color }"
      >{{ fileIcon.icon }}</span>
      <span class="attachment-file-name">{{ attrs.originalFilename || '附件' }}</span>
      <span v-if="attrs.sizeBytes" class="attachment-file-size">{{ formatBytes(attrs.sizeBytes) }}</span>
      <!-- 显式下载按钮:hover 才显示;@mousedown.prevent + @click.stop 避免 ProseMirror
           误判为节点拖拽 / 切换选区 -->
      <a
        :href="src"
        :download="attrs.originalFilename || '附件'"
        class="attachment-file-download"
        :title="`下载 ${attrs.originalFilename}`"
        aria-label="下载附件"
        @mousedown.prevent
        @click.stop
      >
        <span class="material-symbols-outlined">download</span>
      </a>
    </div>

    <!-- caption:有内容 / 选中 → 显示;选中且空 → 虚线 input 引导输入 -->
    <figcaption
      v-if="showCaptionArea"
      class="ia-caption"
      :class="{ 'is-editing': captionEditing, 'is-empty': !attrs.caption }"
    >
      <input
        v-if="captionEditing"
        ref="captionInputEl"
        v-model="captionDraft"
        type="text"
        class="ia-caption-input"
        placeholder="输入说明…"
        @blur="commitCaption"
        @keydown="onCaptionKeydown"
        @mousedown.stop
      />
      <span
        v-else
        class="ia-caption-text"
        role="button"
        tabindex="0"
        @click="startCaptionEdit"
        @keydown.enter="startCaptionEdit"
      >{{ attrs.caption || (selected ? '点击添加说明…' : '') }}</span>
    </figcaption>

    <!-- 选中态:hover 工具栏(绝对定位,点击不触发 PM 选区切换) -->
    <div
      v-if="selected"
      class="ia-toolbar"
      contenteditable="false"
      @mousedown.stop
    >
      <div class="ia-toolbar-group" role="radiogroup" aria-label="对齐方式">
        <button
          type="button"
          class="ia-tb-btn"
          :class="{ 'is-active': align === 'left' }"
          :aria-pressed="align === 'left'"
          title="左对齐(文字绕排)"
          @click.prevent.stop="setAlign('left')"
        >
          <span class="material-symbols-outlined">format_align_left</span>
        </button>
        <button
          type="button"
          class="ia-tb-btn"
          :class="{ 'is-active': align === 'center' }"
          :aria-pressed="align === 'center'"
          title="居中"
          @click.prevent.stop="setAlign('center')"
        >
          <span class="material-symbols-outlined">format_align_center</span>
        </button>
        <button
          type="button"
          class="ia-tb-btn"
          :class="{ 'is-active': align === 'right' }"
          :aria-pressed="align === 'right'"
          title="右对齐(文字绕排)"
          @click.prevent.stop="setAlign('right')"
        >
          <span class="material-symbols-outlined">format_align_right</span>
        </button>
      </div>

      <div class="ia-toolbar-sep"></div>

      <div class="ia-toolbar-group">
        <button
          v-if="isImage"
          type="button"
          class="ia-tb-btn"
          :class="{ 'is-active': altEditing }"
          :aria-pressed="altEditing"
          :title="attrs.alt ? `Alt: ${attrs.alt}` : '设置替代文本'"
          @click.prevent.stop="altEditing ? commitAlt() : startAltEdit()"
        >
          <span class="material-symbols-outlined">image</span>
        </button>
        <input
          v-if="altEditing && isImage"
          ref="altInputEl"
          v-model="altDraft"
          type="text"
          class="ia-alt-input"
          placeholder="替代文本(可访问性 / SEO)"
          @blur="commitAlt"
          @keydown="onAltKeydown"
          @mousedown.stop
        />
      </div>

      <div class="ia-toolbar-sep"></div>

      <button
        type="button"
        class="ia-tb-btn"
        title="替换附件"
        aria-label="替换附件"
        @click.prevent.stop="replace"
      >
        <span class="material-symbols-outlined">swap_horiz</span>
      </button>

      <button
        type="button"
        class="ia-tb-btn danger"
        title="删除附件"
        aria-label="删除附件"
        @click.prevent.stop="remove"
      >
        <span class="material-symbols-outlined">delete</span>
      </button>
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.ia-figure {
  position: relative;
}
.ia-figure.is-selected {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-md);
}

.ia-img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}

/* caption 区域:常态只展示文字,鼠标悬停显示虚线编辑提示 */
.ia-caption {
  margin-top: 6px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
  min-height: 18px;
  cursor: text;
}
.ia-caption.is-editing {
  font-style: normal;
}
.ia-caption.is-empty .ia-caption-text {
  color: var(--text-3);
  opacity: 0.5;
}
.ia-caption-text {
  display: inline-block;
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  outline: 1px dashed transparent;
  outline-offset: 2px;
  transition: outline-color var(--duration-fast) ease;
}
.ia-figure:hover .ia-caption-text,
.ia-figure.is-selected .ia-caption-text {
  outline-color: var(--border);
}
.ia-caption.is-empty .ia-caption-text:hover {
  outline-color: var(--accent);
  color: var(--text-2);
}
.ia-caption-input {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  border-bottom: 1px dashed var(--accent);
  outline: 0;
  text-align: center;
  width: 100%;
  max-width: 480px;
  padding: 0 4px;
}

/* hover 工具栏:绝对定位在 figure 右上 */
.ia-toolbar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  z-index: 10;
}
.ia-toolbar-group {
  display: flex;
  align-items: center;
  gap: 1px;
}
.ia-toolbar-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}
.ia-tb-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-family: inherit;
  padding: 0;
}
.ia-tb-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.ia-tb-btn.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.ia-tb-btn.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.ia-tb-btn .material-symbols-outlined {
  font-size: 18px;
}
.ia-alt-input {
  font: inherit;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: 0;
  padding: 2px 6px;
  height: 24px;
  width: 200px;
  margin-left: 2px;
}
.ia-alt-input:focus {
  border-color: var(--accent);
}
</style>
