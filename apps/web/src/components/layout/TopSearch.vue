<script setup lang="ts">
/**
 * TopSearch — 过滤型搜索下拉(顶栏 Cmd/Ctrl+K 唤起)。
 *
 * 三个过滤维度(全部 optional,AND 组合):
 *   - q      → 标题子串
 *   - space  → 空间 id(默认 sidebar 当前空间;× 切到"全部空间")
 *   - label  → 精确匹配(已规范化 lowercase)
 *
 * 后端:`GET /api/search?q=&space=&label=&limit=`,见 apps/api/src/routes/search.ts。
 * 这里不再做前端 `filter()`,所有结果来自后端。
 *
 * 三种模式:
 *   - browse (无 q + 无 label + 无 space) → 走 `pagesStore.pages` 的最近页(零 API)
 *   - search (任意维度非空)              → 调 `/api/search`,debounce 300ms
 *   - loading                            → 显示 Skeleton
 *
 * Race-safe:`searchSeq` 计数器 + 每次请求自增,响应回来时 seq 不匹配就丢弃
 * (防止晚到的旧请求覆盖新结果)。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { api, ApiError } from '@/lib/api'
import { debounce } from '@/lib/debounce'
import Skeleton from '@/components/ui/Skeleton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import type { PageNode } from '@power-wiki/shared'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const router = useRouter()

const query = ref('')
const activeIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)

// ── 过滤维度状态(chip 控)─────────────────────────────────────────────
// null = "全部空间"。打开时从 sidebar 的 activeSpaceId 取初值。
const filterSpaceId = ref<string | null>(null)
const filterLabel = ref<string | null>(null)

// Popover open state
const spacePickerOpen = ref(false)
const labelPickerOpen = ref(false)

// Label autocomplete 输入 + 建议
const labelInput = ref('')
const labelSuggestions = ref<string[]>([])

// ── 搜索结果状态 ──────────────────────────────────────────────────────
// null = 走 store 的最近页(无 q/label/space 触发的兜底)
// array = 后端响应(可能是空数组)
const searchResults = ref<PageNode[] | null>(null)
const searching = ref(false)
/** 搜索失败时的 inline error — modal 内的反馈,不走 banner。
 *  用户在 modal 内搜索,banner 会抢 chrome 视觉资源、阻塞 modal;
 *  按 `docs/loading-ux.md` 第 17 节「反馈通道规约」,modal 内错误用 inline。 */
const inlineError = ref<string | null>(null)
let searchSeq = 0
let labelSeq = 0

interface Result {
  page: PageNode
  path: string
}

/**
 * 面包屑路径:从当前页向上回溯到 root。复用 store 的 getPage(id) 保证
 * 跨页响应后再渲染时也能取到(只要 pagesStore 加载过)。已在原实现验证。
 */
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

// 仅在 pagesStore 还没初始化时显示初始 Skeleton(进入时)。搜索自己的
// loading 用 searching 标志位,见下面 results 处的分支。
const showInitialSkeleton = computed(
  () => pagesStore.loading || (!pagesStore.loaded && pagesStore.pages.length === 0),
)

// 当前结果列表。优先级:searchResults 覆盖 browse 模式。
const isSearchMode = computed(
  () => query.value.trim().length > 0 || filterLabel.value !== null || filterSpaceId.value !== null,
)

const results = computed<Result[]>(() => {
  // searchResults 优先(用户已经触发了 search 调用)
  if (searchResults.value !== null) {
    return searchResults.value
      .slice(0, 20)
      .map((p) => ({ page: p, path: pathOf(p.id) }))
  }
  // browse 模式:store 里的最近页
  return pagesStore.pages
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20)
    .map((p) => ({ page: p, path: pathOf(p.id) }))
})

watch(results, () => {
  activeIndex.value = 0
})

// 当前 active 空间名(chip label 用)
const activeSpaceName = computed(() => {
  const id = filterSpaceId.value
  if (!id) return null
  return spacesStore.spaces.value.find((s) => s.id === id)?.name ?? null
})

