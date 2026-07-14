<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import UserPopover from '@/components/ui/UserPopover.vue'
import { ensureHeadingId } from '@/lib/headingAnchors'
import type { Watcher } from '@power-wiki/shared'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()

const props = defineProps<{
  contentRef: HTMLElement | null
  /** 当页面切换时,vue 会复用 contentRef 同一个 DOM 节点,必须传一个外部 trigger 来强制重收集 */
  pageKey?: string | number
  /** Read-only:由父组件(ReadView / EditView)传入当前页面的 labels 数组。
   *  此处只展示不可编辑 —— 编辑能力在 EditView 底部的 `<LabelPills>`。 */
  labels?: string[]
}>()

/** 过滤空 + 去重,避免上游偶发塞入脏数据。 */
const safeLabels = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of props.labels ?? []) {
    if (typeof l !== 'string') continue
    const t = l.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
})
const hasLabels = computed(() => safeLabels.value.length > 0)

type TocItem = { id: string; text: string; level: 1 | 2 | 3 }
const items = ref<TocItem[]>([])
const activeId = ref<string>('')
const manualId = ref<string | null>(null)
let observer: IntersectionObserver | null = null

/** 当前路由的 hash(去掉前导 #),用于高亮"刚点过 / 刚刷新定位到"的 heading。
 * ReadView / EditView 都用同套 heading-id 格式(h- 前缀,见 headingAnchors.ts)。
 * 优先级:route.hash 命中(用户刚点 / 刚刷新定位)> IntersectionObserver
 * 看到的(用户主动滚动)。前者先压,后等到用户滚动后自然接管。 */
const currentHashId = computed(() => {
  const h = route.hash
  return h && h.startsWith('#') ? h.slice(1) : ''
})

/**
 * 收集 heading 节点。
 *
 * ReadView 里是普通 h1/h2/h3。
 * EditView 里 Tiptap 的 HeadingView 是 .heading-wrapper[data-level="N"] > .heading-content,
 * wrapper 自身带 data-heading-id(详见 HeadingView.vue)。两种形态都得收。
 *
 * 之所以不能"只让 EditView 用一种格式"——Tiptap 改 heading level 时 NodeView 复用
 * 同一个 DOM 节点,改 as 才不会卡死;这个统一性由 HeadingView 决定,TocPanel 只能兼容。
 */
function getHeadingNodes(root: HTMLElement): HTMLElement[] {
  const collected: HTMLElement[] = []
  // 1. 普通 h1/h2/h3 — 出现在 ReadView
  root.querySelectorAll('h1, h2, h3').forEach((h) => collected.push(h as HTMLElement))
  // 2. 编辑器里的 .heading-wrapper[data-level]
  root.querySelectorAll('.heading-wrapper[data-level]').forEach((h) => {
    // 同节点不可能同时被上面和这里匹配(.heading-wrapper 不是 h1/h2/h3 标签),
    // 但万一以后真撞了,跳过重复
    if (!collected.includes(h as HTMLElement)) collected.push(h as HTMLElement)
  })
  return collected
}

function readHeading(el: HTMLElement, usedIds: Set<string>): TocItem | null {
  // 编辑器节点:.heading-wrapper[data-level][data-heading-id]
  if (el.classList.contains('heading-wrapper')) {
    const lv = Number(el.getAttribute('data-level') ?? '0') as 1 | 2 | 3
    if (lv !== 1 && lv !== 2 && lv !== 3) return null
    // 文本取 .heading-content,避免把外层 anchor '#' 算进去
    const content = el.querySelector('.heading-content') as HTMLElement | null
    const text = (content?.textContent || el.textContent || '').trim()
    if (!text) return null
    // 编辑器自己已经挂好 data-heading-id(唯一 slug + pos 后缀),直接用
    const id = el.getAttribute('data-heading-id') || el.id
    if (!id) return null
    if (!el.id) el.id = id
    return { id, text, level: lv }
  }
  // 普通 h1/h2/h3(ReadView v-html 渲染后由 headingAnchors.ts 注入 id)
  const tag = el.tagName.toLowerCase()
  const lv = Number(tag.substring(1)) as 1 | 2 | 3
  // headingAnchors.ts 在每个 h2/h3 前面注入了 <a class="heading-anchor">#</a>
  // 链接,它的 textContent 是 "#"。直接读 `el.textContent` 会把 "#" 带进
  // TOC 的标题里。ReadView 自己也是 clone + remove anchor 之后才读
  // (见 ReadView.vue:152),TOC 这边照做。
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('a.heading-anchor').forEach((a) => a.remove())
  const text = (clone.textContent || '').trim()
  if (!text) return null
  // 用与 headingAnchors 完全相同的 ensureHeadingId 生成 / 读取 id ——
  // 保证无论 collectHeadings 与 addHeadingAnchors 谁先跑,元素落到的 id
  // 都一致。否则两套算法产出不同形态的 id(h-<slug> vs h-<tag>-<idx>-…),
  // 复制到地址栏的深链在新窗口打开时会因 id 对不上而定位失败。
  const id = ensureHeadingId(el, usedIds)
  return { id, text, level: lv }
}

