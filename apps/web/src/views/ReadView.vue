<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useRoute, useRouter } from 'vue-router'
import { useRecentPages } from '@/composables/useRecentPages'
import TocPanel from '@/components/layout/TocPanel.vue'
import ScrollProgress from '@/components/layout/ScrollProgress.vue'
import LabelPills from '@/components/page/LabelPills.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import WhoLikedList from '@/components/page/WhoLikedList.vue'
import PageWatchButton from '@/components/page/PageWatchButton.vue'
import PageRestrictionsDialog from '@/components/page/PageRestrictionsDialog.vue'
import ShareDialog from '@/components/page/ShareDialog.vue'
import CommentsSection from '@/components/comments/CommentsSection.vue'
import PageMoreActionsMenu from '@/components/page/PageMoreActionsMenu.vue'
import AttachmentLightbox from '@/components/page/AttachmentLightbox.vue'
import AttachmentsSection from '@/components/page/AttachmentsSection.vue'
import PageLinkPreview from '@/components/page/PageLinkPreview.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { usePageBreadcrumbSegments } from '@/composables/useBreadcrumb'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import PageActions from '@/components/ui/PageActions.vue'
import { useAttachmentLightbox } from '@/composables/useAttachmentLightbox'
import { api, ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import { sanitizeAndHardenLinks } from '@/lib/sanitize'
import { highlightCodeBlocks } from '@/lib/renderHighlight'
import { addHeadingAnchors } from '@/lib/headingAnchors'
import { htmlToJson } from '@/editor/htmlToJson'
import { charCount } from '@/lib/textMetrics'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { useConfirm } from '@/composables/useConfirm'
import { EMPTY_HTML } from '@/lib/constants'
import { canWritePersonalSpace, spaceRefForPage } from '@/lib/permissions'

const props = defineProps<{ id: string }>()
const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const authStore = useAuthStore()
const uiStore = useUiStore()
const router = useRouter()
const route = useRoute()
const { recordVisit } = useRecentPages()
const { confirm } = useConfirm()

/**
 * AppShell provide 的右栏 DOM 引用 —— 直接给 Teleport 喂 HTMLElement,
 * 避开 querySelector('#app-right-rail') 的异步挂载时序赛跑(异步 chunk
 * 在 layout 同 flush 内 mount 时,字符串选择器会查到 null,导致 Teleport
 * subTree 留 null,后续 patch 撞 "emitsOptions of null")。详见
 * AppShell.vue 的 rightRailEl 注释。
 *
 * 默认值用 ref(null) —— 正常路径下 AppShell 一定先于本组件 mount,provide
 * 已就位;默认值是兜底,防止独立单元测试 / Storybook 等无 provider 场景
 * 直接抛 "inject() ... cannot read 'value'"。
 */
const rightRailEl = inject<Ref<HTMLElement | null>>('appRightRail', ref(null))

/**
 * Viewer 兜底 banner —— EditView 检测到当前用户在 page 上没有 edit 权限时
 * router.replace 到本视图 URL 并挂 `?readonly=1`。ReadView 在挂载 / 路由
 * 切换时消费这个 flag:
 *   - 命中 → 显示"只读模式"通知条(顶部、视觉上比 toast 重、比全局错误
 *     banner 轻,语义清晰)
 *   - 立刻 router.replace 抹掉 query,避免刷新页面再次触发(用户主动从
 *     别处分享 URL 直达不该再弹一次)
 *
 * 注意:这里用的是 ref 而非 computed,因为它有"已 dismiss"语义 —— 用户
 * 点 × 后即便路由 query 没变,也不再显示。
 */
const readonlyNoticeOpen = ref(false)
function dismissReadonlyNotice() {
  readonlyNoticeOpen.value = false
}

watch(
  () => route.query['readonly'] === '1',
  (flag) => {
    if (flag) {
      readonlyNoticeOpen.value = true
      // 抹掉 query,刷新 / 直链再访问不会重复触发
      const { readonly: _drop, ...rest } = route.query
      void _drop
      router.replace({ query: rest }).catch(() => {
        /* 同路由 query 替换偶发 NavigationFailure,静默吞 */
      })
    }
  },
  { immediate: true },
)

/** 切到其他页时关闭 —— readonly 状态是 per-page,不是 session-wide。 */
watch(
  () => props.id,
  (pageId, prevPageId) => {
    if (pageId !== prevPageId) readonlyNoticeOpen.value = false
  },
)

/* ─── P3 内部链接 hover 卡片预览 ─────────────────────────────
 *
 * sanitize.ts 在内部 /p/:id 链接上加 .internal-page-link + data-page-id。
 * 这里在 content 渲染完后绑 mouseenter / mouseleave:
 *   - enter 500ms 后挂载 PageLinkPreview(避免快速划过误触发)
 *   - leave 立即取消 timer + 清掉 hoveredLink
 *
 * WeakSet 跟踪已绑节点,页面切换同 root 复用时不重复绑。
 */
interface HoveredLink {
  pageId: string
  anchor: HTMLElement
}
const hoveredLink = ref<HoveredLink | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null
const boundHoverRoots = new WeakSet<HTMLElement>()
const HOVER_DELAY_MS = 500

function clearHoverTimer() {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
}

function bindInternalLinkHover(root: HTMLElement) {
  if (boundHoverRoots.has(root)) return
  root.querySelectorAll('a.internal-page-link').forEach((a) => {
    const anchor = a as HTMLElement
    const pageId = anchor.dataset['pageId']
    if (!pageId) return
    anchor.addEventListener('mouseenter', () => {
      clearHoverTimer()
      hoverTimer = setTimeout(() => {
        hoveredLink.value = { pageId, anchor }
        hoverTimer = null
      }, HOVER_DELAY_MS)
    })
    anchor.addEventListener('mouseleave', () => {
      clearHoverTimer()
      hoveredLink.value = null
    })
  })
  boundHoverRoots.add(root)
}

const page = computed(() => pagesStore.getPage(props.id))
const subPages = computed(() => pagesStore.getChildren(props.id))
type PageLoadState = 'loading' | 'ready' | 'not-found' | 'restricted' | 'error'
const pageLoadState = ref<PageLoadState>(page.value ? 'ready' : 'loading')
const pageLoadError = ref('')
/**
 * 模块 1 P2:被页面级 view 限制挡住时,后端(GET /api/pages/:id)回
 * 404 + `error: 'view_restricted'` + 空间名。存下空间名,好在空状态里
 * 告诉用户「去找哪个空间的管理员」——只有空间成员才会拿到这个码,
 * 非成员仍是裸 not_found,所以这里显示空间名不泄漏任何东西。
 */
const restrictedSpaceName = ref<string | null>(null)
let pageLoadRun = 0

async function loadPageResource(id: string): Promise<void> {
  const run = ++pageLoadRun
  const cached = pagesStore.getPage(id)
  const cachedSpaceId = cached?.spaceId ?? null
  if (!cached) pageLoadState.value = 'loading'
  pageLoadError.value = ''
  restrictedSpaceName.value = null

  try {
    const loaded = await api.pages.get(id)
    if (run !== pageLoadRun) return
    pagesStore.syncPageFromServer(loaded)
    pageLoadState.value = 'ready'
  } catch (error) {
    if (run !== pageLoadRun) return
    // 先判 view_restricted:它也是 404,但语义是「存在但你看不了」,
    // 不能走下面 not_found 那套「空间可能已不可见 → refresh → 跳首页」的流程。
    if (error instanceof ApiError && error.code === 'view_restricted') {
      const body = error.body as { spaceName?: string | null } | null
      restrictedSpaceName.value = body?.spaceName ?? null
      // 缓存里的这条已经不可读了,清掉避免 sidebar / 最近访问继续拿它渲染。
      pagesStore.removeCachedPage(id)
      pageLoadState.value = 'restricted'
      return
    }
    if (error instanceof ApiError && error.status === 404 && error.code === 'not_found') {
      pagesStore.removeCachedPage(id)
      if (cachedSpaceId && cachedSpaceId === spacesStore.activeSpaceId.value) {
        try {
          await spacesStore.refresh()
        } catch (refreshError) {
          if (run !== pageLoadRun) return
          pageLoadError.value = humanizeApiError(refreshError)
          pageLoadState.value = 'error'
          uiStore.setError(`刷新空间失败：${pageLoadError.value}`)
          return
        }
        if (run !== pageLoadRun) return
        const stillVisible = spacesStore.spaces.value.some((space) => space.id === cachedSpaceId)
        if (!stillVisible) {
          pagesStore.clearSpaceCache(cachedSpaceId)
          if (router.currentRoute.value.path !== '/') await router.replace('/')
          return
        }
      }
      pageLoadState.value = 'not-found'
      return
    }

    pageLoadError.value = humanizeApiError(error)
    pageLoadState.value = cached ? 'ready' : 'error'
    uiStore.setError(`加载页面失败：${pageLoadError.value}`)
  }
}

function retryPageLoad(): void {
  void loadPageResource(props.id)
}

function returnToSpaceHome(): void {
  void router.push('/')
}

watch(
  () => props.id,
  (id) => {
    pageLoadState.value = pagesStore.getPage(id) ? 'ready' : 'loading'
    void loadPageResource(id)
  },
  { immediate: true },
)

/**
 * 模块 4 P1 修复:跨空间深链进入页面时,主动 setActiveSpace,让 Sidebar /
 * SpaceSwitcher / breadcrumb 全部跟到目标空间。
 *
 * Confluence 跨空间深链面包屑首段会显示「在 X 空间」灰 chip,本仓库不复制
 * 那段视觉(在面包屑 component 里再判跨空间 → 加重组件职责);此处直接切
 * activeSpace,效果等价:用户视角下「我打开谁的空间,sidebar / switcher /
 * 面包屑上下文都跟着走」。setActiveSpace 内部 idempotent,watch 即便在
 * page 重 fetch 时反复触发也只走一次赋值。
 *
 * `immediate: true` 保证首次 mount 也会跑 —— 此时 page.value 可能还是
 * `undefined`(`loadPageResource` in-flight),`page.value?.spaceId` 为
 * `undefined`,被 if 拦掉,不抛错。loadPageResource → store → page.value
 * 解析出后第二次触发,setActiveSpace 真正生效。
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

/** 当前页是否在个人空间 —— 个人空间是用户私有草稿区,不暴露关注入口
 * (无 watch 语义,也不向别人推送通知)。activeSpaceId 用作兜底,这样即使
 * page 还没加载完也能正确隐藏按钮。 */
const isPersonalSpace = computed(() => {
  const pid = authStore.personalSpaceId
  if (!pid) return false
  if (page.value?.spaceId === pid) return true
  return spacesStore.activeSpaceId.value === pid
})
/** 浏览器 tab 标题:页面名 + "· power-wiki";page 还没解析出时退回 BASE。
 * watchEffect 自动响应 page.value 的 reactive 变化。 */
useDocumentTitle(() => page.value?.title)

/**
 * 折叠块 read 视图默认收起。
 * 编辑器存的 <details open> 在 read 端需要显示为 collapsed(Confluence / 飞书
 * 风格 —— 不希望一进页面所有折叠块全展开)。strip 掉所有 details 的 open 属性。
 * 用户点 summary 仍可展开,刷新页面后回到 collapsed —— 这是"默认折叠"的语义。
 * exportPageAsHtml 也走 sanitizeAndHardenLinks,导出仍要保留原 open 状态,所以
 * 这一步不放在 sanitize 里,只在 read 视图的 safeHtml 管道里做。
 */
function collapseTogglesByDefault(html: string): string {
  if (!html || typeof document === 'undefined') return html
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  wrap.querySelectorAll('details[open]').forEach((d) => d.removeAttribute('open'))
  return wrap.innerHTML
}

/**
 * 页面是否真的没有内容。区分「空 doc shell(只有 paragraph 节点、没文字)」
 * 和「有非文字内容(图 / 标题 / 代码块 / 折叠块 / 引用 / 列表 / 表格 等)」。
 *
 * 判定规则:
 *   - 非 paragraph 顶层块一律算有内容(覆盖 imageAttachment / heading /
 *     codeBlock / blockquote / bulletList / orderedList / details / table 等
 *     void 或自带语义的块)
 *   - paragraph 必须含 text 子节点才算有内容(空 paragraph 是用户按 Enter
 *     留下的痕迹,跟真正空 doc 等价)
 */
function isPageContentEmpty(json: unknown): boolean {
  if (!json || typeof json !== 'object') return true
  const doc = json as { type?: string; content?: unknown[] }
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) return true
  return !doc.content.some((node) => isMeaningfulTopNode(node))
}

function isMeaningfulTopNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as { type?: string; content?: unknown[] }
  if (n.type !== 'paragraph') return true
  if (!Array.isArray(n.content)) return false
  return n.content.some((c) => {
    if (!c || typeof c !== 'object') return false
    return typeof (c as { text?: unknown }).text === 'string'
  })
}

const safeHtml = computed(() =>
  collapseTogglesByDefault(sanitizeAndHardenLinks(page.value?.contentHTML ?? '')),
)
const contentEl = ref<HTMLElement | null>(null)

/**
 * 「空内容」占位判定。pages.contentHTML 是 EMPTY_HTML('<>...空 doc
 * shell')时,正文区跟 "暂无内容" 等价 —— author 刚创建还没写过任何东西。
 * Confluence 风格是显示一行说明 + edit 引导(若有权限),而不是空白页面
 * 让 reader 摸不着头脑。
 *
 * 判定走 `isPageContentEmpty` 走 contentJSON 的节点结构:任何非 paragraph
 * 块(图 / 标题 / 代码 / 折叠 / 列表 / 引用 / 表格)都算有内容,paragraph
 * 必须有 text 子节点才算。EMPTY_HTML 短路保留,以兼容 seed 页 / 旧存量
 * 没有 contentJSON 的退化场景。
 */