// ── 搜索执行 ──────────────────────────────────────────────────────────
async function runSearch() {
  const q = query.value.trim()
  const spaceId = filterSpaceId.value
  const label = filterLabel.value

  // 三维全空 → 走 browse 模式(store 最近页),不发请求
  if (!q && !label && !spaceId) {
    searchResults.value = null
    inlineError.value = null
    return
  }
  const seq = ++searchSeq
  searching.value = true
  try {
    const res = await api.search.query({
      q: q || undefined,
      spaceId: spaceId ?? undefined,
      label: label ?? undefined,
      limit: 20,
    })
    if (seq !== searchSeq) return
    searchResults.value = res.items
    inlineError.value = null
  } catch (e) {
    if (seq !== searchSeq) return
    // modal 内 inline error(不走 banner,banner 阻塞 modal)。
    inlineError.value = e instanceof ApiError ? e.message : '搜索失败'
    // 保留 searchResults = [] — 进 search-mode 但无结果是正常形态,
    // empty state 会自然显示「没有匹配 'xxx' 的页面」。
    searchResults.value = []
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}

const debouncedRunSearch = debounce(runSearch, 300)

/** 重试 — 跟 inlineError 同区域的按钮触发;用户改 q / chip 也会自动清错。 */
function retrySearch() {
  inlineError.value = null
  void runSearch()
}

/** 「没结果」空态的标题(三种 sub-text 在此集中翻译)。 */
const emptySearchTitle = computed(() => {
  if (filterLabel.value && !query.value.trim()) {
    return `没有标签为「${filterLabel.value}」的页面`
  }
  return `没有匹配 "${query.value.trim() || '…'}" 的页面`
})

// query 变化走防抖(打字场景);chip 变化立即重跑(点击场景,不需要 debounce)
// 改动同时清掉 stale inlineError — 用户开始搜新的,旧错误就过时了。
watch(query, () => {
  inlineError.value = null
  debouncedRunSearch()
})
watch([filterSpaceId, filterLabel], () => {
  inlineError.value = null
  runSearch()
})

// ── 打开 / 关闭生命周期 ───────────────────────────────────────────────
watch(
  () => props.open,
  async (val) => {
    if (val) {
      query.value = ''
      activeIndex.value = 0
      filterSpaceId.value = spacesStore.activeSpaceId.value ?? null
      filterLabel.value = null
      labelInput.value = ''
      spacePickerOpen.value = false
      labelPickerOpen.value = false
      searchResults.value = null
      inlineError.value = null
      searchSeq++ // invalidate any in-flight from before close
      if (!pagesStore.loaded && !pagesStore.loading) {
        void pagesStore.init()
      }
      await nextTick()
      inputEl.value?.focus()
    }
  },
)

// ── 标签 autocomplete ─────────────────────────────────────────────────
const debouncedLabelSuggest = debounce(async () => {
  const seq = ++labelSeq
  const q = labelInput.value.trim()
  if (!q) {
    labelSuggestions.value = []
    return
  }
  try {
    const list = await api.labels.search(q, 8)
    if (seq === labelSeq) labelSuggestions.value = list
  } catch {
    if (seq === labelSeq) labelSuggestions.value = []
  }
}, 150)
watch(labelInput, () => debouncedLabelSuggest())

function selectLabel(l: string) {
  filterLabel.value = l.toLowerCase()
  labelInput.value = ''
  labelSuggestions.value = []
  labelPickerOpen.value = false
}

function commitLabelInput() {
  const v = labelInput.value.trim()
  if (!v) return
  // 不在 suggestions 里也允许 commit —— 用户可能记得某个标签但 autocomplete
  // 没匹配上;后端 EXISTS 会照常过滤,只是没结果而已。
  selectLabel(v)
}

function clearLabel() {
  filterLabel.value = null
  labelInput.value = ''
  labelSuggestions.value = []
  labelPickerOpen.value = false
}

// ── 空间 picker ───────────────────────────────────────────────────────
function toggleSpacePicker() {
  spacePickerOpen.value = !spacePickerOpen.value
  if (spacePickerOpen.value) labelPickerOpen.value = false
}

function setSpace(id: string | null) {
  filterSpaceId.value = id
  spacePickerOpen.value = false
}

function clearSpace() {
  filterSpaceId.value = null
  spacePickerOpen.value = false
}

// ── 键盘导航(主搜索框) ───────────────────────────────────────────────
function navigate(p: PageNode) {
  emit('close')
  router.push(`/p/${p.id}`)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (labelPickerOpen.value || spacePickerOpen.value) {
      labelPickerOpen.value = false
      spacePickerOpen.value = false
      return
    }
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

function onLabelInputKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    commitLabelInput()
  } else if (e.key === 'Escape') {
    e.stopPropagation()
    labelPickerOpen.value = false
    labelInput.value = ''
    labelSuggestions.value = []
  }
}

