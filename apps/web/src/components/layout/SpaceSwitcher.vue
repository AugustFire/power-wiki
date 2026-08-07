<script setup lang="ts">
/**
 * SpaceSwitcher — lives in the topbar, right after the brand mark.
 *
 * Layout reference: design/wiki-read.html — the topbar trigger renders just
 * the active space name + an expand_more caret. No avatar, no page count in
 * the trigger — those only show inside the dropdown for each candidate.
 *
 * P1-7 refinement: personal space is a first-class entry in the dropdown
 * (sits at the top, above team spaces, with a divider). Previously personal
 * space was only reachable via the sidebar's "我的空间" anchor — that
 * proved too hidden for users who wanted to browse their private pages
 * the way they browse team spaces. Now Confluence/Notion parity: every
 * space the user has access to, in one dropdown.
 *
 * The trigger still reflects whatever the active space is, including
 * personal space (which renders with a lock_person badge in the chip).
 *
 * Behaviour:
 *   - Zero spaces (no personal + no team) → trigger renders as an
 *     empty-state chip; the button itself isn't shown.
 *   - One option AND active is that option → trigger renders as a
 *     disabled chip (灰显 + cursor not-allowed + 原生 title tooltip
 *     "You are in the only space you have access to")—— 没有任何其它
 *     空间可切,点也没用,直接告诉用户为什么不能点。
 *   - Multiple options → caret + dropdown listing personal space first
 *     (with "仅自己可见" desc), then team spaces, then archived (admin).
 *
 * Picking a space:
 *   1. setActiveSpace(id) — flips the activeSpaceId store value (persisted).
 *   2. pagesStore.ensureRootsLoaded(id) — space-scoped lazy root fetch for
 *      the new space.
 *   3. router.push('/') — always jump to the new space's home, even if the
 *      user was already there. This guarantees we never strand the user on
 *      a stale page that doesn't exist in the new space (e.g. reading /p/X
 *      in space A → switch to space B → X is gone, would 404).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'

const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const uiStore = useUiStore()
const authStore = useAuthStore()
const router = useRouter()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

// P1-7 (refinement): personal space is now an explicit dropdown entry —
// Confluence/Notion-style "your private space sits alongside team spaces".
// The trigger still reflects whatever the active space is; the dropdown
// shows personal first (with a divider), then team spaces.
// P1-1: archived spaces are filtered from the main list.
const spacesList = computed(() => spacesStore.sharedSpaces.value.filter((s) => !s.archivedAt))
const personalSpace = computed(() => spacesStore.personalSpace.value)
// P1-1: archived spaces shown in a separate section for admins only.
const archivedSpaces = computed(() => spacesStore.sharedSpaces.value.filter((s) => !!s.archivedAt))
const isAdmin = computed(() => authStore.user?.role === 'admin')
const active = computed(() => spacesStore.activeSpace.value)
const activeId = computed(() => spacesStore.activeSpaceId.value)

// True when clicking the trigger should actually open the dropdown.
//   - 0 spaces (no personal + no team) → nothing to switch to (trigger
//     renders as a no-op empty state).
//   - Only 1 option AND active is that option → no other option to pick.
//   - All other cases → open menu (lets the user enter a team space from
//     a personal-space active state, or pick a different team space, or
//     jump back to personal space from a team space).
const totalOptions = computed(() => (personalSpace.value ? 1 : 0) + spacesList.value.length)
const canOpen = computed(
  () =>
    totalOptions.value > 0 &&
    !(totalOptions.value === 1 && isActiveShared.value),
)

const isActiveShared = computed(() => active.value?.kind === 'shared')

function toggle() {
  if (!canOpen.value) return
  open.value = !open.value
}

async function pick(id: string) {
  // 不做 id === activeId 的 early-return:用户在 /manager/* 上选当前空间
  // 也应该跳回 / (否则感觉"点了没反应")。同值时 setActiveSpace 是浅等
  // no-op、ensureRootsLoaded 有 childrenLoaded 缓存幂等、router.push('/')
  // 又有 path 守卫 —— 全部安全。已在 / 时整套是 no-op,reactive 计算会用
  // 新 activeSpaceId 重渲染。
  spacesStore.setActiveSpace(id)
  open.value = false
  try {
    await pagesStore.ensureRootsLoaded(id)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'not_found') {
      pagesStore.clearSpaceCache(id)
      await spacesStore.invalidateActiveSpace(id)
    } else {
      uiStore.setError(`加载空间失败：${humanizeApiError(error)}`)
      return
    }
  }
  // 总是跳到新空间的首页 — 否则用户可能停留在旧空间的某个页面(在新空间里
  // 不存在 → 404,管理页 /manager/* 同样需要被带离)。
  if (router.currentRoute.value.path !== '/') {
    void router.push('/')
  }
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
        'ss-trigger-disabled': !canOpen,
        'ss-trigger-neutral': !isActiveShared,
        'ss-trigger-personal': active.kind === 'personal',
      }"
      :disabled="!canOpen"
      :title="canOpen ? undefined : 'You are in the only space you have access to'"
      :aria-disabled="!canOpen"
      @click="toggle"
    >
      <SpaceAvatar :space="active" :size="28" :show-name="true" />
      <!-- Private 徽章 — Notion 风格,只在 personal space 时挂。徽章本
           身是顶栏个人空间唯一显式标识,跟 ss-trigger-neutral 的色彩
           微调一起给"这里跟 team space 不一样"的视觉信号。 -->
      <span
        v-if="active.kind === 'personal'"
        class="ss-private-badge"
        title="个人空间:只有你自己可见"
      >
        <span class="material-symbols-outlined ss-private-icon">lock_person</span>
      </span>
      <span
        v-if="canOpen"
        class="material-symbols-outlined ss-caret"
      >expand_more</span>
    </button>

    <div v-else class="ss-empty">
      <span class="material-symbols-outlined ss-empty-icon">folder_off</span>
      <span class="ss-empty-text">还没有可访问的空间</span>
    </div>

    <div v-if="open && (spacesList.length > 0 || personalSpace || (isAdmin && archivedSpaces.length > 0))" class="ss-menu" role="listbox">
      <button
        v-if="personalSpace"
        type="button"
        class="ss-menu-item ss-menu-item-personal"
        :class="{ 'ss-menu-item-active': personalSpace.id === active?.id }"
        role="option"
        :aria-selected="personalSpace.id === active?.id"
        @click="pick(personalSpace.id)"
      >
        <SpaceAvatar :space="personalSpace" :size="28" />
        <span class="ss-menu-text">
          <span class="ss-menu-name">{{ personalSpace.name }}</span>
          <span class="ss-menu-desc ss-menu-desc-personal">
            <span class="material-symbols-outlined ss-personal-lock">lock_person</span>
            仅自己可见
          </span>
        </span>
        <span
          v-if="personalSpace.id === active?.id"
          class="material-symbols-outlined ss-check"
          aria-hidden="true"
        >check</span>
      </button>
      <div v-if="personalSpace && spacesList.length > 0" class="ss-section-divider"></div>
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
      <template v-if="isAdmin && archivedSpaces.length > 0">
        <div class="ss-archived-divider">已归档</div>
        <button
          v-for="s in archivedSpaces"
          :key="s.id"
          type="button"
          class="ss-menu-item ss-menu-item-archived"
          :class="{ 'ss-menu-item-active': s.id === active?.id }"
          role="option"
          :aria-selected="s.id === active?.id"
          @click="pick(s.id)"
        >
          <SpaceAvatar :space="s" :size="28" />
          <span class="ss-menu-text">
            <span class="ss-menu-name">{{ s.name }}</span>
          </span>
          <span
            v-if="s.id === active?.id"
            class="material-symbols-outlined ss-check"
            aria-hidden="true"
          >check</span>
        </button>
      </template>
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

/* Disabled 视觉 — 只在「只有一个空间且 active 就是它」时挂
 * (`totalOptions===1 && isActiveShared`)。trigger 不响应点击,
 * 灰显 + cursor not-allowed 避免误以为是 bug。原 title=tooltip
 * 给文字解释。命名上跟 .ss-trigger-clickable 完全对称,语义清楚。 */
