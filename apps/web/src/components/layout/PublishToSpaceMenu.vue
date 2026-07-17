<script setup lang="ts">
/**
 * PublishToSpaceMenu — popover for **publishing** a personal-space page to a
 * team space. Triggered from the PageTree ⋯ menu's "发布到..." item.
 *
 * 跟"移动到"不同:这里是**复制**一份新页到目标空间,原页保留在
 * personal space 不动,新页的标题由后端自动加 "(来自 {userName} 的个人分享)"
 * 后缀。这样用户可以:
 *   - 个人空间的页面继续迭代,不破坏"想法/未完成工作"的归属
 *   - 二次发布会再生成一份新的
 *   - 不会因为误操作把唯一一份页面发布出去
 *
 * Source 必须是 current user's personal space — 后端会校验
 * `space.kind === 'personal' && space.ownerId === me.id`,前端在 `hasMoveTargets`
 * 那一层已经过滤掉了非 personal / 别人的 personal。
 *
 * 成功发布后:跳到新页(让用户看到结果)、同步切换 active space、关闭菜单。
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

/** 「包含子页面」开关 + 递归深度。depth=50 当「全部」用(见后端 schema max 50)。 */
const includeChildren = ref(false)
const depth = ref(1)
const DEPTH_ALL = 50
const depthOptions: { label: string; value: number }[] = [
  { label: '1 级', value: 1 },
  { label: '2 级', value: 2 },
  { label: '全部', value: DEPTH_ALL },
]

/**
 * 目标空间:只能是团队空间 (`kind === 'shared'`),排除 personal 与源 page
 * 所在 space(同一个 personal 空间再发一次没意义)。
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
  const MENU_W = 280
  const SAFE = 8
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0
  let left = props.anchor.x + 8
  let top = props.anchor.y + 4
  if (left + MENU_W + SAFE > vw) left = Math.max(SAFE, vw - MENU_W - SAFE)
  if (top > vh - 80) top = Math.max(SAFE, vh - 80)
  return { top: `${top}px`, left: `${left}px` }
})

async function pick(targetSpaceId: string) {
  emit('close')
  uiStore.closeMenu()
  try {
    const created = await pagesStore.publishPageToSpace(props.page.id, targetSpaceId, {
      includeChildren: includeChildren.value,
      depth: depth.value,
    })
    const target = spacesStore.spaces.value.find((s) => s.id === targetSpaceId)
    if (target) spacesStore.setActiveSpace(target.id)
    // 成功后给个 toast —— 跳页后 ReadView 接管,toast 仍挂在 App.vue
    // 全局容器里,3 秒内能看到「已发布到 X」。失败由 store 弹 banner。
    const scope = includeChildren.value ? '(含子页)' : ''
    uiStore.notify(`已发布到「${target?.name ?? '目标空间'}」${scope}`, 'success')
    // 跳到新生成的副本 — 源页保持不动
    await router.push(`/p/${created.id}`)
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
      <span class="m2s-title">发布到团队空间</span>
      <span class="m2s-sub">{{ currentSpaceName }} → ...</span>
    </div>
    <div v-if="destinations.length > 0" class="m2s-opts">
      <label class="m2s-toggle">
        <input v-model="includeChildren" type="checkbox" class="m2s-checkbox" />
        <span class="m2s-toggle-label">包含子页面</span>
      </label>
      <div v-if="includeChildren" class="m2s-depth">
        <button
          v-for="opt in depthOptions"
          :key="opt.value"
          type="button"
          class="m2s-depth-btn"
          :class="{ 'is-active': depth === opt.value }"
          @click="depth = opt.value"
        >{{ opt.label }}</button>
      </div>
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
      <span class="material-symbols-outlined m2s-chev" aria-hidden="true">publish</span>
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

.m2s-opts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 10px 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.m2s-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.m2s-checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
  margin: 0;
}
.m2s-toggle-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.m2s-depth {
  display: flex;
  gap: 4px;
  padding-left: 22px;
}
.m2s-depth-btn {
  flex: 1;
  padding: 4px 0;
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 3px);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
}
.m2s-depth-btn:hover {
  background: var(--border);
}
.m2s-depth-btn.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
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