function onBackdrop() {
  emit('close')
}

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
  },
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
            placeholder="搜索页面…"
            @keydown="onKey"
          />
          <kbd class="ts-esc">Esc</kbd>
        </div>

        <!-- Filter chips -->
        <div class="ts-chips">
          <!-- Space chip -->
          <div
            class="ts-chip-pill"
            :class="{ 'ts-chip-pill-active': filterSpaceId !== null }"
          >
            <button
              type="button"
              class="ts-chip"
              :title="filterSpaceId ? '切换空间' : '切换到当前 sidebar 空间'"
              @click="toggleSpacePicker"
            >
              <span class="material-symbols-outlined ts-chip-icon">workspaces</span>
              <span class="ts-chip-label">
                <template v-if="filterSpaceId">在 {{ activeSpaceName }} 内</template>
                <template v-else>全部空间</template>
              </span>
              <span class="material-symbols-outlined ts-chip-caret">arrow_drop_down</span>
            </button>
            <button
              v-if="filterSpaceId !== null"
              type="button"
              class="ts-chip-x"
              title="清除空间过滤"
              @click.stop="clearSpace"
            >
              <span class="material-symbols-outlined ts-chip-x-icon">close</span>
            </button>
            <div v-if="spacePickerOpen" class="ts-popover" @click.stop>
              <button
                type="button"
                class="ts-popover-item"
                :class="{ 'ts-popover-item-active': filterSpaceId === null }"
                @click="setSpace(null)"
              >
                <span class="material-symbols-outlined">public</span>
                <span>全部空间</span>
              </button>
              <div v-if="spacesStore.spaces.value.length === 0" class="ts-popover-empty">
                还没有可见空间
              </div>
              <button
                v-for="s in spacesStore.spaces.value"
                :key="s.id"
                type="button"
                class="ts-popover-item"
                :class="{ 'ts-popover-item-active': filterSpaceId === s.id }"
                @click="setSpace(s.id)"
              >
                <span
                  class="ts-popover-dot"
                  :style="{ background: s.color }"
                  aria-hidden="true"
                />
                <span>{{ s.name }}</span>
                <span v-if="s.kind === 'personal'" class="ts-popover-tag">个人</span>
              </button>
            </div>
          </div>

          <!-- Label chip -->
          <div
            class="ts-chip-pill"
            :class="{ 'ts-chip-pill-add': !filterLabel, 'ts-chip-pill-active': filterLabel !== null }"
          >
            <button
              v-if="!filterLabel"
              type="button"
              class="ts-chip ts-chip-add"
              @click="labelPickerOpen = !labelPickerOpen; if (labelPickerOpen) spacePickerOpen = false"
            >
              <span class="material-symbols-outlined ts-chip-icon">label</span>
              <span class="ts-chip-label">按标签筛选</span>
            </button>
            <button
              v-else
              type="button"
              class="ts-chip"
              @click="labelPickerOpen = !labelPickerOpen; if (labelPickerOpen) spacePickerOpen = false"
            >
              <span class="material-symbols-outlined ts-chip-icon">label</span>
              <span class="ts-chip-label">标签: {{ filterLabel }}</span>
              <span class="material-symbols-outlined ts-chip-caret">arrow_drop_down</span>
            </button>
            <button
              v-if="filterLabel"
              type="button"
              class="ts-chip-x"
              title="清除标签过滤"
              @click.stop="clearLabel"
            >
              <span class="material-symbols-outlined ts-chip-x-icon">close</span>
            </button>
            <div v-if="labelPickerOpen" class="ts-popover" @click.stop>
              <div class="ts-label-input-row">
                <span class="material-symbols-outlined">search</span>
                <input
                  v-model="labelInput"
                  class="ts-label-input"
                  type="text"
                  placeholder="搜索或新建标签…"
                  autofocus
                  @keydown="onLabelInputKey"
                />
              </div>
              <div v-if="labelSuggestions.length > 0" class="ts-suggest-list">
                <button
                  v-for="s in labelSuggestions"
                  :key="s"
                  type="button"
                  class="ts-popover-item"
                  @click="selectLabel(s)"
                >
                  <span class="material-symbols-outlined">label</span>
                  <span>{{ s }}</span>
                </button>
              </div>
              <button
                v-else-if="labelInput.trim()"
                type="button"
                class="ts-popover-item"
                @click="commitLabelInput"
              >
                <span class="material-symbols-outlined">add</span>
                <span>过滤 "{{ labelInput.trim().toLowerCase() }}"</span>
              </button>
              <div v-else class="ts-popover-hint">
                <span class="material-symbols-outlined">tips_and_updates</span>
                <span>输入标签名按 <kbd>Enter</kbd>,或点建议</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Results -->
        <div v-if="showInitialSkeleton" class="ts-skeleton">
          <Skeleton :count="6" height="36px" radius="var(--radius-md)" />
        </div>
        <div v-else-if="searching && results.length === 0" class="ts-skeleton">
          <Skeleton :count="4" height="36px" radius="var(--radius-md)" />
        </div>
        <div v-else-if="inlineError" class="ts-error" role="alert">
          <span class="material-symbols-outlined">error</span>
          <div class="ts-error-text">
            <strong>搜索失败</strong>
            <span>{{ inlineError }}</span>
          </div>
          <button type="button" class="ts-error-retry" @click="retrySearch">重试</button>
        </div>
        <div v-else-if="results.length === 0">
          <EmptyState
            v-if="isSearchMode"
            variant="no-results"
            icon="search_off"
            :title="emptySearchTitle"
            hint="试试改一下关键词或清除过滤"
          />
          <EmptyState
            v-else
            variant="no-data"
            icon="inbox"
            title="还没有页面"
            hint="先到某个空间里写一篇吧"
          />
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
            <span
              v-if="filterSpaceId === null && activeSpaceName"
              class="ts-item-space"
              :title="activeSpaceName"
            >{{ activeSpaceName }}</span>
            <span class="material-symbols-outlined ts-item-go">arrow_forward</span>
          </button>
        </div>

        <div class="ts-footer">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
          <span class="ts-count">
            <template v-if="isSearchMode">搜索结果</template>
            <template v-else>共 {{ pagesStore.pages.length }} 个页面</template>
          </span>
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
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 140px);
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: visible; /* popovers need to escape */
  position: relative;
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

