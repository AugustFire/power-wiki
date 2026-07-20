<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import Sidebar from '@/components/layout/Sidebar.vue'
import TocPanel from '@/components/layout/TocPanel.vue'
import RichEditor from '@/components/editor/RichEditor.vue'
import EditorToolbar from '@/components/editor/EditorToolbar.vue'
import UploadStatus from '@/components/editor/UploadStatus.vue'
import LabelPills from '@/components/page/LabelPills.vue'
import AttachmentLightbox from '@/components/page/AttachmentLightbox.vue'
import AttachmentsSection from '@/components/page/AttachmentsSection.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useUiStore } from '@/stores/ui'
import { useConfirm } from '@/composables/useConfirm'
import { useActivePageId } from '@/composables/useActivePageId'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { useBreadcrumb } from '@/composables/useBreadcrumb'
import { emptyDoc, EMPTY_HTML, DEFAULT_TITLE, normalizeTitle } from '@/lib/constants'
import { newId } from '@/lib/id'
// Tiptap 的 vue-3 和 core Editor 类型不完全兼容,这里使用 any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{ id?: string; parentId?: string | null }>()
const pagesStore = usePagesStore()
const router = useRouter()
const uiStore = useUiStore()
const { confirm } = useConfirm()
const { set: setActivePageId } = useActivePageId()

const localId = ref<string | null>(props.id ?? null)
const localTitle = ref<string>('')
const localJSON = ref<Record<string, unknown>>(emptyDoc())
const localHTML = ref<string>(EMPTY_HTML)

/** 浏览器 tab 标题:编辑现有页 → "编辑: <title>";新建页(无 localId)
 * 时,如果用户已经输入了标题,显示 "编辑: <输入中标题>",否则退回 BASE。 */
useDocumentTitle(() => {
  if (localId.value) {
    const p = pagesStore.getPage(localId.value)
    if (p) return `编辑: ${p.title}`
  }
  if (localTitle.value.trim()) return `编辑: ${localTitle.value}`
  return null
})
/** Stage 8: dedup baseline. Whatever these refs hold is what the server
 *  most recently acknowledged for this page. `persistNow()` skips PATCH
 *  when the live editor state matches these — the 500ms debounce would
 *  otherwise fire on every edit-then-undo back to original, on editor
 *  mount (B.3 clientId pages), and on opens-without-edits, each creating
 *  a history row. Backend has its own dedup too (apps/api/src/routes/pages.ts),
 *  but the frontend dedup also saves the round-trip + UI flicker.
 *
 *  `lastSavedTitle` holds the *normalized* title (post-normalizeTitle)
 *  because that's what the server actually stores. */
const lastSavedTitle = ref<string>('')
const lastSavedJSON = ref<Record<string, unknown>>(emptyDoc())
const lastSavedHTML = ref<string>(EMPTY_HTML)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const editorRef = ref<any>(null)
// Stage 7: 右侧 TOC 锚定的 ProseMirror DOM 节点。TocPanel 用
// IntersectionObserver 做 scroll-spy,只要传一个含 h1/h2/h3 的容器即可。
// 编辑态下 heading-wrapper 是 <div class="heading-content">,TOC 会用
// 父 .heading-wrapper 的 data-level 属性识别层级。
const editorContentEl = ref<HTMLElement | null>(null)

function captureEditorEl() {
  // ProseMirror 在 mount 后才会挂到 DOM;挂完抓一次,后续 update 也会再抓
  editorContentEl.value = document.querySelector('.ProseMirror')
}

// ─── 图片附件 lightbox(ReadView 同款,EditView 镜像接入)───────
// 用 document-level capture 委托:Tiptap 自身管 click,组件 instance
// 可能因为 diff / 卸载 / 替换 漂移,直接绑到 DOM root 会被陈旧引用吞掉;
// 在 capture 阶段拦,既能抢在 Tiptap 之前处理,也能 cover ProseMirror 节点
// 重建。filter `.ProseMirror` 是为了不误吃 ReadView / 其它视图的 img(罕见,
// 因为 Edit 路由时其它视图都已 unmount,但留一道检查更稳)。
interface LightboxState {
  open: boolean
  src: string
  alt: string
  filename?: string
}
const lightbox = ref<LightboxState>({ open: false, src: '', alt: '' })
function openLightbox(state: LightboxState) {
  lightbox.value = state
}
function closeLightbox() {
  lightbox.value = { open: false, src: '', alt: '' }
}

