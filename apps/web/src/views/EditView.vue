<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError, invalidatePath } from '@/lib/api'
import TocPanel from '@/components/layout/TocPanel.vue'
import RichEditor from '@/components/editor/RichEditor.vue'
import EditorToolbar from '@/components/editor/EditorToolbar.vue'
import UploadStatus from '@/components/editor/UploadStatus.vue'
import LabelPills from '@/components/page/LabelPills.vue'
import AttachmentLightbox from '@/components/page/AttachmentLightbox.vue'
import AttachmentsSection from '@/components/page/AttachmentsSection.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import PageRestrictionsDialog from '@/components/page/PageRestrictionsDialog.vue'
import ShareDialog from '@/components/page/ShareDialog.vue'
import { useUiStore } from '@/stores/ui'
import { useConfirm } from '@/composables/useConfirm'
import { useActivePageId } from '@/composables/useActivePageId'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { usePageAutoSave } from '@/composables/usePageAutoSave'
import { usePageBreadcrumbSegments } from '@/composables/useBreadcrumb'
import { useSpaceBreadcrumbSegment } from '@/composables/useSpaceBreadcrumbSegment'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import PageActions from '@/components/ui/PageActions.vue'
import { useAttachmentLightbox } from '@/composables/useAttachmentLightbox'
import { useCollabProvider } from '@/editor/collab/useCollabProvider'
import type { PageNode } from '@power-wiki/shared'
import { emptyDoc, EMPTY_HTML, DEFAULT_TITLE, normalizeTitle } from '@/lib/constants'
import { newId } from '@/lib/id'
import { formatRelativeTime } from '@/lib/relativeTime'
import { canManagePageWrite } from '@/lib/permissions'
import { usePageLock } from '@/composables/usePageLock'
import LockBanner from '@/components/page/LockBanner.vue'
import PageDeletingBanner from '@/components/page/PageDeletingBanner.vue'
import PageRestoringBanner from '@/components/page/PageRestoringBanner.vue'
// Tiptap 的 vue-3 和 core Editor 类型不完全兼容,这里使用 any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{ id?: string; parentId?: string | null }>()
const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const authStore = useAuthStore()
const router = useRouter()
const uiStore = useUiStore()
const { confirm } = useConfirm()
const { set: setActivePageId } = useActivePageId()

/**
 * AppShell provide 的右栏 DOM 引用。EditView 同样用 :to="rightRailEl"
 * 把 HTMLElement 直接喂给 Teleport,绕过 querySelector 异步挂载时序赛跑。
 * 详见 AppShell.vue 的 rightRailEl 注释 + ReadView 的同名字段。
 */
const rightRailEl = inject<Ref<HTMLElement | null>>('appRightRail', ref(null))

/**
 * 当前用户能否编辑 `props.id` 对应的页面。对齐 ReadView.canEdit 与后端
 * canEditPage 的语义:admin / 空间角色不是 viewer / 作者本人 都能编辑,
 * 普通 viewer 只能读。
 *
 * - 新建页(page 还没解析出来)→ 返回 true 不挡,后续由 createPage 自己
 *   处理(创建权限跟空间角色绑定,不挂在 pageId 上)。
 * - `page.viewerRole` 是后端注入的 effective role,跟前端 `useAuthStore.user`
 *   一起算;author bypass 用 user.id 比对 page.authorId。
 * - 个人空间写矩阵(P0-3):global admin 即使 own 自己的 personal space 也按
 *   supervisor 处理 —— 不能编辑。先用 canWritePersonalSpace 把 personal
 *   拒掉,再叠加原来的 isAdmin / viewerRole / author 短路。
 */
function canEditPageNode(p: PageNode): boolean {
  return canManagePageWrite(authStore.user, p)
}

const localId = ref<string | null>(props.id ?? null)
const localTitle = ref<string>('')
const localJSON = ref<Record<string, unknown>>(emptyDoc())
const localHTML = ref<string>(EMPTY_HTML)