const isEmptyContent = computed(() => {
  const p = page.value
  if (!p) return true
  if (!p.contentHTML || p.contentHTML === EMPTY_HTML) return true
  return isPageContentEmpty(p.contentJSON)
})

/**
 * 署名行展示名:优先用最后编辑者(`updatedByName`);编辑者用户已删
 * (LEFT JOIN 拿不到)时回退到作者(`authorName`),最终兜底 '未知作者'。
 *   - 新建页没改过 → updatedByName 可能为 null(没回退还在 ing,但 0012
 *     migration 已把存量行 updated_by 回填 author_id,所以生产环境实际
 *     几乎遇不到)
 *   - 跨用户编辑后 → 显示的是真正最近改的人,跟"最后编辑于"语义闭环
 *   - authorId='me'(旧 seed,且 updatedByName 拿不到)→ '我'
 */
const editorDisplay = computed(() => {
  const p = page.value
  if (!p) return ''
  if (p.updatedByName) return p.updatedByName
  if (p.authorName) return p.authorName
  if (p.authorId === 'me') return '我'
  return '未知作者'
})

/** 头像色:优先编辑者色,其次作者色,最后中性灰 */
const editorAvatarColor = computed(
  () =>
    page.value?.updatedByColor ??
    page.value?.authorColor ??
    'var(--text-3)',
)

/**
 * 作者(创建者)展示名 —— 与 editorDisplay 解耦,for "由 X 创建" 后缀。
 * authorId='me' 旧 seed → '我';作者用户已删 → '未知作者'(读起来比空串稳)。
 */
const authorDisplay = computed(() => {
  const p = page.value
  if (!p) return ''
  if (p.authorName) return p.authorName
  if (p.authorId === 'me') return '我'
  return '未知作者'
})

/**
 * 是否在署名行末尾追加 "由 X 创建" 后缀。
 *   - updatedBy == null  → 视为老存量(未 backfill),仍展示作者
 *   - updatedBy !== authorId  → 跨用户编辑过,展示作者
 *   - 同一人 / 同 'me' → 不展示,避免 "happy 最后编辑 · 由 happy 创建" 这种冗余
 *
 * 按 user.id 比较(而不是 name),规避重名 / 改名带来的误判;authorId='me' 跟
 * 任意真实 user.id 都不会相等,所以老 seed 页(updatedBy 被 0012 回填成 'me'
 * 后又被人改 → updatedBy 变成真实 id)也是追加的,符合预期。
 */
const showAuthorSuffix = computed(() => {
  const p = page.value
  if (!p) return false
  if (p.updatedBy == null) return true
  return p.updatedBy !== p.authorId
})

// 面包屑链路(根 → 当前页) + 折叠渲染分段(>3 段中间省略)
// usePageBreadcrumbSegments 适配到统一 <Breadcrumb> 组件,跟 EditView /
// HistoryView 走同一份渲染;折叠 / … 省略策略在 composable 里集中处理。
const pageBreadcrumb = usePageBreadcrumbSegments(() => props.id)
const breadcrumbSegments = computed(() => [
  { label: '我的知识库', to: '/' },
  ...pageBreadcrumb.value,
])

function goEdit() {
  if (page.value) router.push(`/p/${page.value.id}/edit`)
}
function goPage(id: string) {
  router.push(`/p/${id}`)
}

function relativeTime(ts: number): string {
  return formatRelativeTime(ts)
}

/**
 * 页面顶栏 👍 toggle。乐观更新走 store(本地先翻 likedByMe + ±1 count),
 * 服务端回包覆盖。我们不依赖本地乐观值做 UI(button 状态用 page.likedByMe,
 * 它是 reactive 的),失败由 store banner 兜底,这里只防双击(re-entry
 * 防护:toggling=true 期间忽略第二次点击)。
 */
const togglingLike = ref(false)
/**
 * 点赞点击动效触发器:点击瞬间置 true,360ms 后回 false。
 * rAF 隔一帧再加 class 是为了连点时能重启动画(同 class 直接赋值不会
 * 重跑 @keyframes);clearTimeout 防止连点叠加导致提前复位。
 */