function collectHeadings() {
  const root = props.contentRef
  if (!root) {
    items.value = []
    return
  }
  const nodes = getHeadingNodes(root)
  // 与 headingAnchors.addHeadingAnchors 共享同一套 id 生成算法:每次收集
  // 用一个全新的 usedIds set,按 DOM 顺序喂给 ensureHeadingId,产出的 id
  // 与 ReadView 注入的完全一致(dedup 的 -2 后缀也一致)。
  const usedIds = new Set<string>()
  const result: TocItem[] = []
  nodes.forEach((n) => {
    const item = readHeading(n, usedIds)
    if (item) result.push(item)
  })
  items.value = result
  activeId.value = ''
  manualId.value = null
}

// MutationObserver 监听 contentRef 内部 heading 增删:用户在编辑器里打
// 字加新 heading / 删 heading,TOC 必须跟得上。每次 contenteditable
// input 都触发会太频繁 — 用 rAF 合并到下一帧。
let mutationObs: MutationObserver | null = null
let mutationRaf: number | null = null

function setupMutationObserver() {
  if (mutationObs) mutationObs.disconnect()
  mutationObs = null
  if (mutationRaf) {
    cancelAnimationFrame(mutationRaf)
    mutationRaf = null
  }
  const root = props.contentRef
  if (!root) return
  mutationObs = new MutationObserver(() => {
    if (mutationRaf != null) return
    mutationRaf = requestAnimationFrame(() => {
      mutationRaf = null
      // 重收集 headings 并重建 IntersectionObserver
      // (新加的 heading 不会自动被 observe)
      collectHeadings()
      setupObserver()
    })
  })
  mutationObs.observe(root, { childList: true, subtree: true, characterData: true })
}

function setupObserver() {
  if (observer) observer.disconnect()
  observer = null
  const root = props.contentRef
  if (!root) return
  observer = new IntersectionObserver(
    (entries) => {
      if (manualId.value) return
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible[0]) activeId.value = visible[0].target.id
    },
    {
      rootMargin: '-80px 0px -70% 0px',
      threshold: [0, 1],
    }
  )
  getHeadingNodes(root).forEach((h) => observer!.observe(h))
}

function scrollTo(id: string) {
  manualId.value = id
  activeId.value = id
  // router.replace → scrollBehavior 统一负责滚。
  // 不直接 scrollIntoView 是因为:ReadView 里 heading ids 由 v-html 渲染
  // 后 addHeadingAnchors 注入,replace 触发的 scrollBehavior 会用 Promise
  // 轮询直到元素出现(见 router/index.ts),保证 TOC 点击 / 刷新 / 直链
  // 共享同一段滚动逻辑,不会出现"点 TOC 滚了,但刷新后定位失败"的不一致。
  router.replace({ hash: '#' + id }).catch(() => {
    // 重复点击同一 hash / 同路由 navigation guard 中断 — 静默忽略
  })
  window.setTimeout(() => {
    manualId.value = null
  }, 2000)
}

onMounted(async () => {
  await nextTick()
  collectHeadings()
  setupObserver()
  setupMutationObserver()
})

onUnmounted(() => {
  observer?.disconnect()
  mutationObs?.disconnect()
  if (mutationRaf) cancelAnimationFrame(mutationRaf)
})