/**
 * `page` / `parentPage` 必须在 `collabMode` 之前定义 —— collabMode 通过
 * page.value?.spaceId 派生(usePageLock 的 watch 在 setup 同步阶段读
 * collabMode.value,触发 collabMode 的 getter 求值,如果 page 还没声明
 * 会撞「Cannot access 'page' before initialization」TDZ 错误)。
 * EditView 的 localId 早于 onMounted 解析出来的 server page,这里 page.value
 * 初次为 undefined,collabMode 退化成 'off' —— usePageLock 此时不拿锁,
 * 是预期的。后续 page.value 解析后 watch 自动触发,mode 翻 'shared' 才
 * acquire。
 */
const page = computed(() => (localId.value ? pagesStore.getPage(localId.value) : undefined))
const parentPage = computed(() => {
  const pid = page.value?.parentId
  if (!pid) return null
  return pagesStore.getPage(pid) ?? null
})
const isExisting = computed(() => !!localId.value)

/**
 * 协同模式(2026-08-05 Phase 2 + Phase 3 落地)。
 *
 * 派生规则:
 *   - 团队空间(kind='shared' 或缺省)→ collabMode='shared',挂 Hocuspocus
 *     provider 走 server relay,跟 backend hooks.onStoreDocument mirror
 *     闭环(切空间时 collabMode 自动跟着 page.value.spaceId 走)。
 *   - 个人空间(kind='personal')→ Phase 3 起 collabMode='personal',挂
 *     BroadcastChannelProvider,只在本浏览器同 origin 多 Tab 间同步,
 *     不上 server。Phase 2 时期走 'off'(单写者),已替换为 'personal'。
 *   - pageId 还没解析出来(新建页过渡态)→ collabMode='off',挂单写者
 *     provider。等 page.value 解析后,spaceKind watcher 会把 mode 翻成
 *     shared / personal 并 bump editorKey 重挂。
 *
 * 注意:不能在「page.value 还没解析出来」时硬塞 collabMode='shared' 让
 * provider 提前连 —— 那会让 collab hook 在 onLoadDocument 拿到空 ydoc,
 * 而 server mirror 的内容会丢失。`localId` 有值后再激活 provider 是
 * useCollabProvider 的 watch pageId 实现的,这里只决定 mode 字符串。
 */
const collabMode = computed<'off' | 'shared' | 'personal'>(() => {
  const sid = page.value?.spaceId
  if (!sid) return 'off'
  const space = spacesStore.spaces.value.find((s: { id: string; kind?: 'personal' | 'shared' }) => s.id === sid)
  return space?.kind === 'personal' ? 'personal' : 'shared'
})

/**
 * collabProvider —— 根据 collabMode 路由到 Hocuspocus(shared) 或
 * BroadcastChannel(personal)。Phase 3 之前 useCollabProvider 只支持
 * shared,现在内部 connect() 按 mode 分发,caller 仍然只看到一个统一
 * interface。
 *
 * authStore.user 是 Pinia reactive proxy,跟 Vue ref 等价。Vue template
 * 里可以直接 `authStore.user` 拿到 `.value`,但传给 TypeScript 严格
 * 类型时偶尔需要 cast,这里走 computed 包一层保持响应性 + 类型对得上。
 */
const collabUserRef = computed(() => authStore.user)
const collab = useCollabProvider({
  pageId: localId,
  user: collabUserRef,
  // collabMode 是 computed,每次 pageId watch 触发 connect 时取一次最新值。
  // shared → personal 同 user 跨空间切页时 mode 翻转正确生效。
  mode: () => collabMode.value === 'personal' ? 'personal' : 'shared',
  // WS push-based 锁感知(2026-08-06):进 EditView 后 awareness.user.mode
  // 翻成 'edit',让其他 ReadView 观众的 PresenceAvatars 区分「正在看」
  // vs「正在编辑」。provider 在 onAuthenticated / mode 变化时自动写本地 state。
  awarenessMode: () => 'edit',
})

/**
 * Phase 4 编辑锁 UI —— 共享空间 acquire / 释放 + 倒计时 banner。
 * personal / off 模式 usePageLock 内部直接 return,不拿锁。
 *
 * Phase 5:lock acquire/release 是 snapshot 的「session 边界」。把
 * snapshotPage 接到 onAcquire / onRelease 上,语义是:
 *   - 进入 EditView 拿锁 = 编辑会话开始 → 打一个 checkpoint
 *     (空内容的 page 也打,作为「user X 进来看过」标记)
 *   - 释放锁(切页 / unmount / route leave)= 会话结束 → 再打一个
 *     checkpoint,捕获最终状态
 *   - 中间所有 PATCH 走 auto-save 静默路径,不进 page_versions
 *
 * onAcquire / onRelease 失败由 usePageLock 内部静默 —— snapshot 是
 * advisory,失败不应该阻断 lock 操作。
 */