/* ── Filter chips ──────────────────────────────────────── */
.ts-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
}
/* Pill = chip button + optional × button, visually one rounded unit.
 * Outer wrapper owns the border/background so the inner buttons don't carry
 * their own borders (which is what made the previous version look like two
 * separate buttons glued together). No `overflow: hidden` here — the popover
 * is a child of this wrapper and needs to escape at `top: 100%`; clipping
 * would hide it entirely. The inner buttons carry matching border-radius
 * (12px, one less than the pill's 13px to sit just inside the curve) so the
 * visible shape is still one rounded pill. */
.ts-chip-pill {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--bg);
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.ts-chip-pill:hover { border-color: var(--border-strong); }
.ts-chip-pill-add { border-style: dashed; }
.ts-chip-pill-add:hover {
  border-style: solid;
  border-color: var(--accent);
}
.ts-chip-pill-active {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.ts-chip-pill-active:hover { border-color: var(--accent); }
.ts-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 6px 0 10px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-top-left-radius: 12px;
  border-bottom-left-radius: 12px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out);
}
/* When there's no × button (the "add" state), the chip button takes the
 * full pill width and needs to round both sides. */
.ts-chip-pill:not(:has(.ts-chip-x)) .ts-chip {
  border-top-right-radius: 12px;
  border-bottom-right-radius: 12px;
}
.ts-chip-add { color: var(--text-3); }
.ts-chip-add:hover { color: var(--text-2); }
.ts-chip-pill-active .ts-chip { color: var(--accent); }
.ts-chip-icon {
  font-size: 14px !important;
  color: inherit;
}
.ts-chip-label {
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ts-chip-caret {
  font-size: 16px !important;
  color: inherit;
  opacity: 0.7;
  margin-left: -2px;
}
.ts-chip-x {
  width: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-left: 1px solid var(--border);
  border-top-right-radius: 12px;
  border-bottom-right-radius: 12px;
  cursor: pointer;
  color: var(--text-3);
  padding: 0;
  transition: color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.ts-chip-x-icon {
  font-size: 16px !important;
  /* Material Symbols has its own internal padding; nudge it down 1px so the
   * glyph sits on the geometric center of the button (which is 26×26 now,
   * visually centered with the 26px chip body height). */
  line-height: 1;
  display: block;
}
.ts-chip-x:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.ts-chip-pill-active .ts-chip-x {
  border-left-color: var(--accent);
  color: var(--accent);
}
.ts-chip-pill-active .ts-chip-x:hover {
  color: var(--danger);
  background: var(--danger-soft);
  border-left-color: var(--danger);
}

/* ── Popover ─────────────────────────────────────────── */
.ts-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 10;
  padding: 4px;
}
/* Tiny visual caret pointing up to the chip — a single 8px diamond
 * made with two borders, positioned just above the popover so the user
 * can see "this menu belongs to that chip". The left offset is hand-
 * tuned for the chip text length; works well enough for short labels. */
.ts-popover::before {
  content: '';
  position: absolute;
  top: -6px;
  left: 16px;
  width: 10px;
  height: 10px;
  background: var(--bg);
  border-left: 1px solid var(--border);
  border-top: 1px solid var(--border);
  transform: rotate(45deg);
}
.ts-popover-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-1);
  text-align: left;
}
.ts-popover-item:hover { background: var(--bg-canvas); }
.ts-popover-item-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.ts-popover-item .material-symbols-outlined {
  font-size: 16px;
  color: var(--text-3);
}
.ts-popover-item-active .material-symbols-outlined { color: var(--accent); }
.ts-popover-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ts-popover-tag {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-canvas);
  color: var(--text-3);
}
.ts-popover-empty {
  padding: 16px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
.ts-popover-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 12px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
.ts-popover-hint .material-symbols-outlined {
  font-size: 16px;
  color: var(--text-3);
  opacity: 0.8;
  flex-shrink: 0;
}
.ts-popover-hint kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-2);
  margin: 0 2px;
}

