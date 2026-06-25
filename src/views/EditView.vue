<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import RichEditor from '@/components/editor/RichEditor.vue'
import EditorToolbar from '@/components/editor/EditorToolbar.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useConfirm } from '@/composables/useConfirm'
// Tiptap 的 vue-3 和 core Editor 类型不完全兼容,这里使用 any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{ id?: string; parentId?: string | null }>()
const pagesStore = usePagesStore()
const router = useRouter()
const { confirm } = useConfirm()

const localId = ref<string | null>(props.id ?? null)
const localTitle = ref<string>('')
const localJSON = ref<Record<string, unknown>>({ type: 'doc', content: [{ type: 'paragraph' }] })
const localHTML = ref<string>('<p></p>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const editorRef = ref<any>(null)

const isExisting = computed(() => !!localId.value)
const page = computed(() => (localId.value ? pagesStore.getPage(localId.value) : undefined))
const parentPage = computed(() => {
  const pid = page.value?.parentId
  if (!pid) return null
  return pagesStore.getPage(pid) ?? null
})

const isDirty = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved'>('idle')
let savedHideTimer: number | null = null
const wordCount = ref<{ chars: number; words: number }>({ chars: 0, words: 0 })

onMounted(() => {
  if (props.id) {
    const p = pagesStore.getPage(props.id)
    if (p) {
      localId.value = p.id
      localTitle.value = p.title
      localJSON.value = (p.contentJSON as Record<string, unknown>) ?? { type: 'doc', content: [{ type: 'paragraph' }] }
      localHTML.value = p.contentHTML ?? '<p></p>'
      isDirty.value = false
      return
    }
  }
  const p = pagesStore.createPage({ parentId: props.parentId ?? null })
  localId.value = p.id
  localTitle.value = p.title
  router.replace(`/p/${p.id}/edit`)
})

function onTitleInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  localTitle.value = v
  isDirty.value = true
  saveState.value = 'saving'
}

function onEditorJSON(v: Record<string, unknown>) {
  localJSON.value = v
  isDirty.value = true
  saveState.value = 'saving'
}
function onEditorHTML(html: string) {
  localHTML.value = html
}

function onEditorWordCount(v: { chars: number; words: number }) {
  wordCount.value = v
}

function onEditorReady(ed: AnyEditor) {
  editorRef.value = ed ?? null
}

function saveDraft() {
  if (!localId.value) return
  // 直接从 editor 实例读最新内容 — 绕开 RichEditor 800ms 防抖,
  // 避免「编辑后立即保存」丢掉刚改的内容
  const ed = editorRef.value
  const json = ed ? ed.getJSON() : localJSON.value
  const html = ed ? ed.getHTML() : localHTML.value
  pagesStore.updatePage(localId.value, {
    title: localTitle.value.trim() || '无标题页面',
    contentJSON: json as Record<string, unknown>,
    contentHTML: html,
  })
  isDirty.value = false
  flashSaved()
}

function publish() {
  if (!localId.value) return
  const ed = editorRef.value
  const json = ed ? ed.getJSON() : localJSON.value
  const html = ed ? ed.getHTML() : localHTML.value
  pagesStore.updatePage(localId.value, {
    title: localTitle.value.trim() || '无标题页面',
    contentJSON: json as Record<string, unknown>,
    contentHTML: html,
  })
  isDirty.value = false
  flashSaved()
  router.push(`/p/${localId.value}`)
}

function flashSaved() {
  saveState.value = 'saved'
  if (savedHideTimer) window.clearTimeout(savedHideTimer)
  savedHideTimer = window.setTimeout(() => {
    if (saveState.value === 'saved') saveState.value = 'idle'
  }, 1600)
}

