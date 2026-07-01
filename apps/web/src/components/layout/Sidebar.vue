<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { newId } from '@/lib/id'
import PageTree from './PageTree.vue'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const authStore = useAuthStore()
const uiStore = useUiStore()
const router = useRouter()

// Tree is scoped to the active space. Server already filters by accessibility
// but the local store holds pages from every accessible space — scoping the
// render keeps the sidebar clean.
const tree = computed(() => pagesStore.getTreeForSpace(spacesStore.activeSpaceId.value))

const totalPages = computed(() => pagesStore.pages.length)

// Active-space quick-nav. Mirrors the topbar's SpaceSwitcher trigger but
// stays inside the sidebar so users get a "where am I" anchor that scrolls
// with the page. Replaces the old always-personal-space entry that was
// confusing when the active space was a shared space — the sidebar now
// always reflects the active space, full stop.
const active = computed(() => spacesStore.activeSpace.value)
const isActivePersonal = computed(() => active.value?.kind === 'personal')
const activePageCount = computed(() => {
  const id = active.value?.id
  if (!id) return 0
  return pagesStore.pages.filter((p) => p.spaceId === id).length
})

// Personal-space shortcut: separate from the active-space chip so users have
// a one-click path back to their drafts when they're working in a shared
// space. Rendered as a small bottom-anchor link — not a primary nav item.
const personalSpace = computed(() => spacesStore.personalSpace.value)
const showMySpaceShortcut = computed(
  () => personalSpace.value && active.value && !isActivePersonal.value,
)

async function createRoot() {
  uiStore.closeMenu()
  // Stage B.3: same client-side nanoid pattern as EditView. URL jumps
  // immediately to /p/<id>/edit before the server round-trip
  // completes — no blank flash waiting for the create to return.
  const clientId = newId()
  router.push(`/p/${clientId}/edit`)
  try {
    await pagesStore.createPage({ id: clientId, parentId: null })
  } catch {
    // store already shows the error banner; user can retry or close the editor
  }
}

function goHome() {
  // Active space's home — the `/` route renders HomeView for whatever
  // activeSpaceId is set. Clicking the chip while already on '/' is a no-op.
  void router.push('/')
}

function goMySpace() {
  // Prefer the canonical URL so /me shows up in the address bar and the
  // browser history — refreshing /me re-runs the redirect, which is what
  // we want when the personal space id changes (e.g. user renamed).
  void router.push('/me')
}

// `authStore` is referenced only to keep the reactivity alive for `user`
// (avoids HMR-side-effect warnings if we ever inline-reference it). The
// topbar already surfaces this via the user menu's "我的空间" item, but the
// sidebar shortcut is a frequent-use target — easier to reach than the
// avatar dropdown for users who context-switch often.
void authStore
</script>

<template>
  <aside class="sidebar">
    <div class="quick-nav">
      <!-- Active-space chip: always reflects the currently active space (any
           kind) so the sidebar's identity matches the topbar. The chip is
           itself a "home" button — clicking it returns to the active space's
           home view. Old behavior rendered the personal space here regardless
           of the active space, which was confusing when working in a team
           space. -->
      <button
        v-if="active"
        type="button"
        class="quick-nav-item quick-nav-active"
        :title="`回到 ${active.name} 首页`"
        @click="goHome"
      >
        <span class="active-avatar" :style="{ background: active.color }" aria-hidden="true">
          <span class="material-symbols-outlined">{{ active.icon || (isActivePersonal ? 'cottage' : 'workspaces') }}</span>
        </span>
        <span class="active-name">{{ active.name }}</span>
        <span class="active-count">{{ activePageCount }}</span>
      </button>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-title">
        <span>
          <span class="material-symbols-outlined section-icon">layers</span>
          此空间的页面
        </span>
        <span class="count">{{ tree.length }}</span>
      </div>
      <div v-if="tree.length === 0" class="tree-empty">
        <div class="tree-empty-icon">
          <span class="material-symbols-outlined" style="font-size:24px">inbox</span>
        </div>
        <div class="tree-empty-text">还没有页面</div>
        <button class="tree-empty-cta" @click="createRoot">
          <span class="material-symbols-outlined icon-sm">add</span>
          创建第一个
        </button>
      </div>
      <div v-else class="tree">
        <PageTree
          v-for="root in tree"
          :key="root.id"
          :node="root"
        />
      </div>
    </div>



    <div class="sidebar-bottom">
      <button class="create-page-btn" @click="createRoot">
        <span class="material-symbols-outlined icon-lg">add</span>
        创建页面
        <kbd>/</kbd>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.quick-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 20px;
}
.quick-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 14px;
  text-decoration: none;
  transition: all var(--duration-fast);
  position: relative;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  width: 100%;
}
.quick-nav-item:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
  text-decoration: none;
}
.quick-nav-item .material-symbols-outlined {
  font-size: 18px;
  color: var(--text-3);
}
.quick-nav-item:hover .material-symbols-outlined { color: var(--text-1); }

/* Active-space chip: a small colored avatar chip replaces the plain icon
 * so users can spot the current space at a glance. Mirrors the topbar
 * SpaceSwitcher's avatar treatment for visual consistency. The chip is
 * always the active space (any kind), so it doesn't need an "active" state
 * — it's always in that state. */
.quick-nav-active {
  padding: 0 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.quick-nav-active .material-symbols-outlined { color: var(--accent); }
.active-avatar {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm, 3px);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: white;
}
.active-avatar .material-symbols-outlined {
  font-size: 14px !important;
  color: white;
}
.active-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.active-count {
  font-size: 11px;
  color: var(--accent);
  background: rgba(255, 255, 255, 0.6);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
}

/* "我的空间" anchor: a quiet bottom-of-section shortcut back to the user's
 * personal space when the active space is something else. Rendered as a
 * small inline button so it doesn't compete with the active-space chip
 * above or the create-page button at the very bottom. */
.sidebar-myspace-anchor {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.msa-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  border-radius: var(--radius);
  color: var(--text-3);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.msa-btn:hover { background: var(--bg-subtle); color: var(--text-1); }
.msa-icon { font-size: 16px !important; color: var(--text-3); flex-shrink: 0; }
.msa-btn:hover .msa-icon { color: var(--text-1); }
.msa-label { font-weight: 500; }
.msa-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.section-icon {
  font-size: 14px !important;
  color: var(--text-3);
  vertical-align: -2px;
  margin-right: 4px;
}

.sidebar-section-title .count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}

.tree-empty {
  padding: 16px 4px 4px;
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
}
.tree-empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--bg-subtle);
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 10px;
}
.tree-empty-text {
  color: var(--text-3);
  font-size: 13px;
  margin-bottom: 10px;
}
.tree-empty-cta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
}
.tree-empty-cta:hover {
  background: var(--accent);
  color: white;
}

.create-page-btn {
  position: relative;
  font-weight: 500;
}
.create-page-btn kbd {
  margin-left: auto;
  background: var(--bg-subtle);
  color: var(--text-3);
  border-color: transparent;
}
.create-page-btn:hover kbd {
  background: var(--bg);
  color: var(--text-2);
}
</style>