/* ── Label input inside popover ──────────────────────── */
.ts-label-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  margin: -4px -4px 4px;
  padding-left: 12px;
  padding-right: 12px;
  background: var(--bg-subtle);
}
.ts-label-input-row .material-symbols-outlined {
  font-size: 16px;
  color: var(--text-3);
}
.ts-label-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-1);
  background: transparent;
}
.ts-label-input::placeholder { color: var(--text-3); }
.ts-suggest-list { padding: 2px 0; }

/* ── Results list ────────────────────────────────────── */
.ts-list {
  overflow-y: auto;
  padding: 6px;
  max-height: 400px;
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
.ts-item.active .ts-item-title { color: var(--accent); }
.ts-item-path {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-item-space {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-canvas);
  padding: 2px 6px;
  border-radius: 8px;
  max-width: 100px;
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

/* .ts-empty 整体迁到 EmptyState,这里删掉内联样式 */

.ts-skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
}

/* Inline error — modal 内搜索失败的反馈通道,不走 banner。
 * 视觉对齐 EmptyState 同族(token / radius / padding),红底 + icon +
 * 双行文字(标题 / 详情)+ 浅蓝重试按钮。 */
.ts-error {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  margin: 10px;
  background: var(--danger-soft);
  border-radius: var(--radius-md);
}
.ts-error > .material-symbols-outlined {
  font-size: 24px;
  color: var(--danger);
  flex-shrink: 0;
}
.ts-error-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ts-error-text strong {
  font-size: 13px;
  color: var(--text-1);
  font-weight: 600;
}
.ts-error-text span {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-error-retry {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--accent);
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  cursor: pointer;
}
.ts-error-retry:hover { background: var(--accent-soft); }

.ts-footer {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 9px 16px;
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