function closeEditor() {
  if (isDirty.value) {
    confirm({
      title: '有未保存的修改',
      message: '关闭后当前编辑内容将丢失,确认要关闭吗?',
      danger: true,
      confirmText: '关闭',
      cancelText: '继续编辑',
    }).then((ok) => {
      if (!ok) return
      if (localId.value) {
        router.push(`/p/${localId.value}`)
      } else {
        router.push('/')
      }
    })
    return
  }
  if (localId.value) {
    router.push(`/p/${localId.value}`)
  } else {
    router.push('/')
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (isDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

watch(
  () => props.id,
  (newId) => {
    if (newId && newId !== localId.value) {
      const p = pagesStore.getPage(newId)
      if (p) {
        localId.value = p.id
        localTitle.value = p.title
        localJSON.value = (p.contentJSON as Record<string, unknown>) ?? { type: 'doc', content: [{ type: 'paragraph' }] }
        localHTML.value = p.contentHTML ?? '<p></p>'
        isDirty.value = false
        saveState.value = 'idle'
      }
    }
  }
)

let saveTimer: number | null = null
function scheduleAutoSave() {
  if (!localId.value) return
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    // 直接从 editor 读 — 避免 RichEditor 800ms 防抖还没 emit、localJSON 还是上一次的
    const ed = editorRef.value
    const json = ed ? ed.getJSON() : localJSON.value
    const html = ed ? ed.getHTML() : localHTML.value
    pagesStore.updatePage(localId.value!, {
      title: localTitle.value.trim() || '无标题页面',
      contentJSON: json as Record<string, unknown>,
      contentHTML: html,
    })
    isDirty.value = false
    flashSaved()
  }, 500)
}

watch([localTitle, localJSON, localHTML], () => {
  if (localId.value) {
    isDirty.value = true
    scheduleAutoSave()
  }
})

onBeforeUnmount(() => {
  if (saveTimer) window.clearTimeout(saveTimer)
  if (savedHideTimer) window.clearTimeout(savedHideTimer)
})
</script>

<template>
  <div class="edit-shell">
    <div class="subheader">
      <div class="breadcrumb">
        <a href="#/">我的知识库</a>
        <template v-if="parentPage">
          <span class="sep">/</span>
          <a class="crumb-item crumb-link" :href="`#/p/${parentPage.id}`" :title="parentPage.title">
            {{ parentPage.title }}
          </a>
        </template>
        <span class="sep">/</span>
        <span class="crumb-item current">{{ localTitle || '无标题页面' }}</span>
        <span class="edit-mode-badge">
          <span class="material-symbols-outlined" style="font-size:14px">edit</span>
          编辑中
        </span>
      </div>
      <div class="page-actions">
        <!-- 保存状态指示器 -->
        <div v-if="saveState === 'saving'" class="save-indicator saving">
          <span class="dot"></span>
          正在保存…
        </div>
        <div v-else-if="saveState === 'saved'" class="save-indicator saved">
          <span class="material-symbols-outlined" style="font-size:14px">check_circle</span>
          已自动保存
        </div>
        <div v-else-if="isExisting" class="save-indicator idle">
          <span class="material-symbols-outlined" style="font-size:14px">cloud_done</span>
          已同步
        </div>
        <button class="btn ghost" type="button" @click="closeEditor">关闭</button>
        <button class="btn primary" type="button" @click="publish">
          <span class="material-symbols-outlined" style="font-size:16px">publish</span>
          发布
        </button>
      </div>
    </div>

    <div class="layout no-toc">
      <Sidebar />

      <div class="content">
        <div class="content-inner edit-page">
          <EditorToolbar :editor="editorRef" @close="closeEditor" @publish="publish" />

          <div class="edit-labels">
            <span class="label-chip">
              <span class="material-symbols-outlined" style="font-size:13px">draft</span>
              草稿
            </span>
            <span class="label-chip">
              <span class="material-symbols-outlined" style="font-size:13px">person</span>
              仅我可见
            </span>
          </div>

          <input
            class="edit-title-input"
            type="text"
            :value="localTitle"
            @input="onTitleInput"
            placeholder="无标题页面"
          />

          <div class="edit-byline">
            <UserAvatar :size="24" />
            <span><strong>我</strong> · 创建于 {{ new Date().toLocaleDateString('zh-CN') }}</span>
            <span class="byline-hint">·</span>
            <span class="byline-hint">输入 <code>/</code> 唤起斜杠菜单</span>
          </div>

          <RichEditor
            :model-value="localJSON"
            @update:model-value="onEditorJSON"
            @update:html="onEditorHTML"
            @word-count="onEditorWordCount"
            @ready="onEditorReady"
          />

          <div class="edit-footer">
            <div class="footer-meta">
              <span class="material-symbols-outlined" style="font-size:14px;color:var(--text-3)">info</span>
              <span>所有编辑自动保存到浏览器本地存储</span>
              <span class="footer-sep">·</span>
              <span class="word-count">{{ wordCount.words }} 字 · {{ wordCount.chars }} 字符</span>
            </div>
            <div class="spacer"></div>
            <button class="btn ghost" @click="saveDraft">
              <span class="material-symbols-outlined" style="font-size:18px">save</span>
              保存草稿
            </button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.edit-shell { min-height: calc(100vh - var(--topbar-h)); }
.edit-page { padding-top: 16px; }

.edit-mode-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 12px;
  padding: 2px 8px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}

.byline-hint { color: var(--text-3); font-size: 13px; }
.byline-hint code {
  font-family: var(--font-mono);
  background: var(--bg-subtle);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  color: var(--text-1);
  margin: 0 2px;
}

.save-indicator.idle {
  background: var(--bg-subtle);
  color: var(--text-3);
}

.edit-footer .footer-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.edit-footer .footer-sep {
  color: var(--border);
  user-select: none;
}
.edit-footer .word-count {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
}
</style>