// 监听 pageKey 变化 — 这是页面切换的可靠 trigger
watch(
  () => props.pageKey,
  async () => {
    if (observer) observer.disconnect()
    // 等 v-html 完成渲染 + DOM 完成 commit
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    collectHeadings()
    setupObserver()
    setupMutationObserver()
  }
)

// 也监听 contentRef 变化(组件挂载到新 DOM 树)
watch(
  () => props.contentRef,
  async (newRef) => {
    if (!newRef) return
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    collectHeadings()
    setupObserver()
    setupMutationObserver()
  }
)

/* ─── M13 👁 关注者列表 ─────────────────────────────────────────────
 *
 * 数据来源:`GET /api/pages/:id/watchers?limit=5` —— 后端按 watched_at ASC
 * 取前 5 个 watcher + user LEFT JOIN。
 *
 * 显隐规则:
 *   - 0 个 watcher → 「+ 👁 关注此页」hinting link
 *   - ≤ 5 个         → 全部显示
 *   - > 5 个         → 前 5 个 + 「+N」溢出(不需要详情 modal,纯导航)
 *
 * watch pageKey 切换时重新拉;清空 prev state 避免 cross-page 闪显。
 */
const watchers = ref<Watcher[]>([])
const watchersLoading = ref(false)
const watchersTotal = ref(0)
const WATCHERS_LIMIT = 5
/**
 * 当前 hover 的 watcher id —— 驱动 UserPopover 的 v-if。
 * avatarRefs 收集每个头像 wrap 的 DOM 节点,UserPopover 据此定位。
 * 用户快速划过时 hoveredId 反复切换,各 UserPopover 独立 v-if 不会冲突。
 */
const hoveredId = ref<string | null>(null)
const avatarRefs = ref<Record<string, HTMLElement | null>>({})

async function loadWatchers() {
  const pageId = props.pageKey
  if (!pageId || typeof pageId !== 'string') {
    watchers.value = []
    watchersTotal.value = 0
    return
  }
  watchersLoading.value = true
  try {
    const r = await api.pages.watchers(pageId, {
      limit: WATCHERS_LIMIT,
      offset: 0,
    })
    watchers.value = r.items
    // 后端 hasMore=true 表示 offset+items 之后还有;总量用上限 + 1 估算。
    // 真实总量对右 TOC 不关键(只要显示「+N」溢出就行)。
    watchersTotal.value = r.hasMore ? r.items.length + 1 : r.items.length
  } catch {
    // 失败静默,UI 仍可渲染其他 section
    watchers.value = []
    watchersTotal.value = 0
  } finally {
    watchersLoading.value = false
  }
}

/** 当前页是否在个人空间 —— 个人空间无 watch 语义,右 TOC 不显示
 * 「页面关注者」section。 */
const isPersonalSpace = computed(() => {
  const pid = authStore.personalSpaceId
  if (!pid) return false
  const page = props.pageKey ? pagesStore.getPage(String(props.pageKey)) : null
  if (page?.spaceId === pid) return true
  return spacesStore.activeSpaceId.value === pid
})

/** 当前用户是否在该页的 watcher 列表里 —— 用于显示「我」徽章高亮。 */
const currentUserIsWatcher = computed(() =>
  watchers.value.some((w) => w.id === authStore.user?.id),
)

/** 「+N」溢出数字:估算 ≥ limit+1 时显示;后端 hasMore 用 limit 而非真实 count。 */
const overflowCount = computed(() => {
  if (watchersTotal.value <= WATCHERS_LIMIT) return 0
  return watchersTotal.value - WATCHERS_LIMIT
})

watch(
  () => props.pageKey,
  () => {
    watchers.value = []
    watchersTotal.value = 0
    void loadWatchers()
  },
  { immediate: true },
)

// watch toggle 后立即重拉 —— pagesStore.watchVersion 在 togglePageWatch
// 成功(或 cache-less fallback)路径末 +1,任何跨页面、跨用户的关注操作
// 都会触发这次 refetch。watchers list 是独立 cache,pageKey 不变就不
// 会自动重拉,需要这个 trigger。
watch(
  () => pagesStore.watchVersion,
  () => void loadWatchers(),
)
</script>

