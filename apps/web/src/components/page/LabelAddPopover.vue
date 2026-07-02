<script setup lang="ts">
/**
 * LabelAddPopover — Stage 8 label autocomplete popover.
 *
 * Anchored to the `+` chip click position. Input field + result list fed
 * by `api.labels.search(q)` with a 200ms input debounce. Cache by lowercased
 * q to avoid spamming the API as the user types.
 *
 * Keyboard: Enter adds the first match (or the typed value if no match),
 * Esc closes, click-out closes.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '@/lib/api'

const props = defineProps<{
  anchor: { x: number; y: number }
}>()
const emit = defineEmits<{
  pick: [label: string]
  close: []
}>()

const query = ref('')
const suggestions = ref<string[]>([])
const loading = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
let debounceTimer: number | null = null

const MENU_W = 280
const SAFE = 8

const menuStyle = computed(() => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0
  let left = props.anchor.x + 8
  let top = props.anchor.y + 4
  if (left + MENU_W + SAFE > vw) left = Math.max(SAFE, vw - MENU_W - SAFE)
  if (top > vh - 240) top = Math.max(SAFE, vh - 240)
  return { top: `${top}px`, left: `${left}px` }
})

watch(query, (q) => {
  if (debounceTimer) window.clearTimeout(debounceTimer)
  const trimmed = q.trim().toLowerCase()
  if (!trimmed) {
    suggestions.value = []
    loading.value = false
    return
  }
  loading.value = true
  debounceTimer = window.setTimeout(async () => {
    try {
      const results = await api.labels.search(trimmed, 8)
      suggestions.value = results
    } catch {
      suggestions.value = []
    } finally {
      loading.value = false
    }
  }, 200)
})

onMounted(async () => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  await Promise.resolve()
  inputEl.value?.focus()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
  if (debounceTimer) window.clearTimeout(debounceTimer)
})

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  } else if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}

function submit() {
  const v = query.value.trim().toLowerCase()
  if (!v) return
  emit('pick', v)
}

function pick(label: string) {
  emit('pick', label)
}
</script>

<template>
  <div ref="rootEl" class="lap-root" :style="menuStyle" @click.stop>
    <input
      ref="inputEl"
      v-model="query"
      class="lap-input"
      type="text"
      placeholder="添加标签…"
      maxlength="32"
      autocomplete="off"
      spellcheck="false"
      @keydown.stop
    />
    <div v-if="loading" class="lap-hint">搜索中…</div>
    <div v-else-if="query.trim() && suggestions.length === 0" class="lap-hint">
      无匹配 — 按 Enter 创建「{{ query.trim().toLowerCase() }}」
    </div>
    <ul v-else-if="suggestions.length > 0" class="lap-list">
      <li v-for="s in suggestions" :key="s">
        <button class="lap-item" type="button" @click="pick(s)">
          <span class="material-symbols-outlined icon-xs">label</span>
          {{ s }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lap-root {
  position: fixed;
  z-index: 250;
  width: 280px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(9, 30, 66, 0.2));
  padding: 8px;
}
.lap-input {
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: inherit;
  background: var(--bg);
  color: var(--text-1);
  box-sizing: border-box;
}
.lap-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 82, 204, 0.2);
}
.lap-hint {
  margin-top: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}
.lap-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
}
.lap-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-1);
  text-align: left;
  font-family: inherit;
}
.lap-item:hover {
  background: var(--bg-subtle);
}
.lap-item .material-symbols-outlined {
  color: var(--text-3);
}
</style>