const popping = ref(false)
let popResetTimer: ReturnType<typeof setTimeout> | null = null
function triggerLikePop() {
  popping.value = false
  if (popResetTimer !== null) clearTimeout(popResetTimer)
  requestAnimationFrame(() => {
    popping.value = true
    popResetTimer = setTimeout(() => {
      popping.value = false
      popResetTimer = null
    }, 420)
  })
}
async function onToggleLike() {
  if (!page.value || togglingLike.value) return
  triggerLikePop()
  togglingLike.value = true
  try {
    await pagesStore.togglePageLike(page.value.id)
  } finally {
    togglingLike.value = false
  }
}

/**
 * Copy this page in place — POST /api/pages/:id/duplicate. On success
 * the store renumbers the source's sibling group so the copy lands
 * immediately after the source, and we navigate to the new copy's read
 * view (mirrors `publishPageToSpace`'s navigation pattern from PageTree).
 * Store shows the error banner on failure; no inner try/catch needed.
 */
async function onDuplicate() {
  if (!page.value) return
  const created = await pagesStore.duplicatePage(page.value.id)
  await router.push(`/p/${created.id}`)
}

watch(page, async () => {
  await new Promise((r) => setTimeout(r, 50))
  contentEl.value = document.querySelector('.read-content')
})

/**
 * 每次 page 解析出真实数据(不是 404 fallback)就写入 recents。
 * `recordVisit` 内部去重 + 移到队首,所以从 /p/A 直接到 /p/B 不会重复
 * 记录 A。同一个用户在两个 tab 同时打开同一页,后写的 visitedAt
 * 胜出 — 这是预期(谁后访问谁更新)。
 */
watch(
  () => page.value,
  (p) => {
    if (p && p.title) recordVisit({ id: p.id, title: p.title, spaceId: p.spaceId })
  },
  { immediate: true },
)

// hash 锚点滚动统一交给 router scrollBehavior 处理(看 router/index.ts):
//   - `#h-xxx`(heading 锚点):TocPanel click / 直链 / 刷新都走同一段逻辑,
//     Promise 轮询等 heading 元素出现再 smooth-scroll。
//   - `#comment-xxx`(通知跳过来):scrollBehavior 内部按 comment 特判
//     block:'center' + 更长 poll(6s)适配评论异步 fetch。
// 这里不再单独 watch route.hash,避免和 scrollBehavior 双重滚动。

// v-html 之后跑一道语法高亮(read 端没有 decorations,需要手动补)
// 监听 props.id:页面切换时,safeHtml 也会变,但 props.id 更稳定地反映路由切换。
// immediate:true 保证首次挂载也跑一次。
watch(
  () => props.id,
  async () => {
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const root = document.querySelector('.read-content') as HTMLElement | null
    contentEl.value = root
    if (root) {
      highlightCodeBlocks(root)
      addHeadingAnchors(root)
      bindInternalLinkHover(root)
    }
  },
  { flush: 'post', immediate: true },
)

onBeforeUnmount(() => {
  clearHoverTimer()
  hoveredLink.value = null
})

// read 视图下点击 task checkbox → 立即 toggle DOM + 写回 store,
// 刷新或下次进入该页仍保留状态。
//
// 流程:
//  1. 拦截 .read-content 内 input[type=checkbox] 的 click,preventDefault 阻止浏览器默认 toggle
//  2. 找到最近 li[data-type=taskItem],切换 data-checked + input.checked
//  3. 克隆 .read-content(去掉 addHeadingAnchors 注入的 a.heading-anchor),
//     拿 innerHTML 作为新的 contentHTML
//  4. 用 htmlToJson 重新生成 contentJSON
//  5. updatePage({ contentJSON, contentHTML }) → store 持久化到 localStorage
//
// 用 WeakSet 跟踪已挂监听器的 DOM,避免重复绑定(同 div 在多次 pageKey 切换时复用)
const boundRoots = new WeakSet<HTMLElement>()
function onContentClick(e: MouseEvent) {
  const root = contentEl.value
  if (!root) return
  const target = e.target as HTMLElement | null
  if (!target || target.tagName !== 'INPUT') return
  const input = target as HTMLInputElement
  if (input.type !== 'checkbox') return
  const li = input.closest('li[data-type="taskItem"]') as HTMLElement | null
  if (!li) return
  e.preventDefault()
  const wasChecked = li.dataset['checked'] === 'true'
  const willChecked = !wasChecked
  li.dataset['checked'] = String(willChecked)
  input.checked = willChecked
  if (willChecked) input.setAttribute('checked', 'checked')
  else input.removeAttribute('checked')
  // 写回 store
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('a.heading-anchor').forEach((a) => a.remove())
  const newHTML = clone.innerHTML
  const p = page.value
  if (!p) return
  // 任务清单 toggle 是"用户已经看到效果"的写操作 → fire-and-forget,
  // store 自己处理乐观更新 + 失败回滚 + banner。
  void pagesStore.updatePage(p.id, {
    contentJSON: htmlToJson(newHTML) as Record<string, unknown>,
    contentHTML: newHTML,
  })
}
function bindContentClick(root: HTMLElement) {
  if (boundRoots.has(root)) return
  root.addEventListener('click', onContentClick)
  boundRoots.add(root)
}
watch(
  contentEl,
  (root) => {
    if (root) bindContentClick(root)
  },
  { flush: 'post' },
)

// ─── 图片附件 lightbox(只在 ReadView 挂载)───────────────────
// 点击 figure.attachment-image > img → 全屏查看;Esc 关闭;点击背景关闭。
// 不和 task checkbox 的 onContentClick 冲突(task 点击是 INPUT,这里是 IMG,
// 走的是不同 path)。状态与打开逻辑共用 useAttachmentLightbox,绑定策略见下。
const { lightbox, closeLightbox, openFromImg } = useAttachmentLightbox()

/* ─── 页面级限制 dialog(Phase B)───────────────────────
 * 按钮可见性用启发式 gate:
 *   - 全局 admin → 可见
 *   - 页面作者 → 可见(能编辑就有资格管自己的限制)
 *   - 非作者 space-admin → v0 不在客户端 gate 内,需由后端 404 兜底。
 *     这是已知 v0 缺口(space role 信息当前没下沉到 PageNode);下次页面
 *     schema 改时把 `viewerRole` 加上就能 cover 这个 case。
 *
 * saved 事件传回的 flags 直接 patch 到 page.hasViewRestriction /
 * hasEditRestriction 上,避免读侧重拉整页。 */