function onAttachmentImgClickInEditor(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target) return
  if (!target.closest('.ProseMirror')) return
  const img = target.closest('.attachment-image > img') as HTMLImageElement | null
  if (!img) return
  // Tiptap 自身可能会消费这个 click(image 节点选中、focus 等),抢在它前面
  // stopPropagation,只走我们的 lightbox path。
  e.preventDefault()
  e.stopPropagation()
  const fig = img.closest('figure.attachment-image') as HTMLElement | null
  const filename = fig?.getAttribute('data-attachment-filename') || undefined
  openLightbox({ open: true, src: img.src, alt: img.alt, filename })
}
onMounted(() =>
  document.addEventListener('click', onAttachmentImgClickInEditor, true),
)
onBeforeUnmount(() =>
  document.removeEventListener('click', onAttachmentImgClickInEditor, true),
)

const isExisting = computed(() => !!localId.value)
const page = computed(() => (localId.value ? pagesStore.getPage(localId.value) : undefined))
const parentPage = computed(() => {
  const pid = page.value?.parentId
  if (!pid) return null
  return pagesStore.getPage(pid) ?? null
})

/** 面包屑链路(根 → 当前页)+ 折叠渲染。读 pageId(localId 或 parentId,
 *  新建页时 parentId 给定但 page 自身还没在 store 里)。
 *
 * EditView 的特殊点:页面本身可能在 store 里(已创建)或不在(客户端 nanoid
 * 刚生成、还没等服务端回包)。两种情况都期望看到「父 → 当前」的链路 —— 所以
 * composable 的 pageIdGetter 在没有 page 时回退到 parentId,这样新建页
 * 也能看到「我的知识库 / 父 / 未命名」的三段式。 */
const { visibleBreadcrumb } = useBreadcrumb(
  () => page.value?.id ?? props.parentId ?? null,
)

/** 「未命名 · 点此重命名」CTA:新建页 / 标题被清空时,breadcrumb 最后一段
 *  渲染为可点击按钮,点击聚焦 title input 让用户立即起名。 */
const isTitleEmpty = computed(() => localTitle.value.trim() === '')

function focusTitle(): void {
  titleInputRef.value?.focus()
  titleInputRef.value?.select()
}

const isDirty = ref(false)
const saveState = ref<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')

/**
 * case 2 修复:hydration 一次性抑制。
 *
 * onMounted 把 published 内容灌进 local refs 时会触发
 * `watch([localTitle, localJSON, localHTML])` —— 那是本视图**唯一**排
 * auto-save 的地方。此刻用户还没编辑,若照常排 auto-save,`persistNow` 读到
 * 的是 editor 归一化后的 getJSON()/getHTML()(跟 stored baseline 有细微差异)
 * → dedup 落空 → 凭空写一份「没改过」的 PATCH。置真后,watcher 首次
 * (hydration)触发被消费掉;后续真实编辑才正常排 auto-save。
 */
let justHydrated = false

/** Tiptap 编辑器 :key —— 切换编辑对象 / 强制刷新时 +1 让 RichEditor
 *  重挂载,确保 ProseMirror 内部状态跟 model-value 一致。Tiptap 的
 *  internal content 不会主动重读 model-value(只 watch 初次),必须
 *  unmount + mount 才能换骨架。 */
const editorKey = ref(0)

/**
 * Stage 8: precise dirty check. The optimistic `isDirty` flag stays true once
 * the user types anything, even if they then undo back to the original —
 * that flag is just a fast "user touched the editor" marker. For save
 * decisions (autosave, close, route-leave) we use `isContentDirty()`, which
 * compares the live local refs against `lastSaved*`. Cheap O(n) where n is
 * doc length; no `editor.getJSON()` round-trip.
 */
