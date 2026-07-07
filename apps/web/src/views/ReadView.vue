<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useRouter } from 'vue-router'
import { useRecentPages } from '@/composables/useRecentPages'
import Sidebar from '@/components/layout/Sidebar.vue'
import TocPanel from '@/components/layout/TocPanel.vue'
import LabelPills from '@/components/page/LabelPills.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import CommentsSection from '@/components/comments/CommentsSection.vue'
import ExportMenu from '@/components/editor/ExportMenu.vue'
import AttachmentLightbox from '@/components/page/AttachmentLightbox.vue'
import { sanitizeAndHardenLinks } from '@/lib/sanitize'
import { highlightCodeBlocks } from '@/lib/renderHighlight'
import { addHeadingAnchors } from '@/lib/headingAnchors'
import { recomputeLiveDates, startLiveDateInterval } from '@/lib/recomputeLiveDates'
import { htmlToJson } from '@/editor/htmlToJson'
import { charCount } from '@/lib/textMetrics'
import { formatRelativeTime } from '@/lib/relativeTime'

const props = defineProps<{ id: string }>()
const pagesStore = usePagesStore()
const router = useRouter()
const { recordVisit } = useRecentPages()

const page = computed(() => pagesStore.getPage(props.id))
const subPages = computed(() => pagesStore.getChildren(props.id))

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

const safeHtml = computed(() =>
  collapseTogglesByDefault(sanitizeAndHardenLinks(page.value?.contentHTML ?? '')),
)
const contentEl = ref<HTMLElement | null>(null)

/**
 * 作者展示名。
 *   - 真实 JOIN 命中 → authorName
 *   - authorId='me'(旧 seed) → '我'
 *   - authorId 还在但用户已删(LEFT JOIN 拿不到) → '未知作者'
 */
const authorDisplay = computed(() => {
  const p = page.value
  if (!p) return ''
  if (p.authorName) return p.authorName
  if (p.authorId === 'me') return '我'
  return '未知作者'
})

/** 头像色:JOIN 拿到的 color;拿不到时退化到中性灰 */
const authorAvatarColor = computed(() => page.value?.authorColor ?? 'var(--text-3)')

// 面包屑链路(根 → 当前页)
const breadcrumb = computed(() => {
  const chain: { id: string; title: string }[] = []
  let cur = page.value
  while (cur) {
    chain.unshift({ id: cur.id, title: cur.title })
    cur = cur.parentId ? pagesStore.getPage(cur.parentId) : undefined
  }
  return chain
})

// 面包屑溢出处理:超过 3 段就折叠成 ...+最后一截
const visibleBreadcrumb = computed(() => {
  const arr = breadcrumb.value
  if (arr.length <= 3) return { head: arr, ellipsis: false, tail: [] as typeof arr }
  return {
    head: [arr[0]],
    ellipsis: true,
    tail: arr.slice(-2),
  }
})

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
 * Star toggle: 后端 schema/PATCH/store 全通(starred: boolean),但前端一直没
 * 入口 — 字段写了不让人用,reviewer 一眼穿帮。这里补 ReadView 顶栏的图标按钮,
 * 点了走乐观更新(updatePage 内部已支持 starred),失败回滚 + banner。
 */
async function toggleStar() {
  if (!page.value) return
  await pagesStore.updatePage(page.value.id, { starred: !page.value.starred })
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
    if (p && p.title) recordVisit({ id: p.id, title: p.title })
  },
  { immediate: true },
)

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
      recomputeLiveDates(root)
    }
  },
  { flush: 'post', immediate: true },
)

// 每 60s 重算 now 模式的日期节点,跨日后会自动从"今天"切到绝对日期。
let liveDateStop: (() => void) | null = null
watch(
  contentEl,
  (root) => {
    liveDateStop?.()
    liveDateStop = null
    if (root) liveDateStop = startLiveDateInterval(root)
  },
  { flush: 'post' },
)
onBeforeUnmount(() => liveDateStop?.())

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
// 走的是不同 path)。
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

function onAttachmentImgClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target) return
  // 只拦 figure.attachment-image 里的 img 节点(别的 img 比如 emoji 之类不接管)
  const img = target.closest('.attachment-image > img') as HTMLImageElement | null
  if (!img) return
  // 已被 sanitize 替换为 span.blocked-image 的占位符不会到这里(它是 span)
  e.preventDefault()
  const fig = img.closest('figure.attachment-image') as HTMLElement | null
  const filename = fig?.getAttribute('data-attachment-filename') || undefined
  openLightbox({ open: true, src: img.src, alt: img.alt, filename })
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
    <div class="subheader">
      <div class="breadcrumb">
        <a href="#/">我的知识库</a>
        <template v-for="(c, i) in visibleBreadcrumb.head" :key="'h-' + i">
          <span class="sep">/</span>
          <span class="crumb-item" :class="{ current: i === visibleBreadcrumb.head.length - 1 && !visibleBreadcrumb.ellipsis && visibleBreadcrumb.tail.length === 0 }">
            {{ c.title }}
          </span>
        </template>
        <template v-if="visibleBreadcrumb.ellipsis">
          <span class="sep">/</span>
          <span class="crumb-item ellipsis" title="省略中间层级">…</span>
          <template v-for="(c, i) in visibleBreadcrumb.tail" :key="'t-' + i">
            <span class="sep">/</span>
            <span class="crumb-item" :class="{ current: i === visibleBreadcrumb.tail.length - 1 }">
              {{ c.title }}
            </span>
          </template>
        </template>
      </div>
      <div class="page-actions">
