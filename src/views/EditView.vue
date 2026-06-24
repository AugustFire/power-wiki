<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import RichEditor from '@/components/editor/RichEditor.vue'
import EditorToolbar from '@/components/editor/EditorToolbar.vue'
// Tiptap 的 vue-3 和 core Editor 类型不完全兼容,这里使用 any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{ id?: string; parentId?: string | null }>()
const pagesStore = usePagesStore()
const router = useRouter()

const localId = ref<string | null>(props.id ?? null)
const localTitle = ref<string>('')
const localJSON = ref<Record<string, unknown>>({ type: 'doc', content: [{ type: 'paragraph' }] })
const localHTML = ref<string>('<p></p>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const editorRef = ref<any>(null)

const isExisting = computed(() => !!localId.value)
const page = computed(() => (localId.value ? pagesStore.getPage(localId.value) : undefined))

const isDirty = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved'>('idle')
let savedHideTimer: number | null = null

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

function onEditorReady(ed: AnyEditor) {
  editorRef.value = ed ?? null
}

function saveDraft() {
  if (!localId.value) return
  pagesStore.updatePage(localId.value, {
    title: localTitle.value.trim() || '无标题页面',
    contentJSON: localJSON.value,
    contentHTML: localHTML.value,
  })
  isDirty.value = false
  flashSaved()
}

function publish() {
  if (!localId.value) return
  pagesStore.updatePage(localId.value, {
    title: localTitle.value.trim() || '无标题页面',
    contentJSON: localJSON.value,
    contentHTML: localHTML.value,
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
    if (!confirm('有未保存的修改,确认关闭吗?')) return
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

const showToast = ref<string | null>(null)
let toastTimer: number | null = null
function toast(msg: string) {
  showToast.value = msg
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (showToast.value = null), 1800)
}

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
    pagesStore.updatePage(localId.value!, {
      title: localTitle.value.trim() || '无标题页面',
      contentJSON: localJSON.value,
      contentHTML: localHTML.value,
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
        <template v-if="page?.parentId">
          <span class="sep">/</span>
          <span class="crumb-item">上级</span>
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
      </div>
    </div>

    <div class="layout no-toc">
      <Sidebar />

      <div class="content">
        <EditorToolbar :editor="editorRef" @close="closeEditor" @publish="publish" />

        <div class="content-inner edit-page">
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

          <div class="edit-meta-actions">
            <button class="meta-btn" @click="toast('封面功能即将上线')">
              <span class="material-symbols-outlined" style="font-size:18px">add_photo_alternate</span>
              <span>添加封面</span>
            </button>
            <button class="meta-btn" @click="toast('图标功能即将上线')">
              <span class="material-symbols-outlined" style="font-size:18px">add_reaction</span>
              <span>添加图标</span>
            </button>
          </div>

          <input
            class="edit-title-input"
            type="text"
            :value="localTitle"
            @input="onTitleInput"
            placeholder="无标题页面"
          />

          <div class="edit-byline">
            <span class="me-av" style="width:24px; height:24px; background: var(--accent); color: white; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600;">ME</span>
            <span><strong>我</strong> · 创建于 {{ new Date().toLocaleDateString('zh-CN') }}</span>
            <span class="byline-hint">·</span>
            <span class="byline-hint">输入 <code>/</code> 唤起斜杠菜单</span>
          </div>

          <RichEditor
            :model-value="localJSON"
            @update:model-value="onEditorJSON"
            @update:html="onEditorHTML"
            @ready="onEditorReady"
          />

          <div class="edit-footer">
            <div class="footer-meta">
              <span class="material-symbols-outlined" style="font-size:14px;color:var(--text-3)">info</span>
              <span>所有编辑自动保存到浏览器本地存储</span>
            </div>
            <div class="spacer"></div>
            <button class="btn ghost" @click="closeEditor">关闭</button>
            <button class="btn" @click="saveDraft">
              <span class="material-symbols-outlined" style="font-size:18px">save</span>
              保存草稿
            </button>
            <button class="btn primary" @click="publish">
              <span class="material-symbols-outlined" style="font-size:18px">publish</span>
              发布
            </button>
          </div>
        </div>
      </div>
    </div>

    <transition name="fade">
      <div v-if="showToast" class="toast">{{ showToast }}</div>
    </transition>
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
</style>