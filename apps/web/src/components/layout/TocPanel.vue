<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue'

const props = defineProps<{
  contentRef: HTMLElement | null
  /** 当页面切换时,vue 会复用 contentRef 同一个 DOM 节点,必须传一个外部 trigger 来强制重收集 */
  pageKey?: string | number
}>()

type TocItem = { id: string; text: string; level: 1 | 2 | 3 }
const items = ref<TocItem[]>([])
const activeId = ref<string>('')
const manualId = ref<string | null>(null)
let observer: IntersectionObserver | null = null

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

function readHeading(el: HTMLElement, idx: number): TocItem | null {
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
  const text = (el.textContent || '').trim()
  if (!text) return null
  if (!el.id) {
    el.id = `${tag}-${idx}-${text.replace(/\s+/g, '-').slice(0, 30)}`
  }
  return { id: el.id, text, level: lv }
}

function collectHeadings() {
  const root = props.contentRef
  if (!root) {
    items.value = []
    return
  }
  const nodes = getHeadingNodes(root)
  const result: TocItem[] = []
  nodes.forEach((n, idx) => {
    const item = readHeading(n, idx)
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
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
        :class="[`level-${item.level}`, { active: activeId === item.id }]"
        :title="item.text"
        type="button"
        @click="scrollTo(item.id)"
      >
        {{ item.text }}
      </button>
    </div>

    <div class="toc-followers">
      <div class="toc-title">页面关注者</div>
      <div class="av-stack">
        <div class="av" style="background:#FF5630" title="我">ME</div>
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
</style>
