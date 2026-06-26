<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import type { PageNode } from '@power-wiki/shared'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const pagesStore = usePagesStore()
const router = useRouter()

const query = ref('')
const activeIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)

interface Result {
  page: PageNode
  path: string
}

// 为每个 page 算出 root → 当前 的面包屑链路标题,搜索时一起展示,
// 比单看 title 更能区分同名/层级上下文。
function pathOf(id: string | null): string {
  if (!id) return ''
  const titles: string[] = []
  let cur: PageNode | undefined = pagesStore.getPage(id)
  let guard = 0
  while (cur && guard++ < 32) {
    titles.unshift(cur.title)
    cur = cur.parentId ? pagesStore.getPage(cur.parentId) : undefined
  }
  return titles.join(' / ')
}

const results = computed<Result[]>(() => {
  const q = query.value.trim().toLowerCase()
  const all = pagesStore.pages
  const list = q
    ? all.filter((p) => p.title.toLowerCase().includes(q))
    : all.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  return list.slice(0, 20).map((p) => ({ page: p, path: pathOf(p.id) }))
})

watch(results, () => {
  activeIndex.value = 0
})

watch(
  () => props.open,
  async (val) => {
    if (val) {
      query.value = ''
      activeIndex.value = 0
      await nextTick()
      inputEl.value?.focus()
    }
  }
)

function navigate(p: PageNode) {
  emit('close')
  router.push(`/p/${p.id}`)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (results.value.length === 0) return
    activeIndex.value = (activeIndex.value + 1) % results.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (results.value.length === 0) return
    activeIndex.value =
      (activeIndex.value - 1 + results.value.length) % results.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const r = results.value[activeIndex.value]
    if (r) navigate(r.page)
  }
}

function onBackdrop() {
  emit('close')
}

// 全局 keyup 监听:open=false 时不占资源
function onGlobalKey(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

watch(
  () => props.open,
  (val) => {
    if (val) document.addEventListener('keydown', onGlobalKey)
    else document.removeEventListener('keydown', onGlobalKey)
  }
)

onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <transition name="search-fade">
    <div v-if="open" class="top-search-backdrop" @mousedown.self="onBackdrop">
      <div class="top-search" role="dialog" aria-label="全局搜索">
        <div class="ts-input-row">
          <span class="material-symbols-outlined ts-icon">search</span>
          <input
            ref="inputEl"
            v-model="query"
            class="ts-input"
            type="text"
            placeholder="搜索所有页面…"
            @keydown="onKey"
          />
          <kbd class="ts-esc">Esc</kbd>
        </div>

        <div v-if="results.length === 0" class="ts-empty">
          <span class="material-symbols-outlined">search_off</span>
          <div>没有匹配 "{{ query }}" 的页面</div>
        </div>
        <div v-else class="ts-list" role="listbox">
          <button
            v-for="(r, idx) in results"
            :key="r.page.id"
            class="ts-item"
            :class="{ active: idx === activeIndex }"
            role="option"
            :aria-selected="idx === activeIndex"
            @mousedown.prevent="navigate(r.page)"
            @mousemove="activeIndex = idx"
          >
            <span class="material-symbols-outlined ts-item-icon">description</span>
            <div class="ts-item-text">
              <div class="ts-item-title">{{ r.page.title }}</div>
              <div v-if="r.path !== r.page.title" class="ts-item-path">{{ r.path }}</div>
            </div>
            <span class="material-symbols-outlined ts-item-go">arrow_forward</span>
          </button>
        </div>

        <div class="ts-footer">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
          <span class="ts-count">共 {{ pagesStore.pages.length }} 个页面</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.top-search-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim-1);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 96px;
  z-index: 900;
}
.top-search {
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 140px);
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ts-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.ts-icon { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
.ts-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 15px;
  font-family: inherit;
  color: var(--text-1);
  background: transparent;
}
.ts-input::placeholder { color: var(--text-3); }
.ts-esc {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-3);
}

.ts-list {
  overflow-y: auto;
  padding: 6px;
}
.ts-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.ts-item.active { background: var(--accent-soft); }
.ts-item-icon {
  font-size: 18px;
  color: var(--text-3);
  flex-shrink: 0;
}
.ts-item.active .ts-item-icon { color: var(--accent); }
.ts-item-text { flex: 1; min-width: 0; }
.ts-item-title {
  font-size: 14px;
  color: var(--text-1);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-item-path {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-item-go {
  font-size: 16px;
  color: var(--text-3);
  opacity: 0;
  flex-shrink: 0;
}
.ts-item.active .ts-item-go { opacity: 1; color: var(--accent); }

.ts-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
.ts-empty .material-symbols-outlined {
  font-size: 32px;
  margin-bottom: 8px;
  display: block;
}

.ts-footer {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-sidebar);
  font-size: 11px;
  color: var(--text-3);
}
.ts-footer kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-2);
  margin-right: 4px;
}
.ts-count { margin-left: auto; }

.search-fade-enter-active, .search-fade-leave-active {
  transition: opacity var(--duration-fast) ease;
}
.search-fade-enter-from, .search-fade-leave-to { opacity: 0; }
.search-fade-enter-active .top-search,
.search-fade-leave-active .top-search {
  transition: transform var(--duration-fast) ease;
}
.search-fade-enter-from .top-search { transform: translateY(-8px); }
</style>


