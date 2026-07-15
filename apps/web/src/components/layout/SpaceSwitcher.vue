<script setup lang="ts">
/**
 * SpaceSwitcher — lives in the topbar, right after the brand mark.
 *
 * Layout reference: design/wiki-read.html — the topbar trigger renders just
 * the active space name + an expand_more caret. No avatar, no page count in
 * the trigger — those only show inside the dropdown for each candidate.
 *
 * Personal spaces are intentionally hidden from this dropdown — the active
 * space may still be the user's personal space (showing its name in the
 * trigger is fine), but the only way to *enter* a personal space is via
 * the sidebar's "我的空间" entry. Switching within the dropdown stays
 * scoped to team spaces, which keeps the mental model clean: switcher
 * = team context, sidebar = personal space.
 *
 * Behaviour:
 *   - Zero team spaces → trigger renders as an empty-state chip with admin
 *     CTA (links to /manager/spaces); the button itself isn't shown.
 *   - One team space AND active is that team space → trigger renders as a
 *     plain label (no caret, click is a no-op) — nowhere meaningful to go.
 *   - One team space AND active is personal → trigger shows the
 *     "选择团队空间" placeholder + caret; click opens the dropdown so the
 *     user can enter the team space.
 *   - Multiple team spaces → caret + dropdown listing every team space
 *     visible to the user, with avatar / name / active check.
 *
 * Picking a space:
 *   1. setActiveSpace(id) — flips the activeSpaceId store value (persisted).
 *   2. pagesStore.ensureRootsLoaded(id) — space-scoped lazy root fetch for
 *      the new space. (Previously `pagesStore.refresh()` re-fetched roots
 *      for ALL visible spaces — Admin would've re-pulled every personal
 *      space too. ensureRootsLoaded is scoped to the target space.)
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
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'

const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const authStore = useAuthStore()
const router = useRouter()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

// Personal spaces are intentionally filtered out — see the file-level doc.
// The trigger still reflects whatever the active space is, which may itself
// be the user's personal space; only the dropdown list is restricted.
const spacesList = computed(() => spacesStore.sharedSpaces.value)
const active = computed(() => spacesStore.activeSpace.value)
const activeId = computed(() => spacesStore.activeSpaceId.value)

// True when clicking the trigger should actually open the dropdown.
//   - 0 team spaces → nothing to switch to (trigger renders as a no-op)
//   - 1 team space AND active is that team space → no other option to pick
//   - All other cases → open menu (lets the user enter a team space from
//     a personal-space active state, or pick a different team space)
const canOpen = computed(
  () =>
    spacesList.value.length > 0 &&
    !(spacesList.value.length === 1 && isActiveShared.value),
)

const isActiveShared = computed(() => active.value?.kind === 'shared')

function toggle() {
  if (!canOpen.value) return
  open.value = !open.value
}

async function pick(id: string) {
  if (id === activeId.value) {
    open.value = false
    return
  }
  spacesStore.setActiveSpace(id)
  open.value = false
  void pagesStore.ensureRootsLoaded(id)
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
      :class="{
        'ss-trigger-clickable': canOpen,
        'ss-trigger-neutral': !isActiveShared,
      }"
      @click="toggle"
    >
      <SpaceAvatar :space="active" :size="28" :show-name="true" />
      <span
        v-if="canOpen"
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

    <div v-if="open && spacesList.length > 0" class="ss-menu" role="listbox">
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
        <SpaceAvatar :space="s" :size="28" />
        <span class="ss-menu-text">
          <span class="ss-menu-name">{{ s.name }}</span>
          <span v-if="s.description" class="ss-menu-desc">{{ s.description }}</span>
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
.ss-trigger :deep(.sa-name) {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
}
.ss-trigger-clickable { cursor: pointer; }
.ss-trigger-clickable:hover { background: var(--bg-subtle); }

/* Neutral state: the active space is the user's personal space — softer
 * text color signals "private / not a team" without hiding the identity.
 * The SpaceAvatar block stays fully colored (still recognizably a space),
 * only the name next to it dims. */
.ss-trigger-neutral :deep(.sa-name) { color: var(--text-3); }
.ss-trigger-neutral:hover :deep(.sa-name) { color: var(--text-1); }
.ss-trigger-neutral .ss-caret { color: var(--text-3); }

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

.ss-menu-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-menu-item-active .ss-menu-name { color: var(--accent); }

/* 下拉项文字区:名字一行 + 描述一行,描述小一号、字色浅 3。 */
.ss-menu-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ss-menu-desc {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.ss-check {
  font-size: var(--icon-lg, 18px) !important;
  color: var(--accent);
}
</style>
