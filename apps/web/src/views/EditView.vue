<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import RichEditor from '@/components/editor/RichEditor.vue'
import EditorToolbar from '@/components/editor/EditorToolbar.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useConfirm } from '@/composables/useConfirm'
import { emptyDoc, EMPTY_HTML, DEFAULT_TITLE, normalizeTitle } from '@/lib/constants'
import { newId } from '@/lib/id'
// Tiptap 的 vue-3 和 core Editor 类型不完全兼容,这里使用 any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{ id?: string; parentId?: string | null }>()
const pagesStore = usePagesStore()
const router = useRouter()
const { confirm } = useConfirm()

const localId = ref<string | null>(props.id ?? null)
const localTitle = ref<string>('')
const localJSON = ref<Record<string, unknown>>(emptyDoc())
const localHTML = ref<string>(EMPTY_HTML)
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
const saveState = ref<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
let savedHideTimer: number | null = null
const wordCount = ref<{ words: number }>({ words: 0 })
const titleInputRef = ref<HTMLInputElement | null>(null)

/**
 * byline 显示的"创建于 X":现有页用 page.createdAt,新建页用当前时间。
 * 不再 hardcode new Date() (那是 P2-9 评价里指出的误导)。
 */
const bylineCreatedAt = computed(() => {
  const ts = page.value?.createdAt
  const d = typeof ts === 'number' ? new Date(ts) : new Date()
  return d.toLocaleDateString('zh-CN')
})

onMounted(async () => {
  if (props.id) {
    const p = pagesStore.getPage(props.id)
    if (p) {
      localId.value = p.id
      localTitle.value = p.title
      localJSON.value = (p.contentJSON as Record<string, unknown>) ?? emptyDoc()
      localHTML.value = p.contentHTML ?? EMPTY_HTML
      isDirty.value = false
      // 进入编辑页直接聚焦标题,用户不用先点一下
      // 等下一帧让 Tiptap 完成挂载,避免抢焦点导致 editor blur
      requestAnimationFrame(() => titleInputRef.value?.focus())
      return
    }
  }
  // Stage B.3: 新建页面用客户端 nanoid 立即跳,不等后端 round-trip。
  // 之前要等 200-500ms createPage 返回才有 localId,URL 才会更新,编辑器
  // 一直空着。现在 id 立刻拿到 → router.replace 同步执行 → 用户马上可写。
  // 后端会复用同一个 id(Pages POST 入参 id 可选,见 schemas.ts),所以
  // 不会因为 id 漂移触发后续 reload。
  const clientId = newId()
  localId.value = clientId
  localTitle.value = DEFAULT_TITLE
  router.replace(`/p/${clientId}/edit`)
  // 编辑器立刻可用
  requestAnimationFrame(() => titleInputRef.value?.focus())
  try {
    await pagesStore.createPage({ id: clientId, parentId: props.parentId ?? null })
  } catch {
    // store 已经弹 banner;把路由退回首页,避免后续 PATCH 一个不存在的 id
    router.replace('/')
  }
})

function onTitleInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  localTitle.value = v
  isDirty.value = true
  // 进入"待保存"态:有改动但 500ms 防抖还没 fire
  // 真正的 saving 态由 scheduleAutoSave 的 timer 回调里设置
  if (saveState.value !== 'saving' && saveState.value !== 'saved') {
    saveState.value = 'pending'
  }
}

function onEditorJSON(v: Record<string, unknown>) {
  localJSON.value = v
  isDirty.value = true
  if (saveState.value !== 'saving' && saveState.value !== 'saved') {
    saveState.value = 'pending'
  }
}
function onEditorHTML(html: string) {
  localHTML.value = html
}

function onEditorWordCount(v: { words: number }) {
  wordCount.value = v
}

function onEditorReady(ed: AnyEditor) {
  editorRef.value = ed ?? null
}

async function persistNow(): Promise<boolean> {
  if (!localId.value) return false
  // 直接从 editor 实例读最新内容 — 绕开 RichEditor 800ms 防抖,
  // 避免「编辑后立即保存」丢掉刚改的内容
  const ed = editorRef.value
  const json = ed ? ed.getJSON() : localJSON.value
  const html = ed ? ed.getHTML() : localHTML.value
  try {
    await pagesStore.updatePage(localId.value, {
      title: normalizeTitle(localTitle.value),
      contentJSON: json as Record<string, unknown>,
      contentHTML: html,
    })
    isDirty.value = false
    return true
  } catch {
    // 失败时 store 已经回滚 + uiStore.setError 弹了 banner,这里只翻状态
    saveState.value = 'error'
    return false
  }
}

async function saveDraft() {
  if (!localId.value) return
  saveState.value = 'saving'
  const ok = await persistNow()
  if (ok) flashSaved()
}

async function publish() {
  if (!localId.value) return
  saveState.value = 'saving'
  const ok = await persistNow()
  if (ok) {
    flashSaved()
    router.push(`/p/${localId.value}`)
  }
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
        localJSON.value = (p.contentJSON as Record<string, unknown>) ?? emptyDoc()
        localHTML.value = p.contentHTML ?? EMPTY_HTML
        isDirty.value = false
        saveState.value = 'idle'
      }
    }
  }
)

let saveTimer: number | null = null
async function scheduleAutoSave() {
  if (!localId.value) return
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    // 防抖 fire 时才设 'saving' 态,避免假反馈
    saveState.value = 'saving'
    const ok = await persistNow()
    if (ok) flashSaved()
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
        <span class="crumb-item current">{{ localTitle || DEFAULT_TITLE }}</span>
        <span class="edit-mode-badge">
          <span class="material-symbols-outlined icon-sm">edit</span>
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
          <span class="material-symbols-outlined icon-sm">check_circle</span>
          已自动保存
        </div>
        <div v-else-if="saveState === 'error'" class="save-indicator danger" title="保存失败,顶部有错误提示">
          <span class="material-symbols-outlined icon-sm">error</span>
          保存失败
        </div>
        <div v-else-if="saveState === 'pending'" class="save-indicator pending">
          <span class="material-symbols-outlined icon-sm">edit_note</span>
          有未保存的修改
        </div>
        <div v-else-if="isExisting" class="save-indicator idle">
          <span class="material-symbols-outlined icon-sm">cloud_done</span>
          已同步
        </div>
        <button class="btn ghost" type="button" @click="closeEditor">关闭</button>
        <button class="btn primary" type="button" @click="publish">
          <span class="material-symbols-outlined icon-md">publish</span>
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
              <span class="material-symbols-outlined icon-xs">draft</span>
              草稿
            </span>
            <span class="label-chip">
              <span class="material-symbols-outlined icon-xs">person</span>
              仅我可见
            </span>
          </div>

          <input
            ref="titleInputRef"
            class="edit-title-input"
            type="text"
            :value="localTitle"
            @input="onTitleInput"
            :placeholder="DEFAULT_TITLE"
          />

          <div class="edit-byline">
            <UserAvatar :size="24" />
            <span><strong>我</strong> · 创建于 {{ bylineCreatedAt }}</span>
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
              <span>所有编辑自动保存到后端</span>
              <span class="footer-sep">·</span>
              <span class="word-count">{{ wordCount.words }} 字</span>
            </div>
            <div class="spacer"></div>
            <button class="btn ghost" @click="saveDraft">
              <span class="material-symbols-outlined icon-lg">save</span>
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
.save-indicator.pending {
  background: var(--bg-subtle);
  color: var(--text-2);
}
.save-indicator.danger {
  background: var(--danger-soft);
  color: var(--danger);
  font-weight: 600;
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