const restrictionsOpen = ref(false)
/** 启发式 gate:跟 canEdit 对称 —— isAdmin || 非 viewer(=editor / admin) ||
 *  作者本人。后端 `canManageRestrictions` 同样三选一:isAdmin / 作者本人 /
 *  canEditPage(空间 editor / space-admin 都覆盖)。
 *
 *  个人空间写矩阵(P0-3):global admin 即使 own 自己的 personal space 也按
 *  supervisor 处理 —— 不能编辑 / 不能改限制 / 不能分享。先用
 *  canWritePersonalSpace 把 personal 拒掉。 */
const canManageRestrictions = computed(() => {
  const p = page.value
  if (!p) return false
  const me = authStore.user
  if (!me) return false
  if (isPersonalSpace.value) return false
  if (!canWritePersonalSpace(me, spaceRefForPage(p))) return false
  if (authStore.isAdmin) return true
  if (p.viewerRole && p.viewerRole !== 'viewer') return true
  if (me.id === p.authorId) return true
  return false
})
/** Phase D: 公开分享的 canManage gate —— 与 canManageRestrictions 对称
 *  (page 作者 / admin / 空间 admin / 空间 editor)。`viewerRole` 由后端
 *  PageNodeSchema 注入,跟 share 路由的 canEditPage gate 等价;space-
 *  admin 没有 `viewerRole='admin'` 的中间档(直接 isAdmin),但跟 canEdit
 *  共用同一段判断。 */
const canShare = computed(() => {
  const p = page.value
  if (!p) return false
  const me = authStore.user
  if (!me) return false
  // 归档空间不再发放新的分享链接(share 是写操作)。
  if (p.spaceArchived) return false
  if (isPersonalSpace.value) return false
  if (!canWritePersonalSpace(me, spaceRefForPage(p))) return false
  if (authStore.isAdmin) return true
  if (p.viewerRole && p.viewerRole !== 'viewer') return true
  if (me.id === p.authorId) return true
  return false
})

/** 顶部「编辑」按钮 gate:server 端 PageNode.viewerRole 注入 effective role,
 *  非 viewer(=editor/admin)直接显示;viewer 时仅作者本人保留(author bypass,
 *  对齐 canEditPage)。空间级 canEditSpace 隐含包含在 viewerRole='editor' 里,
 *  这里不再二次查 space grant。 */
const canEdit = computed(() => {
  const p = page.value
  if (!p) return false
  const me = authStore.user
  if (!me) return false
  // 模块 1 P2:归档空间整体只读,admin 也不例外(对齐后端 canEditSpace)。
  if (p.spaceArchived) return false
  if (!canWritePersonalSpace(me, spaceRefForPage(p))) return false
  if (authStore.isAdmin) return true
  if (p.viewerRole && p.viewerRole !== 'viewer') return true
  if (me.id === p.authorId) return true
  return false
})

/**
 * 移动 / 删除与编辑共用同一套写权限 gate(都是 page 级写操作)。
 * 不重复定义条件 —— canEdit 已经覆盖 admin / viewerRole / 作者 /
 * 归档 / 个人空间所有边界。
 */
const canMove = computed(() => canEdit.value)
const canDelete = computed(() => canEdit.value)

const shareOpen = ref(false)
function onRestrictionsSaved(flags: {
  hasViewRestriction: boolean
  hasEditRestriction: boolean
}) {
  if (!page.value) return
  pagesStore.patchPage(page.value.id, {
    hasViewRestriction: flags.hasViewRestriction,
    hasEditRestriction: flags.hasEditRestriction,
  })
}

/**
 * 顶栏 ⋮ → 删除链路 —— 镜像 PageTree.deletePage 但**不**预检
 * liveDescendantCount:顶栏用户对页面树结构无直观感知,删父页导致
 * 子页一并进回收站的代价不可见,不如依赖 server 409 + banner 兜底
 * (PageTree 行级点击保留 precheck 是因为树视图能直接看到父子关系)。
 */
async function onDelete() {
  if (!page.value) return
  const ok = await confirm({
    title: `删除「${page.value.title}」?`,
    message: '页面将进入回收站,可联系管理员恢复。',
    danger: true,
    confirmText: '删除',
    cancelText: '取消',
  })
  if (!ok) return
  const wasCurrent = route.params.id === page.value.id
  try {
    await pagesStore.softDeletePage(page.value.id)
  } catch {
    return
  }
  if (wasCurrent) router.push('/')
}

function onAttachmentImgClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target) return
  // 只拦 figure.attachment-image 里的 img 节点(别的 img 比如 emoji 之类不接管)
  const img = target.closest('.attachment-image > img') as HTMLImageElement | null
  if (!img) return
  // 已被 sanitize 替换为 span.blocked-image 的占位符不会到这里(它是 span)
  e.preventDefault()
  openFromImg(img)
}