<template>
  <aside class="toc-panel">
    <div class="toc-title">本页目录</div>
    <div v-if="items.length === 0" class="toc-empty">没有目录</div>
    <div v-else class="toc-list">
      <button
        v-for="item in items"
        :key="item.id"
        class="toc-item"
        :class="[`level-${item.level}`, {
          active: activeId === item.id || currentHashId === item.id,
        }]"
        :title="item.text"
        type="button"
        @click="scrollTo(item.id)"
      >
        {{ item.text }}
      </button>
    </div>

    <!-- 标签只读展示:出现在「目录」和「关注者」之间 -->
    <div v-if="hasLabels" class="toc-labels">
      <div class="toc-title">页面标签</div>
      <div class="toc-labels-row">
        <span class="material-symbols-outlined toc-labels-icon" aria-hidden="true">sell</span>
        <span
          v-for="l in safeLabels"
          :key="l"
          class="toc-label-chip"
          :title="l"
        >{{ l }}</span>
      </div>
    </div>

    <div v-if="!isPersonalSpace" class="toc-followers">
      <div class="toc-title">
        <span class="material-symbols-outlined toc-followers-icon" aria-hidden="true">
          visibility
        </span>
        页面关注者
        <span v-if="watchersTotal > 0" class="toc-followers-count">{{ watchersTotal }}</span>
      </div>

      <!-- 0 个 watcher:叫用户也来关注(自己 watch 上不用算,但提示动作可见) -->
      <div v-if="watchersLoading" class="toc-followers-loading" aria-busy="true">加载中…</div>
      <div v-else-if="watchersTotal === 0" class="toc-followers-empty">
        还没有人关注此页
      </div>
      <div v-else class="toc-followers-stack">
        <span
          v-for="w in watchers"
          :key="w.id"
          :ref="(el) => { avatarRefs[w.id] = el as HTMLElement | null }"
          class="toc-follower-wrap"
          @mouseenter="hoveredId = w.id"
          @mouseleave="hoveredId = null"
        >
          <UserAvatar
            :size="20"
            :color="w.color ?? 'var(--text-3)'"
            :label="w.name ?? w.id"
            class="toc-follower-av"
            :class="{ 'is-me': w.id === authStore.user?.id }"
          />
          <UserPopover
            v-if="hoveredId === w.id"
            :name="w.name ?? w.id"
            :color="w.color ?? 'var(--text-3)'"
            :anchor="avatarRefs[w.id] ?? null"
          />
        </span>
        <span v-if="overflowCount > 0" class="toc-follower-overflow">+{{ overflowCount }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.toc-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 4px 0;
}

/* 标签只读块 —— 跟 wiki-read.html 风格一致:bg-subtle + text-2 +
 * 12px weight 600 + 2px 6px + 3px radius。EditView 底部 LabelPills
 * 仍是编辑入口,这里没有 edit affordance。 */
.toc-labels {
  margin-top: 24px;
}
.toc-labels-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.toc-labels-icon {
  font-size: 16px;
  color: var(--text-3);
  margin-right: 2px;
}
.toc-label-chip {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--bg-subtle);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── M13 关注者 section ────────────────────────────────────────── */
.toc-followers {
  margin-top: 24px;
}
.toc-followers-icon {
  font-size: 16px;
  color: var(--text-3);
  vertical-align: -2px;
  margin-right: 4px;
}
.toc-followers-count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}
.toc-followers-loading,
.toc-followers-empty {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.toc-followers-loading {
  font-style: italic;
}
.toc-followers-stack {
  display: inline-flex;
  align-items: center;
  margin-top: 6px;
}
/* wrap 包了头像,inline-flex 让水平负 margin 生效 + hover 区命中 */
.toc-follower-wrap {
  display: inline-flex;
  margin-left: -4px;
  position: relative;
}
.toc-follower-wrap:first-child {
  margin-left: 0;
}
.toc-follower-av {
  border: 1.5px solid var(--bg);
  border-radius: 50%;
}
.toc-follower-av.is-me {
  border-color: var(--accent);
  border-width: 1.5px;
}
.toc-follower-overflow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: -4px;
  border: 1.5px solid var(--bg);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  background: var(--bg-subtle);
  min-width: 20px;
  height: 20px;
  font-variant-numeric: tabular-nums;
}
</style>