function isContentDirty(): boolean {
  const title = normalizeTitle(localTitle.value)
  if (title !== lastSavedTitle.value) return true
  if (localHTML.value !== lastSavedHTML.value) return true
  // JSON is the structural source of truth; HTML is canonical-rendered.
  // Compare JSON defensively — protects against the rare editor emit where
  // HTML was unchanged but JSON differed (e.g. mark normalization).
  return (
    JSON.stringify(localJSON.value ?? {}) !==
    JSON.stringify(lastSavedJSON.value ?? {})
  )
}
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
  // hydration 抑制:local refs 被首次灌值前置真,消费掉 watcher 的第一次
  // (hydration)触发,避免空打开凭空 PATCH 出 noise UPDATE。
  justHydrated = true
  if (props.id) {
    const p = pagesStore.getPage(props.id)
    if (p) {
      localId.value = p.id
      localTitle.value = p.title
      localJSON.value = (p.contentJSON as Record<string, unknown>) ?? emptyDoc()
      localHTML.value = p.contentHTML ?? EMPTY_HTML
      // Stage 8: prime dedup baseline from the loaded page so the very
      // first autosave (if it fires before any edit) is recognized as a
      // no-op and skipped.
      lastSavedTitle.value = p.title
      lastSavedJSON.value = (p.contentJSON as Record<string, unknown>) ?? emptyDoc()
      lastSavedHTML.value = p.contentHTML ?? EMPTY_HTML
      isDirty.value = false
      // 进入编辑页不需要立刻打 checkpoint —— hasUnsnapshottedEdits 必须 false,
      // 否则 idle timer fire 时会打一个「啥都没改」的 version。
      hasUnsnapshottedEdits.value = false
      // Stage 6: make this page id available to the Mention extension's
      // Suggestion plugin so @-mentions resolve against THIS page's space,
      // not the last-edited page. We re-set it whenever localId changes too
      // (see watch below) so PATCH-then-replace-title flows stay correct.
      setActivePageId(p.id)
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
  // 新页面服务端初始 title 是 ''(DB default),用 '' 起 baseline 比
  // DEFAULT_TITLE 更准 —— normalize 在 PATCH 时才跑,dedup 不该假装
  // 已经存了 DEFAULT_TITLE。
  lastSavedTitle.value = ''
  lastSavedJSON.value = emptyDoc()
  lastSavedHTML.value = EMPTY_HTML
  setActivePageId(clientId)
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
  // Precise dirty check — the user may have typed then deleted back to the
  // original, in which case `isDirty` should already be false again so the
  // "有未保存的修改" dialog at close-time doesn't pop for nothing.
  isDirty.value = isContentDirty()
  // 进入"待保存"态:有改动但 500ms 防抖还没 fire
  // 真正的 saving 态由 scheduleAutoSave 的 timer 回调里设置
  if (saveState.value !== 'saving' && saveState.value !== 'saved') {
    saveState.value = 'pending'
  }
}

function onEditorJSON(v: Record<string, unknown>) {
  localJSON.value = v
  isDirty.value = isContentDirty()
  if (saveState.value !== 'saving' && saveState.value !== 'saved') {
    saveState.value = 'pending'
  }
}
function onEditorHTML(html: string) {
  // Sync localHTML. We don't set isDirty here — that's `onEditorJSON`'s
  // job, and JSON is the source of truth for diff detection. Setting it
  // twice would race; JSON handler runs first in practice (Tiptap emits
  // JSON before HTML).
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
  const title = normalizeTitle(localTitle.value)

  // Stage 8: dedup against `lastSaved*`. The 500ms autosave debounce fires
  // even on mounts/closes-without-changes and undo cycles; without this the
  // backend would see a flood of no-op PATCHes. (Backend has its own dedup
  // as a safety net — apps/api/src/routes/pages.ts — but skipping the round
  // trip also avoids the visible "正在保存… → 已自动保存" flicker.)
  if (
    title === lastSavedTitle.value &&
    html === lastSavedHTML.value &&
    JSON.stringify(json ?? {}) === JSON.stringify(lastSavedJSON.value ?? {})
  ) {
    isDirty.value = false
    return true
  }

  try {
    await pagesStore.updatePage(localId.value, {
      title,
      contentJSON: json as Record<string, unknown>,
      contentHTML: html,
    })
    lastSavedTitle.value = title
    lastSavedJSON.value = json
    lastSavedHTML.value = html
    isDirty.value = false
    // PATCH 之后标记「还有未打 checkpoint 的改动」,由 idle 计时器或
    // route leave hook 触发 boundary snapshot(POST /:id/snapshots)。
    // Auto-save 永远静默,不直接写 page_versions —— version 只在 idle
    // / route leave 边界自动打。
    hasUnsnapshottedEdits.value = true
    scheduleIdleSnapshot()
    return true
  } catch {
    // 失败时 store 已经弹 banner,这里只翻状态
    saveState.value = 'error'
    return false
  }
}

function flashSaved() {
  saveState.value = 'saved'
  if (savedHideTimer) window.clearTimeout(savedHideTimer)
  savedHideTimer = window.setTimeout(() => {
    if (saveState.value === 'saved') saveState.value = 'idle'
  }, 1600)
}

async function closeEditor() {
  // route-leave hook 会负责 flush;这里只导航。
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
        // Stage 8: re-prime dedup baseline when navigating between pages
        // so the new page's first autosave isn't compared against the
        // previous page's lastSaved.
        lastSavedTitle.value = p.title
        lastSavedJSON.value = (p.contentJSON as Record<string, unknown>) ?? emptyDoc()
        lastSavedHTML.value = p.contentHTML ?? EMPTY_HTML
        isDirty.value = false
        saveState.value = 'idle'
        // 切到另一个 page:idle timer 还可能持有上一 page 的 callback,清掉。
        // hasUnsnapshottedEdits 也重置,避免跨 page 误触发 snapshot。
        if (idleSnapshotTimer) {
          window.clearTimeout(idleSnapshotTimer)
          idleSnapshotTimer = null
        }
        hasUnsnapshottedEdits.value = false
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

/** Version 边界:停笔 N 秒就当一个「编辑会话」结束,打一个 checkpoint
 *  (POST /:id/snapshots)。跟 Notion / Google Docs 的习惯一致 —— PATCH
 *  永远静默,version 只在 idle / route leave 这种机器化边界打。
 *  用户偏好:不提供手动「保存为版本」按钮。 */
const IDLE_SNAPSHOT_MS = 30_000
let idleSnapshotTimer: number | null = null
const hasUnsnapshottedEdits = ref(false)

function scheduleIdleSnapshot() {
  if (idleSnapshotTimer) window.clearTimeout(idleSnapshotTimer)
  idleSnapshotTimer = window.setTimeout(async () => {
    // timer fire 时如果用户已经走了(`localId` 变了,或 `flushPendingSave`
    // 已把 hasUnsnapshottedEdits 翻回 false),直接退出。
    if (!localId.value || !hasUnsnapshottedEdits.value) return
    try {
      await pagesStore.snapshotPage(localId.value)
      hasUnsnapshottedEdits.value = false
    } catch {
      // 静默。失败只是少一个 checkpoint,用户下次的 snapshot 还会
      // 自然触发。已经在 store 里弹过 ui().setError 才到这里的。
    }
  }, IDLE_SNAPSHOT_MS)
}

/**
 * Stage 7: route-leave guard. If there's a pending autosave timer, flush
 * it BEFORE the route actually changes — otherwise the user can set color /
 * type something, click "View" within the 500ms debounce window, and the
 * save never fires. The browser's `beforeunload` only covers full reloads;
 * SPA navigation needs this explicit guard.
 *
 * `persistNow()` returns true on success; we only block navigation on a
 * real save failure so the user gets to see the banner.
 *
 * 追加:flush 成功后,若仍有未打 checkpoint 的改动,补一个 boundary
 * snapshot —— 离开页面自然结束一个编辑会话。
 */
let isFlushingOnLeave = false
async function flushPendingSave(): Promise<void> {
  if (!localId.value) return
  if (saveTimer) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  if (idleSnapshotTimer) {
    window.clearTimeout(idleSnapshotTimer)
    idleSnapshotTimer = null
  }
  // 早返条件:**不**用 `!isDirty` 一刀切 —— auto-save 防抖 fire 时
  // 已经把 isDirty 翻回 false,但 hasUnsnapshottedEdits 还是 true(刚刚那次
  // PATCH 没打 boundary snapshot)。这时进 flushPendingSave 仍应补一个
  // checkpoint,所以两个 flag 都要看。
  if (!isDirty.value && !hasUnsnapshottedEdits.value) return

  isFlushingOnLeave = true
  if (isDirty.value) {
    saveState.value = 'saving'
    const ok = await persistNow()
    if (ok) flashSaved()
  }
  // 走到这里时 isDirty=false 但 hasUnsnapshottedEdits=true:刚刚那次
  // PATCH 已经成功,只需补 boundary snapshot 这一段。
  if (hasUnsnapshottedEdits.value) {
    try {
      await pagesStore.snapshotPage(localId.value)
      hasUnsnapshottedEdits.value = false
    } catch {
      /* 同 scheduleIdleSnapshot 的静默:失败不阻塞导航 */
    }
  }
  isFlushingOnLeave = false
}

onBeforeRouteLeave(async (_to, _from) => {
  await flushPendingSave()
  return true
})

watch([localTitle, localJSON, localHTML], () => {
  // 首次触发一定是 hydration(onMounted 灌 local refs)。此刻用户没编辑,
  // 消费掉不排 auto-save —— 否则凭空写「没改过」的 PATCH(case 2)。
  if (justHydrated) {
    justHydrated = false
    return
  }
  if (localId.value) {
    isDirty.value = true
    scheduleAutoSave()
  }
})

onBeforeUnmount(() => {
  if (saveTimer) window.clearTimeout(saveTimer)
  if (savedHideTimer) window.clearTimeout(savedHideTimer)
  if (idleSnapshotTimer) window.clearTimeout(idleSnapshotTimer)
  // Stage 7: best-effort flush for navigations that bypass the router guard
  // (e.g. tab close, hard reload). For SPA navigation the `onBeforeRouteLeave`
  // guard above awaits `persistNow()` first; this is a defensive backstop.
  if (isDirty.value && !isFlushingOnLeave) {
    void flushPendingSave()
  }
  // Stage 6: clear active page id so a stray Suggestion that fires after
  // route unmount (e.g. async callback still pending) sees an empty id and
  // bails out instead of polluting the next page's Mention candidates.
  setActivePageId(null)
})
</script>

<template>
  <div class="edit-shell">
    <div class="subheader">
      <div class="breadcrumb">
        <a href="#/" class="crumb-item crumb-link">我的知识库</a>
        <template v-for="(c, i) in visibleBreadcrumb.head" :key="'h-' + i">
          <span class="sep">/</span>
          <a
            v-if="i < visibleBreadcrumb.head.length - 1 || visibleBreadcrumb.ellipsis || visibleBreadcrumb.tail.length > 0"
            class="crumb-item crumb-link"
            :href="`#/p/${c.id}`"
          >
            {{ c.title }}
          </a>
          <span v-else class="crumb-item current">{{ c.title }}</span>
        </template>
        <template v-if="visibleBreadcrumb.ellipsis">
          <span class="sep">/</span>
          <span class="crumb-item ellipsis" title="中间层级省略">…</span>
          <template v-for="(c, i) in visibleBreadcrumb.tail" :key="'t-' + i">
            <span class="sep">/</span>
            <a
              v-if="i < visibleBreadcrumb.tail.length - 1"
              class="crumb-item crumb-link"
              :href="`#/p/${c.id}`"
            >
              {{ c.title }}
            </a>
            <!-- tail 最后一段 = 当前页(可能标题已存在 / 或未命名 CTA) -->
            <button
              v-else-if="isTitleEmpty"
              type="button"
              class="crumb-item current rename-cta"
              @click="focusTitle"
            >未命名 · 点此重命名</button>
            <span v-else class="crumb-item current">{{ c.title }}</span>
          </template>
        </template>
        <!-- 无 ellipsis 折叠时,head 最后一段 = 当前页 -->
        <template v-else>
          <span v-if="visibleBreadcrumb.head.length > 0">
            <span class="sep">/</span>
            <button
              v-if="isTitleEmpty"
              type="button"
              class="crumb-item current rename-cta"
              @click="focusTitle"
            >未命名 · 点此重命名</button>
            <span v-else class="crumb-item current">{{ visibleBreadcrumb.head[visibleBreadcrumb.head.length - 1]!.title }}</span>
          </span>
        </template>
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
      </div>
    </div>

    <!-- 专题 12:TOC 折叠手柄 —— 只在 tocCollapsed 时显示。
       放 EditView 内部(而非 App.vue 顶层)是为了路由切回 ReadView 等
       不受影响的视图时,手柄自然随组件卸载消失。 -->
    <button
      v-if="uiStore.tocCollapsed"
      type="button"
      class="toc-expand-handle"
      title="展开目录"
      aria-label="展开目录"
      @click="uiStore.setTocCollapsed(false)"
    >
      <span class="material-symbols-outlined">keyboard_double_arrow_left</span>
    </button>

    <div class="layout" :class="{ 'toc-collapsed': uiStore.tocCollapsed }">
      <Sidebar />

      <div class="content">
        <div class="content-inner edit-page">
          <EditorToolbar :editor="editorRef" @close="closeEditor" />

          <input
            ref="titleInputRef"
            class="edit-title-input"
            type="text"
            :value="localTitle"
            @input="onTitleInput"
            :placeholder="DEFAULT_TITLE"
          />

          <div class="edit-byline">
            <UserAvatar :size="24" :label="page?.authorName ?? page?.authorId ?? '我'" :avatar-kind="page?.authorAvatarKind ?? null" :avatar-ref="page?.authorAvatarRef ?? null" :user-id="page?.authorId ?? null" />
            <span><strong>{{ page?.authorName ?? '我' }}</strong> · 创建于 {{ bylineCreatedAt }}</span>
<span class="byline-hint">·</span>
            <span class="byline-hint">输入 <code>/</code> 唤起斜杠菜单</span>
          </div>

          <UploadStatus />

          <RichEditor
            :key="editorKey"
            :model-value="localJSON"
            @update:model-value="onEditorJSON"
            @update:html="onEditorHTML"
            @word-count="onEditorWordCount"
            @ready="onEditorReady"
            @content-mount="captureEditorEl"
          />

          <!-- 附件汇总:与 ReadView 同款,放在 Labels 之上。
               EditView 顶部已有 UploadStatus 处理上传进度,这里只展示
               当前页所有附件的最终落地列表。 -->
          <AttachmentsSection v-if="page" :page-id="page.id" />

          <LabelPills v-if="page" :page="page" />

          <div class="edit-footer">
            <span class="material-symbols-outlined" style="font-size:14px;color:var(--text-3)">info</span>
            <span>所有编辑自动保存到后端</span>
            <span class="footer-sep">·</span>
            <span class="word-count">{{ wordCount.words }} 字</span>
          </div>
        </div>
      </div>

      <TocPanel
        :content-ref="editorContentEl"
        :page-key="localId ?? undefined"
        :labels="page?.labels ?? []"
      />

      <!-- 图片附件全屏预览(ReadView 同款),点击 .ProseMirror 内的
           figure.attachment-image > img 触发,见 onAttachmentImgClickInEditor。 -->
      <AttachmentLightbox
        :open="lightbox.open"
        :src="lightbox.src"
        :alt="lightbox.alt"
        :filename="lightbox.filename"
        @close="closeLightbox"
      />
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

/* 面包屑可点 crumb(祖辈 / 同级):跟 ReadView 同一套。 */
.crumb-item.crumb-link {
  cursor: pointer;
  color: var(--text-2);
  text-decoration: none;
  border-radius: 3px;
  padding: 1px 4px;
  transition: background var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.crumb-item.crumb-link:hover {
  background: var(--bg-subtle);
  color: var(--accent);
  text-decoration: none;
}
.crumb-item.crumb-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
  color: var(--accent);
}
.crumb-item.ellipsis {
  color: var(--text-3);
  cursor: default;
  font-weight: 600;
  padding: 0 4px;
}

/* 「未命名 · 点此重命名」CTA:跟普通 current 区分,加 dashed underline +
   浅色 hover,告诉用户「这一段还没起名,点我」。 */
.crumb-item.current.rename-cta {
  background: transparent;
  border: 0;
  border-bottom: 1px dashed var(--accent);
  color: var(--accent);
  font-weight: 500;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 3px;
  font: inherit;
}
.crumb-item.current.rename-cta:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.crumb-item.current.rename-cta:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

/* 把关注按钮推到 byline 行最右 —— 视觉上跟作者信息组(左)+ 操作(右)两端对齐 */

.edit-byline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
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