const boundAttachmentRoots = new WeakSet<HTMLElement>()
function bindAttachmentLightbox(root: HTMLElement) {
  if (boundAttachmentRoots.has(root)) return
  root.addEventListener('click', onAttachmentImgClick)
  boundAttachmentRoots.add(root)
}
watch(
  contentEl,
  (root) => {
    if (root) bindAttachmentLightbox(root)
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="read-shell">
    <ScrollProgress />
    <Breadcrumb :segments="breadcrumbSegments" />
    <PageActions>
      <!-- 关注按钮 —— 个人空间无 watch 语义,直接不渲染。 -->
      <PageWatchButton v-if="page && !isPersonalSpace" :page="page" />
      <!-- 复制按钮:恢复模块 2 P0 的「复制」入口,onDuplicate() 已存在。 -->
      <button
        v-if="page"
        class="btn"
        type="button"
        title="复制页面"
        @click="onDuplicate"
      >
        <span class="material-symbols-outlined icon-md">content_copy</span>
        复制
      </button>
      <!-- ⋮ 更多操作 —— 把现有 导出 / 历史 / 限制 / 分享 + 新增 移动 / 复制链接
           / 删除 全部装进 popover。1280 视口下顶栏只剩 4 个元素,不再挤爆
           subheader。 -->
      <PageMoreActionsMenu
        v-if="page"
        :page="page"
        :can-share="canShare"
        :can-manage-restrictions="canManageRestrictions"
        :can-move="canMove"
        :can-delete="canDelete"
        @restrictions="restrictionsOpen = true"
        @share="shareOpen = true"
        @delete="onDelete"
      />
      <button v-if="canEdit" class="btn primary" @click="goEdit">
        <span class="material-symbols-outlined icon-lg">edit</span>
        编辑
      </button>
    </PageActions>

    <!-- Viewer 兜底 banner —— EditView 检测到无权限时,redirect 到当前
         read URL 并挂 ?readonly=1。这里消费 query、显示提示、然后用
         router.replace 抹掉 query,避免用户刷新后再次看到 banner(语义
         是"这次跳转触发的通知",不是持久状态)。信息层级跟全局错误
         banner 区分:这是预期 redirect 触发的提示,不是错误。 -->
    <div
      v-if="readonlyNoticeOpen"
      class="readonly-notice"
      role="status"
      aria-live="polite"
    >
      <span class="material-symbols-outlined readonly-notice-icon" aria-hidden="true">
        visibility
      </span>
      <span class="readonly-notice-text">
        你没有此页面的编辑权限,已切换到只读模式。
      </span>
      <button
        type="button"
        class="readonly-notice-close"
        aria-label="关闭提示"
        @click="dismissReadonlyNotice"
      >
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </div>

    <!-- 专题 12:TOC 折叠手柄 —— 只在 tocCollapsed 时显示。
       放 ReadView 内部(而非 App.vue 顶层)是为了路由切到 EditView 等
       没有 TOC 的视图时,手柄自然随组件卸载消失。 -->
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

    <div class="content-inner read-page">
          <!-- 冷启动 / store 还没 fetch 完时显示 Skeleton(直链 / 刷新场景)。
               遵守 docs/loading-ux.md:33 "首次加载用 Skeleton,不用「加载中…」文本"。
               Skeleton 形状模仿真实内容(title + byline + 多行正文 + callout-ish),
               chrome 高度稳定,load 后是 fade 而不是空白闪一下。
               按 active space 判断根是否就绪 —— 全局 `loaded` 是「至少一个空间
               加载完」太宽,在跨空间跳转或刚切空间时会过早取消 skeleton。 -->
          <div v-if="pageLoadState !== 'not-found' && pageLoadState !== 'restricted' && pageLoadState !== 'error' && (pageLoadState === 'loading' || (spacesStore.activeSpaceId.value && !pagesStore.isRootsLoaded(spacesStore.activeSpaceId.value)))" class="read-skeleton" aria-busy="true" aria-live="polite">
            <Skeleton height="36px" width="70%" />
            <div class="read-skeleton-byline">
              <Skeleton width="32px" height="32px" radius="50%" />
              <Skeleton width="40%" height="12px" />
              <Skeleton width="25%" height="12px" />
            </div>
            <div class="read-skeleton-content">
              <Skeleton :count="8" height="14px" />
              <Skeleton height="56px" />
              <Skeleton :count="4" height="14px" />
              <Skeleton height="56px" />
              <Skeleton :count="3" height="14px" />
            </div>
          </div>
          <EmptyState
            v-else-if="pageLoadState === 'not-found'"
            variant="no-permission"
            icon="find_in_page"
            title="无法打开这个页面"
            hint="页面可能已被删除，或者你没有访问权限。"
            size="lg"
          >
            <button type="button" class="btn primary" @click="returnToSpaceHome">
              返回空间首页
            </button>
          </EmptyState>
          <!-- 模块 1 P2:区分「页面不存在」和「页面有查看限制」。后者给出
               空间名 + 明确的下一步(找空间管理员申请),而不是一律 404。 -->
          <EmptyState
            v-else-if="pageLoadState === 'restricted'"
            variant="no-permission"
            icon="lock"
            title="此页面存在访问限制"
            :hint="restrictedSpaceName
              ? `这个页面被设置了查看限制，你目前不在允许名单里。如需访问，请联系空间「${restrictedSpaceName}」的管理员。`
              : '这个页面被设置了查看限制，你目前不在允许名单里。如需访问，请联系该空间的管理员。'"
            size="lg"
          >
            <button type="button" class="btn primary" @click="returnToSpaceHome">
              返回空间首页
            </button>
          </EmptyState>
          <EmptyState
            v-else-if="pageLoadState === 'error'"
            icon="cloud_off"
            title="页面暂时无法加载"
            :hint="pageLoadError"
            size="lg"
          >
            <button type="button" class="btn primary" @click="retryPageLoad">
              重新加载
            </button>
          </EmptyState>
          <div v-else-if="page">
            <!-- 模块 1 P2:归档空间只读横幅。归档语义此前只在 Sidebar /
                 SpaceSwitcher 表达,深链直接打开归档空间里的页面时毫无提示,
                 用户点了保存才发现无效。这里在正文最上方明说。 -->
            <div v-if="page.spaceArchived" class="archived-banner">
              <span class="material-symbols-outlined archived-banner-icon" aria-hidden="true">
                inventory_2
              </span>
              <div class="archived-banner-text">
                <strong>此空间已归档,仅可阅读。</strong>
                <span>归档空间的页面不能新建、编辑或删除。如需恢复编辑,请联系管理员解除归档。</span>
              </div>
            </div>

            <!-- 标签条(紧凑版) — 已发布是页面状态,作者 pill 是贡献者元数据,
                 都归 .page-tags。每条 pill 角色清晰:已发布 = 状态,创建者 = 角色。
                 作者 pill 仅在「最后编辑者 ≠ 创建者」时出现(同人场景由 byline
                 的头像 + 名字呈现,不重复堆 pill),避免 "happy 创建 · HA happy"
                 这种同一人两份表达的冗余。 -->
            <div class="page-tags">
              <span class="status-pill success">
                <span class="material-symbols-outlined icon-sm">check_circle</span>
                已发布
              </span>
              <span v-if="showAuthorSuffix" class="status-pill purple">
                <span class="material-symbols-outlined icon-sm">account_circle</span>
                {{ authorDisplay }} 创建
              </span>
              <!-- Phase B 限制 chip —— view 限制(继承)用锁定 icon,edit 限制
                   (不继承)用 edit icon。chip 只展示「有此限制」的元信息,不
                   点开;真正配置走 dialog。Strict-default 顺序让色值对应语义
                   清晰(view=accent 蓝,edit=警告橙)。 -->
              <span
                v-if="page.hasViewRestriction"
                class="status-pill restriction"
                title="此页设置了查看限制(会沿父链向下继承)"
              >
                <span class="material-symbols-outlined icon-sm">lock</span>
                限制查看
              </span>
              <span
                v-if="page.hasEditRestriction"
                class="status-pill restriction warn"
                title="此页设置了编辑限制(只作用于本页)"
              >
                <span class="material-symbols-outlined icon-sm">edit</span>
                限制编辑
              </span>
            </div>

            <h1 class="page-title">{{ page.title }}</h1>
            <div class="page-byline">
              <span class="author">
                <UserAvatar :size="20" :color="editorAvatarColor" :label="editorDisplay" :avatar-kind="page.updatedByAvatarKind ?? page.authorAvatarKind ?? null" :avatar-ref="page.updatedByAvatarRef ?? page.authorAvatarRef ?? null" :user-id="page.updatedBy ?? page.authorId ?? null" />
                {{ editorDisplay }}
              </span>
              <span class="dot">·</span>
              <span>最后编辑于 {{ relativeTime(page.updatedAt) }}</span>
              <template v-if="!isEmptyContent && charCount(page.contentHTML) > 0">
                <span class="dot">·</span>
                <span>{{ charCount(page.contentHTML) }} 字</span>
              </template>
              <!-- 跟前几个 metadata 项一样,跟 reactions 之间用 `.dot` 中点
                   分隔 —— 让 byline gap 节奏(reactions 与"字数" / "时间"
                   间距)跟"作者 → 时间 → 字数"内部间隔统一。 -->
              <span v-if="page" class="dot">·</span>

              <!-- 模块 2 P1 (2.8 + 2.11) reactions 接在 byline 末尾、随 metadata
                   自然左流(不 margin-left:auto 右推)—— 标题左对齐,读者反馈
                   紧跟在"作者 / 时间 / 字数"之后,视线不用横跨整行。0 垂直新增,
                   body 紧贴 byline(原来 reactions 独占底部 section)。
                   字号 / 颜色 / 字重全部继承 .page-byline,不做局部覆盖。

                   短文案(label 收敛到一个字):
                     - inactive:`👍 赞`
                     - active:`👍 已赞 · N`(N>0);`👍 已赞`(N=0 兜底)
                   中文互联网习惯用法(微信 / 微博 / 知乎 / 掘金),比"觉得有用"
                   更短更直接,但依旧用 inline 文字解决 2.11 的裸 thumb-up 痛点
                   (新用户一眼看出这是赞)。 active 切"已赞"是双重反馈:icon 翻
                   filled + label 跟切 + count 浮出。 -->
              <div v-if="page" class="page-reactions">
                <button
                  type="button"
                  class="like-button"
                  :class="{ active: page.likedByMe === true, popping }"
                  :disabled="togglingLike"
                  :aria-pressed="page.likedByMe === true"
                  :aria-label="page.likedByMe ? '取消点赞' : '给作者点个赞'"
                  :title="page.likedByMe ? '已赞 · 再点取消' : '赞'"
                  @click="onToggleLike"
                >
                  <span class="like-icon-wrap" aria-hidden="true">
                    <span class="material-symbols-outlined like-icon like-icon--outlined">thumb_up</span>
                    <span class="material-symbols-outlined like-icon like-icon--filled">thumb_up</span>
                  </span>
                  <span v-if="page.likedByMe" class="like-label">已赞</span>
                  <span v-else class="like-label">赞</span>
                  <!-- 数字始终放 label 后面(N>0 才显示,避免 "已赞 · 0");label
                       切换是 active/inactive 的强反馈,数字作 note。 -->
                  <template v-if="page.likedByMe && (page.likesCount ?? 0) > 0">
                    <span class="like-sep">·</span>
                    <span :key="page.likesCount ?? 0" class="like-count">{{ page.likesCount ?? 0 }}</span>
                  </template>
                </button>
                <WhoLikedList :page="page" />
              </div>
            </div>

            <div ref="contentEl" class="prose read-content" v-html="safeHtml"></div>

            <!-- M2: 空内容占位 —— 页面存在但 published 内容是空(作者还在
                 草稿阶段 / 刚创建未写)。显示 Confluence 风格 "暂无内容"
                 提示,不让 reader 面对空白页迷茫。文字计数也跟着隐藏,
                 避免 "0 字" 这种不友好的展示。 -->
            <div v-if="isEmptyContent" class="empty-content-placeholder">
              <span class="material-symbols-outlined empty-content-icon" aria-hidden="true">
                edit_document
              </span>
              <div class="empty-content-title">暂无内容</div>
              <div class="empty-content-hint">
                此页面尚未发布内容,等待作者编辑发布。
              </div>
            </div>

            <!-- 模块 2 P1 (2.8) 重排 metadata 顺序:Confluence 风格
                 正文 → Labels(一级 metadata)→ Attachments → Children →
                 Comments。Labels / Attachments 间距统一 24px(原 Labels 32 /
                 Attachments 24 不齐)。Reactions 整组上移到 byline 子行
                 (见上面 .page-reactions),不留底部独立 section。 -->

            <!-- 标签条:一级 metadata,先于附件。 -->
            <LabelPills v-if="page" :page="page" />

            <!-- 附件汇总:二级 metadata,放在 Labels 之下。count=0 时整段
                 不渲染,无视觉干扰。 -->
            <AttachmentsSection v-if="page" :page-id="page.id" />

            <div v-if="subPages.length > 0" class="subpages">
              <div class="subpages-title">
                <span>子页面</span>
                <span class="count">{{ subPages.length }}</span>
              </div>
              <div
                v-for="sp in subPages"
                :key="sp.id"
                class="subpage-row"
                @click="goPage(sp.id)"
              >
                <span class="material-symbols-outlined doc-icon" style="font-size:18px">description</span>
                <span class="label">{{ sp.title }}</span>
                <span class="updated">{{ relativeTime(sp.updatedAt) }}</span>
              </div>
            </div>

            <!-- Stage 6: live comments section (replaces the prior dead
                 `<div class="comments">…<textarea disabled>` placeholder). -->
            <CommentsSection v-if="page" :page-id="page.id" />
          </div>
          <div v-else class="empty">
            <div class="empty-icon">
              <span class="material-symbols-outlined icon-4xl">search_off</span>
            </div>
            <h2>页面不存在</h2>
            <p>该页面已被删除,或链接错误。</p>
            <button class="btn primary" @click="router.push('/')">返回首页</button>
          </div>
        </div>

      <!-- 图片附件全屏预览。Teleport 到 body,锁住背景滚动。
           放 content div 之外,跟 v-if/v-else 解耦。 -->
      <AttachmentLightbox
        :open="lightbox.open"
        :src="lightbox.src"
        :alt="lightbox.alt"
        :filename="lightbox.filename"
        @close="closeLightbox"
      />

      <!-- 内部链接 hover 预览卡片。Teleport 到 body,500ms 延迟挂载。 -->
      <PageLinkPreview
        v-if="hoveredLink"
        :page-id="hoveredLink.pageId"
        :anchor="hoveredLink.anchor"
      />

      <!-- Phase B 页面级限制 dialog —— 自身 Teleport 到 body,跟编辑/恢复等
           modal 同级。`saved` 事件回调把 flags patch 到本地 page,chip 立即
           反映避免下次 mount 才看到。 -->
      <PageRestrictionsDialog
        v-if="page"
        v-model:open="restrictionsOpen"
        :page-id="page.id"
        :page-title="page.title"
        @saved="onRestrictionsSaved"
      />
      <!-- Phase D 公开分享弹窗(canShare 同 canManageRestrictions 启发式:
           admin / 作者本人;空间 admin / editor 由后端 share 路由兜底,UI
           粗粒度 gate 不重复拉 role)。 -->
      <ShareDialog
        v-if="page"
        v-model:open="shareOpen"
        :page-id="page.id"
        :page-title="page.title"
      />

      <Teleport v-if="rightRailEl" :to="rightRailEl">
        <TocPanel
          v-if="page"
          :content-ref="contentEl"
          :page-key="page.id"
          :labels="page.labels ?? []"
        />
      </Teleport>
  </div>
</template>

<style scoped>
.read-page { padding-top: 24px; }

/* M2: 空内容占位 —— Confluence 风格的居中提示块,跟上方 .prose 之
   间留 32px 视觉缓冲。文字 + icon 上下结构居中,跟设计基准同款柔和
   色 + bg-subtle 容器,避免大空白块让 reader 误以为页面坏了。
   模块 2 P1 (2.8):空内容占位下方紧跟 LabelPills(一级 metadata),
   Labels margin-top:24px 节律跟 placeholder 自带 margin-top:32px
   合计 56px,跟"主要内容区"(正文 / 空态)和"metadata 区"(标签 / 附件)
   自然分界。 */
.empty-content-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 24px;
  margin-top: 32px;
  background: var(--bg-subtle);
  border-radius: var(--radius);
  text-align: center;
}
.empty-content-icon {
  font-size: 48px;
  color: var(--text-3);
  margin-bottom: 16px;
  font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24;
}
.empty-content-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 6px;
}
.empty-content-hint {
  font-size: 13px;
  color: var(--text-3);
  max-width: 360px;
}