.ss-trigger-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.ss-trigger-disabled:hover { background: transparent; }
.ss-trigger-disabled :deep(.sa-name) { color: var(--text-3); }
.ss-trigger-disabled .ss-private-icon { color: var(--text-3); }

/* Neutral state: the active space is the user's personal space. 早期版本
 * 把名字变浅(text-3)作为"私密"信号,但跟共享空间并排时会视觉割裂
 * (左侧名字 text-1,右侧名字 text-3)。现在改为克制策略:名字跟共享
 * 空间同色,只在徽章 / icon 上区分。caret 仍用 text-3(本来就是这个色,
 * 不是 personal 专属),保留规则以免 hover 变化出错。 */
.ss-trigger-neutral .ss-caret { color: var(--text-3); }

/* Personal space — 顶栏触发按钮的 chrome 跟共享空间保持完全一致
 * (透明背景 / 正常字色),唯一区别是挂一个"私人"徽章。Notion 风格:
 * 克制但能看见,不做"整块背景铺色 + 色条 + 文字变浅"的三重叠加。 */
.ss-trigger-personal {
  /* 不改背景、不加色条、不改名字颜色 — 跟 ss-trigger-clickable 完全对齐 */
}

/* Private 徽章 — 跟 SpaceAvatar 同一基线高度,小 lock + "私人"。
 * 配色用 --bg-subtle + --text-2,跟触发按钮整体一致;lock 图标
 * 用 --text-3 当"中性标记",不抢主色,避免跟左侧共享空间视觉打架。 */
.ss-private-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
  color: var(--text-2);
  user-select: none;
  flex-shrink: 0;
}
.ss-private-icon {
  font-size: 13px !important;
  color: var(--text-3);
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
.ss-archived-divider {
  padding: 4px 10px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}

/* 分隔线 — personal space 跟团队空间之间,代替原来的"个人空间是
 * 独立概念"的隐式分组。视觉上跟 .ss-archived-divider 共享同一思路:
 * 上边线 + 留白,但这里不写文字(语义靠位置已经清楚)。 */
.ss-section-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}

/* 个人空间行 — desc 区域把"仅自己可见"用 lock_person + 文字同款视觉,
 * 跟 trigger 上的 ss-private-badge 复用 icon,降低初次见到的认知成本。
 * 颜色用 text-3,跟 team space 的 description 同色,不抢名字的视觉权重。 */
.ss-menu-desc-personal {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-3);
}
.ss-personal-lock {
  font-size: 13px !important;
  color: var(--text-3);
  line-height: 1;
}
.ss-menu-item-archived { opacity: 0.65; }
</style>