const lockCtl = usePageLock({
  pageId: localId,
  currentUser: collabUserRef,
  isAdmin: computed(() => authStore.isAdmin),
  collabMode,
  awarenessStates: collab.awarenessStates,
  clientId: collab.clientId,
  // WS push-based lock 感知(2026-08-06):有连接时 polling 5s 兜底,
  // 断开时 1s。unref 后只读 boolean,不参与 reactivity 反应链。
  isCollabConnected: computed(() => collab.isConnected.value),
  onAcquire: (pageId: string) =>
    pagesStore.snapshotPage(pageId, 'lock-acquire').catch((err) => {
      console.warn('[EditView] lock-acquire snapshot failed', err)
    }),
  onRelease: (pageId: string) =>
    pagesStore.snapshotPage(pageId, 'lock-release').catch((err) => {
      console.warn('[EditView] lock-release snapshot failed', err)
    }),
  // M13+: 把 useCollabProvider 暴露的 stateless 订阅口透传给 usePageLock,
  // 让 usePageLock 内部识别 page_locked_during_delete / page_actually_deleted
  // 并驱动 pageDeleting ref + 兜底 redirect。B 调 DELETE 被锁闸门挡回后
  // server 推一条,A 这边 banner 立刻升起。
  onStateless: collab.onStateless,
})

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const editorRef = ref<any>(null)

/** Version 边界:停笔 N 秒就当一个「编辑会话」结束,打一个 checkpoint
 *  (POST /:id/snapshots)。跟 Notion / Google Docs 的习惯一致 —— PATCH
 *  永远静默,version 只在 idle / route leave 这种机器化边界打。
 *  用户偏好:不提供手动「保存为版本」按钮。 */
const IDLE_SNAPSHOT_MS = 30_000
const idleSnapshotSeconds = computed(() => IDLE_SNAPSHOT_MS / 1000)

/**
 * P0/5.1 — 防抖 + 5 态状态机 + 30s idle snapshot 全部下沉到
 * `usePageAutoSave`。本视图只负责「内容变了 → scheduleSave()」和
 * 「要离开了 → flushSave()」两件事,不再自持 saveTimer /
 * lastSaved* 指纹 / justHydrated / hasUnsnapshottedEdits。
 *
 * 注册位置很关键:必须在下方 `watch([localTitle, localJSON, localHTML])`
 * **之前**调用 —— composable 内部的 pageId watch 要先于内容 watch 触发,
 * 这样切页时「先重置状态、再消费首次触发写 baseline」的顺序才成立。
 *
 * `getPatch` 直接从 editor 实例读 getJSON()/getHTML(),而不是读 local
 * refs —— RichEditor 的 emit 走 Vue 微任务,「编辑后立即 flush」时
 * local refs 可能还差最后一次 emit。editor 实例永远是最新的。
 *
 * Phase 2(2026-08-05):协同模式(shared)下 **body 不进 PATCH**。
 * `contentJSON` / `contentHTML` 由 server 端 Hocuspocus onStoreDocument
 * 镜像写到 pages 表,Yjs 是事实来源;客户端 PATCH 这两字段会跟 server
 * mirror 形成竞态 —— 客户端落旧内容、server 又用新内容覆盖,浪费 IO
 * 且容易触发「我保存好了」之后又被回滚的诡异 bug。composable 不知道
 * 协同状态,本视图在 getPatch 里直接 drop 掉。
 */