/* 模块 1 P2:归档只读横幅。用中性灰(与 Sidebar 归档灰带同语义)而非
   warning 橙 —— 归档是生命周期状态,不是错误或风险。 */
.archived-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  margin-bottom: 20px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.archived-banner-icon {
  font-size: 20px;
  line-height: 1.2;
  color: var(--text-3);
  flex-shrink: 0;
}

.archived-banner-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--text-2);
}

.archived-banner-text strong {
  color: var(--text-1);
  font-weight: 600;
}

.page-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.subpages-title .count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  margin-left: 6px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}

/* `页面历史` RouterLink:跟 ExportMenu 的 `.btn` 同款(不用 ghost)—
 跟原 VersionPanelToggle 视觉一致。Vue Router 会自动加
 `.router-link-active` / `.router-link-exact-active`,不过当前路由下
 不会走到这里,这两个状态都用不到。 */
.version-link,
.version-link:hover {
  gap: 4px;
  text-decoration: none;
}
.version-link .material-symbols-outlined {
  font-size: 16px;
}

/* ReadView Skeleton —— 模仿真实布局的占位行,chrome 高度稳定 */
.read-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 8px;
}

/* Viewer 兜底 banner —— EditView redirect 时挂的提示。色调走中性信息
   色(--bg-subtle + --accent-soft 图标),不挂全局错误 banner 那种
   --danger-* 红,语义是"被引导到正确视图",不是"出错"。放在
   .subheader 之下、TOC 折叠手柄之上,这样视图顶部区域不会因为这个
   banner 突然变窄(它是 inline block,自然撑开 subheader 下面那行)。 */
.readonly-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 24px 0;
  padding: 10px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text-2);
}
.readonly-notice-icon {
  color: var(--accent);
  font-size: 18px;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
}
.readonly-notice-text {
  flex: 1;
  min-width: 0;
}
.readonly-notice-close {
  background: transparent;
  border: 0;
  padding: 2px;
  border-radius: 3px;
  cursor: pointer;
  color: var(--text-3);
  opacity: 0.6;
  display: inline-flex;
  align-items: center;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.readonly-notice-close:hover {
  opacity: 1;
}
.readonly-notice-close:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
  opacity: 1;
}
.readonly-notice-close .material-symbols-outlined {
  font-size: 18px;
}
.read-skeleton-byline {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 0 8px;
}
.read-skeleton-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
</style>