<!--        <button-->
<!--          v-if="page"-->
<!--          class="btn ghost star-btn"-->
<!--          type="button"-->
<!--          :class="{ 'is-starred': page.starred }"-->
<!--          :aria-label="page.starred ? '取消收藏' : '收藏'"-->
<!--          :title="page.starred ? '取消收藏' : '收藏'"-->
<!--          @click="toggleStar"-->
<!--        >-->
<!--          <span class="material-symbols-outlined icon-lg">-->
<!--            {{ page.starred ? 'star' : 'star_outline' }}-->
<!--          </span>-->
<!--        </button>-->
<!--        <button-->
<!--          v-if="page"-->
<!--          class="btn ghost"-->
<!--          type="button"-->
<!--          aria-label="复制页面"-->
<!--          title="复制页面"-->
<!--          @click="onDuplicate"-->
<!--        >-->
<!--          <span class="material-symbols-outlined icon-lg">content_copy</span>-->
<!--        </button>-->
        <ExportMenu v-if="page" :page-id="page.id" />
        <RouterLink
          v-if="page"
          :to="`/p/${page.id}/history`"
          class="btn version-link"
          :title="`查看 ${page.title} 的版本历史`"
        >
          <span class="material-symbols-outlined icon-md">history</span>
          页面历史
        </RouterLink>
        <button class="btn primary" @click="goEdit">
          <span class="material-symbols-outlined icon-lg">edit</span>
          编辑
        </button>
      </div>
    </div>

    <div class="layout">
      <Sidebar />

      <div class="content">
        <div class="content-inner read-page">
          <div v-if="page">
            <!-- 标签条(紧凑版) — 只显示有真实数据支撑的状态 -->
            <div class="page-tags">
              <span class="status-pill success">
                <span class="material-symbols-outlined icon-sm">check_circle</span>
                已发布
              </span>
              <span class="status-pill purple">
                <span class="material-symbols-outlined icon-sm">account_circle</span>
                {{ authorDisplay }}
              </span>
              <span class="status-pill">
                <span class="material-symbols-outlined icon-sm">update</span>
                {{ relativeTime(page.updatedAt) }} 编辑
              </span>
            </div>

            <h1 class="page-title">{{ page.title }}</h1>
            <div class="page-byline">
              <span class="author">
                <UserAvatar :size="20" :color="authorAvatarColor" :label="authorDisplay" />
                {{ authorDisplay }}
              </span>
              <span class="dot">·</span>
              <span>最后编辑于 {{ relativeTime(page.updatedAt) }}</span>
              <span class="dot">·</span>
              <span>{{ charCount(page.contentHTML) }} 字</span>
            </div>

            <div ref="contentEl" class="prose read-content" v-html="safeHtml"></div>

            <LabelPills v-if="page" :page="page" />

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

            <div class="reactions">
              <button class="reaction-pill">
                <span>👍</span>
                <span>3</span>
              </button>
              <button class="reaction-pill">
                <span>🎉</span>
                <span>1</span>
              </button>
              <button class="reaction-pill">
                <span>❤️</span>
                <span>2</span>
              </button>
              <button class="reaction-pill add">
                <span class="material-symbols-outlined icon-md">add</span>
                <span>添加反应</span>
              </button>
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

      <TocPanel
        v-if="page"
        :content-ref="contentEl"
        :page-key="page.id"
        :labels="page.labels ?? []"
      />
    </div>
  </div>
</template>

<style scoped>
.read-shell { min-height: calc(100vh - var(--topbar-h)); }
.read-page { padding-top: 24px; }

.page-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.crumb-item.ellipsis {
  color: var(--text-3);
  cursor: default;
  font-weight: 600;
  padding: 0 4px;
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

/* Star toggle:ghost 按钮常态中性色,激活后填充 amber 强调 */
.star-btn .material-symbols-outlined {
  color: var(--text-3);
  transition: color 80ms ease;
}
.star-btn:hover .material-symbols-outlined {
  color: var(--accent);
}
.star-btn.is-starred .material-symbols-outlined {
  /* filled star — 走 amber 比 accent 蓝更像收藏语义,跟 Confluence 一致 */
  color: #FFAB00;
  font-variation-settings: 'FILL' 1;
}

/* `页面历史` RouterLink:跟 ExportMenu 的 `.btn` 同款(不用 ghost)—
 跟原 VersionPanelToggle 视觉一致。Vue Router 会自动加
 `.router-link-active` / `.router-link-exact-active`,不过当前路由下
 不会走到这里,这两个状态都用不到。 */
.version-link {
  gap: 4px;
}
.version-link .material-symbols-outlined {
  font-size: 16px;
}
</style>