const autoSave = usePageAutoSave({
  pageId: localId,
  getPatch: () => {
    const title = normalizeTitle(localTitle.value)
    if (collabMode.value === 'shared') {
      return { title }
    }
    const ed = editorRef.value
    return {
      title,
      contentJSON: (ed ? ed.getJSON() : localJSON.value) as Record<string, unknown>,
      contentHTML: ed ? ed.getHTML() : localHTML.value,
    }
  },
  save: (patch) => pagesStore.updatePage(localId.value!, patch),
  snapshot: (changeNote) => pagesStore.snapshotPage(localId.value!, changeNote),
  idleSnapshotMs: IDLE_SNAPSHOT_MS,
})
const { saveState, isDirty } = autoSave
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
// 状态与打开逻辑共用 useAttachmentLightbox;绑定策略与 ReadView 不同(见上)。
const { lightbox, closeLightbox, openFromImg } = useAttachmentLightbox()

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
  openFromImg(img)
}
onMounted(() =>
  document.addEventListener('click', onAttachmentImgClickInEditor, true),
)
onBeforeUnmount(() =>
  document.removeEventListener('click', onAttachmentImgClickInEditor, true),
)

/**
 * 模块 4 P1 修复:跨空间深链进入编辑视图时主动 setActiveSpace,跟
 * ReadView / HistoryView 同套 —— 让 Sidebar / SpaceSwitcher / breadcrumb
 * 在三个视图之间保持一致。EditView 的特殊点:`page` 解析略晚于路由进入
 * (onMounted await api.pages.get),`immediate: true` 首次触发时
 * `page.value` 可能还是 undefined,被 if 拦掉;等 onMounted 把 fetched 写
 * 进 store 后第二次触发,setActiveSpace 生效。
 *
 * 新建分支(`props.id` 为空,`localId` 是 client nanoid)不会进 watch
 * 触发条件,正确:没有 pageId → 没有归属空间 → 不应该切 activeSpace。
 */
watch(
  () => page.value?.spaceId,
  (sid) => {
    if (sid && spacesStore.activeSpaceId.value !== sid) {
      spacesStore.setActiveSpace(sid)
    }
  },
  { immediate: true },
)

/* Phase B 页面级限制 dialog —— EditView 始终有权能编辑,就一定有 canManage
 * 三选一(作者 / space-admin / global admin),所以这里不用启发式 gate,
 * 按钮直接按 isExisting 显示(新建页没 server id 之前 dialog 也存不下限制,
 * 仍要把按钮藏掉,避免点了得到空状态)。save 成功回调 patch 到 pagesStore,
 * 跟 ReadView 同源。 */
const restrictionsOpen = ref(false)
/** Phase D: 公开分享 dialog 开关。EditView 里是 owner / admin 才有意义
 *  (新建未存的页没有 pageId,后端路由会 404)。isExisting 已经把这种情况
 *  挡掉。 */
const shareOpen = ref(false)
function onRestrictionsSaved(flags: {
  hasViewRestriction: boolean
  hasEditRestriction: boolean
}) {
  if (!localId.value) return
  pagesStore.patchPage(localId.value, {
    hasViewRestriction: flags.hasViewRestriction,
    hasEditRestriction: flags.hasEditRestriction,
  })
}

/** 面包屑链路(根 → 当前页)+ 折叠渲染。读 pageId(localId 或 parentId,
 *  新建页时 parentId 给定但 page 自身还没在 store 里)。
 *
 * EditView 的特殊点:页面本身可能在 store 里(已创建)或不在(客户端 nanoid
 * 刚生成、还没等服务端回包)。两种情况都期望看到「父 → 当前」的链路 —— 所以
 * composable 的 pageIdGetter 在没有 page 时回退到 parentId,这样新建页
 * 也能看到「<active space> / 父 / 未命名」的三段式。[P0-1] 第一段从
 * 写死「我的知识库」改成 active space 名 + kind icon,跟 ReadView/HistoryView
 * 及 PersonalHomeView/WatchedView/ActivityView/NotFoundView/ManagerLayout
 * 统一。 */
const pageBreadcrumb = usePageBreadcrumbSegments(
  () => page.value?.id ?? props.parentId ?? null,
  {
    currentLabel: () => {
      // 末段 label:页面已存用标题,未命名态 / 还没存过用「未命名」占位
      // (实际渲染走 #current 插槽的 rename-cta 按钮,这里只是给 composable
      // 一个非空 label,确保空 chain 也能返回单段)
      if (!page.value) return '未命名'
      return localTitle.value.trim() === '' ? '未命名' : localTitle.value
    },
  },
)
// [P0-1] 链头用 active space 名字,详见 useSpaceBreadcrumbSegment。
const spaceSegment = useSpaceBreadcrumbSegment()
const breadcrumbSegments = computed(() => {
  const sp = spaceSegment.value
  return sp ? [sp, ...pageBreadcrumb.value] : [...pageBreadcrumb.value]
})

