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

function collectHeadings() {
  const root = props.contentRef
  if (!root) {
    items.value = []
    return
  }
  // 收集 h1/h2/h3。 注意:ReadView 的 .page-title 是个独立 h1,不在 .read-content 内,
  // 这里只走 props.contentRef(就是 .read-content),所以不会把 page title 算进目录。
  const headings = root.querySelectorAll('h1, h2, h3')
  items.value = Array.from(headings).map((h, idx) => {
    if (!h.id) {
      const tag = h.tagName.toLowerCase()
      h.id = `${tag}-${idx}-${(h.textContent || '').replace(/\s+/g, '-').slice(0, 30)}`
    }
    const lv = Number(h.tagName.substring(1)) as 1 | 2 | 3
    return { id: h.id, text: h.textContent || '', level: lv }
  })
  activeId.value = ''
  manualId.value = null
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
  root.querySelectorAll('h1, h2, h3').forEach((h) => observer!.observe(h))
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
})

onUnmounted(() => {
  observer?.disconnect()
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
