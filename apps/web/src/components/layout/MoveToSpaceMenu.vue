<script setup lang="ts">
/**
 * MoveToSpaceMenu — popover for relocating a page (typically a personal-space
 * draft) to a different space. Triggered from the PageTree ⋯ menu's
 * "移动到..." item. Filters the user's accessible space list to team
 * spaces (kind !== 'personal') and excludes the source space — there's no
 * point in "moving" a page to the space it's already in.
 *
 * The backend's PATCH /:id/move rejects newParentId != null when
 * newSpaceId is present, so this component only handles the "promote to
 * root of destination" case (not "place under another page in a different
 * space", which would be a more complex tree-merge operation).
 *
 * After a successful move, we close the menu + close the PageTree's
 * own context menu, then jump to the moved page so the user immediately
 * sees the new context. If the move target is the current user's personal
 * space, we don't jump — but the UI only lists team spaces, so this is
 * moot; the assertion is here for clarity.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { useUiStore } from '@/stores/ui'
import type { PageNode, Space } from '@power-wiki/shared'

const props = defineProps<{
  page: PageNode
  /** Anchor coords for the popover (matches the trigger click position). */
  anchor: { x: number; y: number }
}>()

const emit = defineEmits<{ close: [] }>()

const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const uiStore = useUiStore()
const router = useRouter()

const rootEl = ref<HTMLElement | null>(null)

/**
 * Available destinations: team spaces visible to the user, minus the
 * page's current space. We list only `kind !== 'personal'` because the
 * personal-space entry is meant for the owner only — moving another
 * user's page into your personal space would silently disappear (they
 * can't access it). The destination order follows the natural sidebar
 * order (created-at asc, matching /api/spaces list ordering).
 */
const destinations = computed<Space[]>(() =>
  spacesStore.spaces.value.filter(
    (s) => s.kind !== 'personal' && s.id !== props.page.spaceId,
  ),
)

const currentSpaceName = computed(
  () =>
    spacesStore.spaces.value.find((s) => s.id === props.page.spaceId)?.name ?? '当前空间',
)

const menuStyle = computed(() => {
  // Mirror PageTree's edge-clipping strategy — these popovers are
  // position:fixed and small enough that 280px wide / variable height
  // is the safe upper bound.
  const MENU_W = 280
  const SAFE = 8
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0
  let left = props.anchor.x + 8
  let top = props.anchor.y + 4
  if (left + MENU_W + SAFE > vw) left = Math.max(SAFE, vw - MENU_W - SAFE)
  // For height we don't know precisely — clamp top so the menu never
  // starts below the viewport.
  if (top > vh - 80) top = Math.max(SAFE, vh - 80)
  return { top: `${top}px`, left: `${left}px` }
})

async function pick(targetSpaceId: string) {
  emit('close')
  uiStore.closeMenu()
  try {
    await pagesStore.movePageToSpace(props.page.id, targetSpaceId)
    // Jump to the moved page in its new space so the user immediately
    // sees the result. The active-space switch is local — server-side
    // it's just a PATCH on the page row.
    const target = spacesStore.spaces.value.find((s) => s.id === targetSpaceId)
    if (target) spacesStore.setActiveSpace(target.id)
    await router.push(`/p/${props.page.id}`)
  } catch {
    // banner shown by store
  }
}

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
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
  <div ref="rootEl" class="m2s-root" :style="menuStyle" @click.stop>
    <div class="m2s-header">
      <span class="m2s-title">移动到其他空间</span>
      <span class="m2s-sub">{{ currentSpaceName }} → ...</span>
    </div>
    <div v-if="destinations.length === 0" class="m2s-empty">
      <div class="m2s-empty-icon">
        <span class="material-symbols-outlined" style="font-size:20px">travel_explore</span>
      </div>
      <div class="m2s-empty-text">
        没有可用的团队空间
      </div>
      <div class="m2s-empty-hint">
        请联系管理员把你加入某个团队空间
      </div>
    </div>
    <button
      v-for="s in destinations"
      :key="s.id"
      type="button"
      class="m2s-item"
      @click="pick(s.id)"
    >
      <span class="m2s-avatar" :style="{ background: s.color }" aria-hidden="true">
        <span v-if="s.icon" class="material-symbols-outlined m2s-avatar-icon">{{ s.icon }}</span>
        <span v-else class="m2s-initials">{{ s.name.slice(0, 2) }}</span>
      </span>
      <span class="m2s-info">
        <span class="m2s-name">{{ s.name }}</span>
        <span v-if="s.description" class="m2s-desc">{{ s.description }}</span>
      </span>
      <span class="material-symbols-outlined m2s-chev" aria-hidden="true">chevron_right</span>
    </button>
  </div>
</template>

<style scoped>
.m2s-root {
  position: fixed;
  z-index: 250;
  width: 280px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(9, 30, 66, 0.2));
  padding: 4px;
  max-height: 360px;
  overflow-y: auto;
}

.m2s-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.m2s-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.m2s-sub {
  font-size: 11px;
  color: var(--text-3);
}

.m2s-item {
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
.m2s-item:hover { background: var(--bg-subtle); }

.m2s-avatar {
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
.m2s-avatar-icon { font-size: 16px !important; }
.m2s-initials {
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.m2s-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.m2s-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m2s-desc {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m2s-chev {
  font-size: 16px !important;
  color: var(--text-3);
}

.m2s-empty {
  padding: 20px 16px;
  text-align: center;
  color: var(--text-3);
}
.m2s-empty-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--bg-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 8px;
  color: var(--text-3);
}
.m2s-empty-text {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 2px;
}
.m2s-empty-hint {
  font-size: 11px;
  color: var(--text-3);
}
</style>