/** 「未命名 · 点此重命名」CTA:新建页 / 标题被清空时,breadcrumb 最后一段
 *  渲染为可点击按钮,点击聚焦 title input 让用户立即起名。 */
const isTitleEmpty = computed(() => localTitle.value.trim() === '')

function focusTitle(): void {
  titleInputRef.value?.focus()
  titleInputRef.value?.select()
}

/** Tiptap 编辑器 :key —— 切换编辑对象 / 强制刷新时 +1 让 RichEditor
 *  重挂载,确保 ProseMirror 内部状态跟 model-value 一致。Tiptap 的
 *  internal content 不会主动重读 model-value(只 watch 初次),必须
 *  unmount + mount 才能换骨架。
 *
 * 协同边界(2026-08-05 Phase 2):`collabMode` 或 `ydoc` 引用变化都强制
 * 重挂 —— @tiptap/vue-3 的 useEditor 在 setup 一次性创建 Editor,
 * extensions / ydoc 引用变化不会响应;不重挂会让旧 ydoc 持续 transact、
 * 新 ydoc 收不到内容。
 *
 * Phase 4 修(2026-08-06):`awareness` 也加入依赖 —— collabMode 翻 'shared'
 * 后,HocuspocusProvider 异步 connect,中间窗口 buildExtensions 会以
 * 「provider 还没就绪」fallback 到单写者模式。等 onSynced 触发 awareness
 * 引用变化时 bump key 重挂,切到完整 collab 配置 + Collaboration +
 * CursorExtension,避免在 RichEditor setup 阶段抛错连带 LockBanner
 * 等上层组件被 Vue 中断 render。 */
const editorKey = ref(0)
watch(
  () => [collabMode.value, collab.ydoc.value, collab.awareness.value] as const,
  () => {
    editorKey.value++
  },
)

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

/**
 * byline 「最后编辑者」展示名 —— 跟 ReadView.editorDisplay 同一套优先级
 * (updatedByName → authorName → '我' → '未知作者'),保证两个 view 切换时
 * byline 显示的「人」一致,消除模块 2 P0 (2.3)「EditView 说 author / ReadView
 * 说最后编辑者」的语义冲突。
 */
const editorDisplay = computed(() => {
  const p = page.value
  if (!p) return ''
  if (p.updatedByName) return p.updatedByName
  if (p.authorName) return p.authorName
  if (p.authorId === 'me') return '我'
  return '未知作者'
})

const editorAvatarColor = computed(
  () => page.value?.updatedByColor ?? page.value?.authorColor ?? 'var(--text-3)',
)

/**
 * 「由 Y 创建」副行展示名 —— author 优先,'me' → '我',已删 → '未知作者'。
 * 仅在 showAuthorSuffix 为 true 时渲染(authorId !== updatedById)。
 */
const authorDisplay = computed(() => {
  const p = page.value
  if (!p) return ''
  if (p.authorName) return p.authorName
  if (p.authorId === 'me') return '我'
  return '未知作者'
})

/**
 * 副行渲染条件:updatedBy 跟 authorId 不同(被他人编辑过 / 自己编辑过他人页)。
 * 按 user.id 比较规避重名 / 改名;'me' 跟任何真实 id 都不等,所以老 seed 页
 * (updatedBy 回填成 'me' 后又被人改 → updatedBy 变成真实 id)也命中。
 */
const showAuthorSuffix = computed(() => {
  const p = page.value
  if (!p) return false
  if (p.updatedBy == null) return true
  return p.updatedBy !== p.authorId
})

/**
 * byline 「最后编辑于 X」—— 走 formatRelativeTime 跟 ReadView 一致,
 * 远期 (> 30d) 自动降级为 zh-CN locale 日期。
 */
const bylineUpdatedAt = computed(() => {
  const ts = page.value?.updatedAt
  return typeof ts === 'number' ? formatRelativeTime(ts) : ''
})

