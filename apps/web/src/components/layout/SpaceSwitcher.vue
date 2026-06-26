<script setup lang="ts">
/**
 * SpaceSwitcher — top of the sidebar.
 *
 *   - Shows the current active space (icon + name + page count).
 *   - Click opens a dropdown listing all visible spaces.
 *   - Picking a space calls `setActiveSpace` and triggers a page-tree reload
 *     so the sidebar reflects the new scope.
 *
 * Behaviour:
 *   - Single space → static chip, no dropdown trigger (no useful action).
 *   - Zero spaces → empty-state hint pointing to /manager (admins only).
 *
 * The page count is computed from `pages.value` filtered by space — this is
 * the only place we cross-reference the two stores on render.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { useAuthStore } from '@/stores/auth'

const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const authStore = useAuthStore()
const router = useRouter()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

// `spacesStore.spaces` and `spacesStore.activeSpace` are ComputedRefs. Unwrap
// here so the template can use them as plain values.
const spacesList = computed(() => spacesStore.spaces.value)
const active = computed(() => spacesStore.activeSpace.value)
const activeId = computed(() => spacesStore.activeSpaceId.value)

const pageCountBySpace = computed(() => {
  const map = new Map<string, number>()
  for (const p of pagesStore.pages) {
    map.set(p.spaceId, (map.get(p.spaceId) ?? 0) + 1)
  }
  return map
})

const activePageCount = computed(() =>
  active.value ? pageCountBySpace.value.get(active.value.id) ?? 0 : 0,
)

function toggle() {
  if (spacesList.value.length <= 1) return
  open.value = !open.value
}

function pick(id: string) {
  if (id === activeId.value) {
    open.value = false
    return
  }
  spacesStore.setActiveSpace(id)
  open.value = false
  // Re-fetch the page tree scoped to the new space — server already filters
  // by accessibility, but the local list may still hold pages from the previous
  // space. Simplest: refresh, which triggers the API again.
  void pagesStore.refresh()
}

function goManager() {
  open.value = false
  void router.push('/manager/spaces')
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="ss-root">
    <button
      v-if="active"
      type="button"
      class="ss-trigger"
      :class="{ 'ss-trigger-clickable': spacesList.length > 1 }"
      :title="spacesList.length > 1 ? '切换空间' : undefined"
      @click="toggle"
    >
      <span
        class="ss-avatar"
        :style="{ background: active.color }"
        aria-hidden="true"
      >
        <span v-if="active.icon" class="material-symbols-outlined ss-icon">{{ active.icon }}</span>
        <span v-else class="ss-initials">{{ active.name.slice(0, 2) }}</span>
      </span>
      <span class="ss-info">
        <span class="ss-name">{{ active.name }}</span>
        <span class="ss-meta">{{ activePageCount }} 个页面</span>
      </span>
      <span
        v-if="spacesList.length > 1"
        class="material-symbols-outlined ss-caret"
      >unfold_more</span>
    </button>

    <div v-else class="ss-empty">
      <span class="material-symbols-outlined ss-empty-icon">folder_off</span>
      <span class="ss-empty-text">还没有可访问的空间</span>
      <button
        v-if="authStore.isAdmin"
        type="button"
        class="ss-empty-cta"
        @click="goManager"
      >
        去管理后台创建
      </button>
    </div>

    <div v-if="open && spacesList.length > 1" class="ss-menu" role="listbox">
      <button
        v-for="s in spacesList"
        :key="s.id"
        type="button"
        class="ss-menu-item"
        :class="{ 'ss-menu-item-active': s.id === active?.id }"
        role="option"
        :aria-selected="s.id === active?.id"
        @click="pick(s.id)"
      >
        <span
          class="ss-avatar ss-avatar-sm"
          :style="{ background: s.color }"
          aria-hidden="true"
        >
          <span v-if="s.icon" class="material-symbols-outlined ss-icon-sm">{{ s.icon }}</span>
          <span v-else class="ss-initials-sm">{{ s.name.slice(0, 2) }}</span>
        </span>
        <span class="ss-menu-info">
          <span class="ss-menu-name">{{ s.name }}</span>
          <span class="ss-menu-meta">{{ pageCountBySpace.get(s.id) ?? 0 }} 个页面</span>
        </span>
        <span
          v-if="s.id === active?.id"
          class="material-symbols-outlined ss-check"
          aria-hidden="true"
        >check</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ss-root {
  position: relative;
  margin-bottom: 16px;
}

/* ─── Trigger chip ─── */
.ss-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 8px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-md, 4px);
  font-family: inherit;
  text-align: left;
  cursor: default;
  color: inherit;
  transition: background var(--duration-fast, 120ms) var(--ease-out, ease);
}
.ss-trigger-clickable { cursor: pointer; }
.ss-trigger-clickable:hover { background: var(--bg-subtle, #F4F5F7); }

.ss-avatar {
  width: 36px;
  height: 36px;
  border-radius: var(--radius, 3px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
}
.ss-avatar-sm { width: 28px; height: 28px; font-size: 11px; border-radius: var(--radius, 3px); }

.ss-icon { font-size: 20px !important; }
.ss-icon-sm { font-size: 16px !important; }

.ss-initials,
.ss-initials-sm {
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.ss-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ss-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1, #172B4D);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-meta {
  font-size: 12px;
  color: var(--text-3, #6B778C);
  line-height: 1.2;
}
.ss-caret {
  font-size: 18px !important;
  color: var(--text-3, #6B778C);
}

/* ─── Empty state ─── */
.ss-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px;
  text-align: center;
  color: var(--text-3, #6B778C);
  font-size: 13px;
}
.ss-empty-icon {
  font-size: 28px !important;
  color: var(--text-3, #6B778C);
}
.ss-empty-cta {
  margin-top: 4px;
  padding: 4px 10px;
  background: var(--accent-soft, #DEEBFF);
  color: var(--accent, #0052CC);
  border: 0;
  border-radius: var(--radius, 3px);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.ss-empty-cta:hover { background: var(--accent, #0052CC); color: white; }

/* ─── Dropdown ─── */
.ss-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  background: var(--bg, #FFFFFF);
  border: 1px solid var(--border, #DFE1E6);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-lg, 0 8px 16px -4px rgba(9, 30, 66, 0.16), 0 0 1px rgba(9, 30, 66, 0.16));
  padding: 4px;
  z-index: 50;
  max-height: 360px;
  overflow-y: auto;
}

.ss-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  background: transparent;
  border: 0;
  border-radius: var(--radius, 3px);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  color: inherit;
}
.ss-menu-item:hover { background: var(--bg-subtle, #F4F5F7); }
.ss-menu-item-active { background: var(--accent-soft, #DEEBFF); }
.ss-menu-item-active:hover { background: var(--accent-soft, #DEEBFF); }

.ss-menu-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ss-menu-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1, #172B4D);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-menu-item-active .ss-menu-name { color: var(--accent, #0052CC); }
.ss-menu-meta {
  font-size: 11px;
  color: var(--text-3, #6B778C);
}
.ss-check {
  font-size: 18px !important;
  color: var(--accent, #0052CC);
}
</style>
