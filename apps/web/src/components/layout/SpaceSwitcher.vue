<script setup lang="ts">
/**
 * SpaceSwitcher — lives in the topbar, right after the brand mark.
 *
 * Layout reference: design/wiki-read.html — the topbar trigger renders just
 * the active space name + an expand_more caret. No avatar, no page count in
 * the trigger — those only show inside the dropdown for each candidate.
 *
 * Behaviour:
 *   - Single visible space → trigger renders but click is a no-op.
 *   - Multiple spaces → click opens a 320px dropdown listing every space
 *     visible to the user, with avatar / name / page count per row.
 *   - Zero spaces → empty state with admin CTA (links to /manager/spaces).
 *
 * Picking a space:
 *   1. setActiveSpace(id) — flips the activeSpaceId store value (persisted).
 *   2. pagesStore.refresh() — re-fetches the page tree scoped to the new
 *      space; server already filters by accessibility, but the local list
 *      may still hold pages from the previous space.
 *   3. router.push('/') — always jump to the new space's home, even if the
 *      user was already there. This guarantees we never strand the user on
 *      a stale page that doesn't exist in the new space (e.g. reading /p/X
 *      in space A → switch to space B → X is gone, would 404).
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

function toggle() {
  if (spacesList.value.length <= 1) return
  open.value = !open.value
}

async function pick(id: string) {
  if (id === activeId.value) {
    open.value = false
    return
  }
  spacesStore.setActiveSpace(id)
  open.value = false
  void pagesStore.refresh()
  // 总是跳到新空间的首页 — 否则用户可能停留在旧空间的某个页面(在新空间里
  // 不存在 → 404)。已在首页时 router.push('/') 是 no-op,reactive 计算
  // 会用新 activeSpaceId 自动重渲染。
  if (router.currentRoute.value.path !== '/') {
    void router.push('/')
  }
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
      <span class="ss-name">{{ active.name }}</span>
      <span
        v-if="spacesList.length > 1"
        class="material-symbols-outlined ss-caret"
      >expand_more</span>
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
          class="ss-avatar"
          :style="{ background: s.color }"
          aria-hidden="true"
        >
          <span v-if="s.icon" class="material-symbols-outlined ss-avatar-icon">{{ s.icon }}</span>
          <span v-else class="ss-initials">{{ s.name.slice(0, 2) }}</span>
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
  display: flex;
  align-items: center;
}

/* ─── Trigger chip ─── */
.ss-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-md, 4px);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  cursor: default;
  transition: background var(--duration-fast, 120ms) var(--ease-out, ease);
}
.ss-trigger-clickable { cursor: pointer; }
.ss-trigger-clickable:hover { background: var(--bg-subtle); }

.ss-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1;
}

.ss-caret {
  font-size: var(--icon-lg, 18px) !important;
  color: var(--text-3);
  line-height: 1;
}

/* ─── Empty state ─── */
.ss-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  font-size: 13px;
  color: var(--text-3);
  height: 32px;
}
.ss-empty-icon {
  font-size: var(--icon-xl, 20px) !important;
  color: var(--text-3);
}
.ss-empty-cta {
  padding: 2px 8px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 0;
  border-radius: var(--radius-sm, 3px);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.ss-empty-cta:hover { background: var(--accent); color: white; }

/* ─── Dropdown ─── */
.ss-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  width: 320px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(9, 30, 66, 0.2));
  padding: 4px;
  z-index: 200;
  max-height: 480px;
  overflow-y: auto;
}

.ss-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  color: inherit;
}
.ss-menu-item:hover { background: var(--bg-subtle); }
.ss-menu-item-active { background: var(--accent-soft); }
.ss-menu-item-active:hover { background: var(--accent-soft); }

.ss-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm, 3px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 700;
  font-size: 12px;
  flex-shrink: 0;
}
.ss-avatar-icon { font-size: 16px !important; }
.ss-initials {
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

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
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-menu-item-active .ss-menu-name { color: var(--accent); }
.ss-menu-meta {
  font-size: 11px;
  color: var(--text-3);
}
.ss-check {
  font-size: var(--icon-lg, 18px) !important;
  color: var(--accent);
}
</style>