function hydrateExistingPage(p: PageNode): void {
  // dedup baseline 不在这里写:composable 的 pageId watch 已经把内部状态
  // 重置成 justHydrated=true,下面这几行赋值触发的内容 watch 会被它消费掉,
  // 顺手把 hydration 后的 getPatch() 当 baseline 落下 —— 比在这里手写
  // lastSaved* 更准(那时读的是 stored HTML,跟 editor 归一化后的 getHTML()
  // 有细微差异,dedup 会落空,凭空写一份「没改过」的 PATCH)。
  localId.value = p.id
  localTitle.value = p.title
  localJSON.value = (p.contentJSON as Record<string, unknown>) ?? emptyDoc()
  localHTML.value = p.contentHTML ?? EMPTY_HTML
  setActivePageId(p.id)
  requestAnimationFrame(() => titleInputRef.value?.focus())
}

onMounted(async () => {
  if (props.id) {
    try {
      const path = `/pages/${encodeURIComponent(props.id)}`
      invalidatePath('GET', path)
      const fetched = await api.pages.get(props.id)
      const idx = pagesStore.pages.findIndex((row) => row.id === fetched.id)
      if (idx >= 0) pagesStore.pages[idx] = fetched
      else pagesStore.pages.push(fetched)

      if (!canEditPageNode(fetched)) {
        await router.replace(`/p/${fetched.id}?readonly=1`)
        return
      }

      hydrateExistingPage(fetched)
      return
    } catch (e) {
      // view_restricted 也是 404,但页面**是存在的** —— 不能落到下面
      // 「404 ⇒ 当成新页面创建」的分支,否则会凭空多出一篇同 id 的新页。
      // 交给 ReadView 呈现「此页面存在访问限制」。
      if (e instanceof ApiError && e.code === 'view_restricted') {
        await router.replace(`/p/${props.id}`)
        return
      }
      if (!(e instanceof ApiError && e.status === 404)) {
        await router.replace(`/p/${props.id}`)
        return
      }
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

// 三个 on*Input / on*Editor 回调只更新 local refs —— dirty 判定 + 'pending'
// 态 + 防抖排程统一由下方 `watch([localTitle, localJSON, localHTML])` →
// `autoSave.scheduleSave()` 处理。以前这里各自手写 isContentDirty() +
// saveState='pending',跟 watcher 里的排程逻辑重复且容易漂移。
function onTitleInput(e: Event) {
  localTitle.value = (e.target as HTMLInputElement).value
}

function onEditorJSON(v: Record<string, unknown>) {
  localJSON.value = v
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

async function closeEditor() {
  // route-leave hook 会负责 flush;这里只导航。
  if (localId.value) {
    router.push(`/p/${localId.value}`)
  } else {
    router.push('/')
  }
}

/**
 * 离开编辑器时的二次确认 —— 捕获 auto-save 兜不住的边缘情况:
 *   - 500ms 防抖窗口(刚敲完就点关闭,未 flush)
 *   - 30s idle snapshot 边界(还在编辑中,未触发 checkpoint)
 *   - 网络抖动(saveState='error',server 没收到)
 *
 * 文案分两态:
 *   - error 态:强调「可能未落盘」+ danger 样式,按钮用「不保存离开」
 *   - 其他态:常规提示,按钮用「保存并离开」
 *
 * 共用入口覆盖:顶栏「关闭」按钮 / sidebar 跨页跳转 / 浏览器 back,
 * 一律走 onBeforeRouteLeave 拦截,closeEditor 不重复弹。
 */
async function confirmDirtyLeave(): Promise<boolean> {
  if (!isDirty.value) return true

  const seconds = idleSnapshotSeconds.value
  const isError = saveState.value === 'error'

  return confirm({
    title: '离开编辑器?',
    message: isError
      ? `上次自动保存失败。最近 ${seconds} 秒内的修改可能未落盘,确认离开?`
      : `最近 ${seconds} 秒内的修改已自动保存,确认离开?`,
    confirmText: isError ? '不保存离开' : '保存并离开',
    cancelText: '取消',
    danger: isError,
  })
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
        // 只灌 local refs。dedup baseline / saveState / idle snapshot 定时器
        // 全部由 composable 内部的 pageId watch 重置 —— 它注册得更早,同一
        // 个 flush 里先于内容 watch 跑,顺序天然对。
        localId.value = p.id
        localTitle.value = p.title
        localJSON.value = (p.contentJSON as Record<string, unknown>) ?? emptyDoc()
        localHTML.value = p.contentHTML ?? EMPTY_HTML
      }
    }
  }
)

onBeforeRouteLeave(async (_to, _from) => {
  if (isDirty.value) {
    const ok = await confirmDirtyLeave()
    if (!ok) return false
  }
  // flushSave 内部同时取消防抖 + idle 定时器、同步 PATCH、补 boundary
  // snapshot(若仍有未打 checkpoint 的改动),不需要再单独调 flushSnapshot。
  await autoSave.flushSave()
  return true
})

watch([localTitle, localJSON, localHTML], () => {
  // composable 内部消费首次(hydration)触发写 baseline,后续真实编辑才
  // 真正 arm 定时器 —— 这里无条件调即可,不必再自持 justHydrated。
  autoSave.scheduleSave()
})

onBeforeUnmount(() => {
  // 兜底 flush:绕过 router guard 的导航(tab 关闭 / 硬刷新)走这条。
  // SPA 导航已经在上面的 onBeforeRouteLeave 里 await 过了,composable 的
  // isFlushingOnLeave 守卫保证不会重复 PATCH。
  if (isDirty.value) void autoSave.flushSave()
  // 定时器由 composable 的 onScopeDispose 自动清,这里不用手动 dispose。
  // Stage 6: clear active page id so a stray Suggestion that fires after
  // route unmount (e.g. async callback still pending) sees an empty id and
  // bails out instead of polluting the next page's Mention candidates.
  setActivePageId(null)
})
</script>

<template>
  <div class="edit-shell">
    <Breadcrumb :segments="breadcrumbSegments">
      <template #current>
        <!-- 「未命名 · 点此重命名」CTA:新建页 / 标题被清空时,breadcrumb
             末段渲染为可点击按钮,点击聚焦 title input 让用户立即起名。
             走 #current 插槽,组件本身保持纯 —— EditView 独占这个 CTA。 -->
        <button
          v-if="isTitleEmpty"
          type="button"
          class="crumb-item current rename-cta"
          @click="focusTitle"
        >未命名 · 点此重命名</button>
        <span v-else class="crumb-item current">{{ localTitle }}</span>
      </template>
    </Breadcrumb>
    <PageActions>
        <span class="edit-mode-badge">
          <span class="material-symbols-outlined icon-sm">edit</span>
          编辑中
        </span>
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
        <!-- Phase B 限制 dialog 入口 —— EditView 总有 edit 权限,按钮无条
             件显示(isExisting = 有 server id 才有意义,新建未存盘阶段不显示
             避免点了拿到空限制)。跟 ReadView 用同一个 PageRestrictionsDialog
             实例,Modal 自身 Teleport body 不冲突。 -->
        <button
          v-if="isExisting"
          class="btn"
          type="button"
          title="配置查看 / 编辑限制"
          @click="restrictionsOpen = true"
        >
          <span class="material-symbols-outlined icon-md">lock</span>
          限制
        </button>
        <button
          v-if="isExisting"
          class="btn"
          type="button"
          title="创建公开分享链接"
          @click="shareOpen = true"
        >
          <span class="material-symbols-outlined icon-md">share</span>
          分享
        </button>
        <button class="btn ghost" type="button" :title="`关闭编辑器 · 自动保存已兜底最近 ${idleSnapshotSeconds} 秒内的修改`" @click="closeEditor">
          <span class="material-symbols-outlined icon-md">cloud_done</span>
          关闭
        </button>
    </PageActions>

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

          <!-- M13+ 协同删除 race 收口横幅 —— 比 LockBanner 更紧迫(删除是不可逆
               动作),放在 LockBanner 之上确保它最早被看到。actorId 是 deleter
               (B) 的 userId,name 优先从 awarenessStates 解析,B 不在 awareness
               时 fallback 到 actorId 直接展示。
               「我知道了,让出」调 closeEditor → 路由跳走 → usePageLock 释锁
               → B 重试 DELETE 时锁闸门放行 → 落地。 -->
          <PageDeletingBanner
            v-if="lockCtl.pageDeleting.value"
            :actor-id="lockCtl.pageDeleting.value.actorId"
            :actor-name="lockCtl.pageDeletingActorName.value"
            :actor-color="lockCtl.pageDeletingActorColor.value"
            @leave="closeEditor"
          />

          <!-- M13+ restore 收口横幅 —— 跟 PageDeletingBanner 同源(server 端
               assertNoActiveLockForWrite 共用 helper,只是 action='restore'),
               用 warning 黄(中等紧迫,比 delete 红低一档)。versionNumber 由
               server 推 stateless 时附带,banner 显示「正在尝试回滚到 v{N}」,
               让 A 明确知道对方要回到哪一版。 -->
          <PageRestoringBanner
            v-if="lockCtl.pageRestoring.value"
            :actor-id="lockCtl.pageRestoring.value.actorId"
            :actor-name="lockCtl.pageRestoringActorName.value"
            :actor-color="lockCtl.pageRestoringActorColor.value"
            :version-number="lockCtl.pageRestoring.value.versionNumber ?? null"
            @leave="closeEditor"
          />

          <!-- Phase 4 编辑锁横幅 —— 仅 shared mode 有人锁他人才渲染。
               个人空间 / 新页过渡态 / 自己持锁 都不渲染。 -->
          <LockBanner
            :lock="lockCtl.lock.value"
            :is-admin="authStore.isAdmin"
            :current-user-id="authStore.user?.id ?? ''"
            :holder-name="lockCtl.holderName.value"
            :holder-color="lockCtl.holderColor.value"
            @takeover="lockCtl.setLock"
            @released="lockCtl.clear"
          />

          <div v-if="page" class="edit-byline">
            <UserAvatar :size="24" :color="editorAvatarColor" :label="editorDisplay" :avatar-kind="page.updatedByAvatarKind ?? page.authorAvatarKind ?? null" :avatar-ref="page.updatedByAvatarRef ?? page.authorAvatarRef ?? null" :user-id="page.updatedBy ?? page.authorId ?? null" />
            <span><strong>{{ editorDisplay }}</strong> · 最后编辑于 {{ bylineUpdatedAt }}</span>
          </div>
          <div v-if="showAuthorSuffix" class="edit-byline-sub">
            由 {{ authorDisplay }} 创建 · {{ bylineCreatedAt }}
          </div>

          <UploadStatus />

          <RichEditor
            :key="editorKey"
            :model-value="localJSON"
            :collab-mode="collabMode"
            :ydoc="collab.ydoc.value"
            :collab-provider="collab.awareness.value ? { awareness: collab.awareness.value } : null"
            :collab-user="authStore.user"
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

      <Teleport v-if="rightRailEl" :to="rightRailEl">
        <TocPanel
          :content-ref="editorContentEl"
          :page-key="localId ?? undefined"
          :labels="page?.labels ?? []"
        />
      </Teleport>

      <!-- 图片附件全屏预览(ReadView 同款),点击 .ProseMirror 内的
           figure.attachment-image > img 触发,见 onAttachmentImgClickInEditor。 -->
      <AttachmentLightbox
        :open="lightbox.open"
        :src="lightbox.src"
        :alt="lightbox.alt"
        :filename="lightbox.filename"
        @close="closeLightbox"
      />

      <!-- Phase B 页面级限制 dialog;新建页(isExisting=false)时 localId
           还没拿到,不挂载避免 dialog 拿空 id。saved 事件回写 store 标志,
           跟 ReadView 同一来源。 -->
      <PageRestrictionsDialog
        v-if="isExisting"
        v-model:open="restrictionsOpen"
        :page-id="localId!"
        :page-title="localTitle"
        @saved="onRestrictionsSaved"
      />
      <!-- Phase D 公开分享 dialog:同 PageRestrictionsDialog,只在已
           存在的页上挂(同 isExisting 条件)。 -->
      <ShareDialog
        v-if="isExisting"
        v-model:open="shareOpen"
        :page-id="localId!"
        :page-title="localTitle"
      />

  </div>
</template>

<style scoped>
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

/* 由 Y 创建 副行 —— 仅当 author ≠ 最后编辑者时显示,避免冗余。
   top 0 让 byline 的 margin-bottom 自然撑开间距;bottom 8px 跟 UploadStatus 留呼吸。 */
.edit-byline-sub {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 8px;
  padding-left: 32px;
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
