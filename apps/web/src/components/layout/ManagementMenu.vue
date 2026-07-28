<script setup lang="ts">
/**
 * ManagementMenu — TopBar 上的「管理」入口(P1-8)。
 *
 * 取代原来的单个图标按钮 `space-admin-btn`,改为带 caret 的 dropdown
 * trigger,popover 内分两 section:
 *
 *   - 当前空间管理 → /spaces/:id(shared + canAdminActiveSpace 才出)
 *   - 全局管理     → /manager/people(global admin 才出)
 *
 * 两段都显示的场景:用户既全局 admin 又是某空间 space-admin。此时按 section
 * 标题划开,视觉上比单按钮 + 一长串文字更清楚每条入口的「作用域」。
 *
 * 简化场景(P1-9):用户**只**是 space-admin(没有全局管理角),active 又是
 * shared 且能 admin,菜单里只有「当前空间管理」一段一项,dropdown 就成了
 * 「点 caret 才看到唯一一项」的繁琐交互。改成 single button:无 caret,
 * 点击直接跳空间管理页。视觉跟 .activity-btn 同档,32×32 方形。
 *
 * 触发条件:
 *   - global admin(无论 active 是什么):沿用 dropdown(可能有 2 段)
 *   - 只有 space-admin 且能 admin 当前 active shared:走 single button
 *   - 没有管理角:TopBar 不渲染本组件(showManagement = false)
 *
 * Active 态:popover 项用 --bg-canvas 高亮(跟 SpaceSwitcher 菜单同档),不抢
 * primary 按钮的视觉重量;single button 也复用 .mm-trigger-active 表达
 * 「当前就在空间管理页」。
 *
 * Popover 关闭交互跟 UserMenu / SpaceSwitcher 同套:mousedown outside + Esc。
 * click 改用 mousedown 跟 SpaceSwitcher 一致(避免 mousedown 关闭后 click 立即
 * 重开)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'

const authStore = useAuthStore()
const spacesStore = useSpacesStore()
const router = useRouter()
const route = useRoute()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const isAdmin = computed(() => authStore.isAdmin)

/**
 * 「当前空间」解析:
 *  - 在 /spaces/:id 或 /manager/spaces/:id 路由上,以 route.params.id 为准
 *  - 否则回退到 spacesStore.activeSpace(其他页面顶部指示的空间)
 *
 * 场景:管理员在 / 看到 active=personal 时点 sidebar 跳到 /spaces/A,URL
 * 已变但 spacesStore.activeSpace 还没切(Store 由 SpaceEditView 内部 set,
 * 但其实并没有 → 见 SpaceEditView 的 load 函数没调 setActiveSpace)。
 * 此时如果只读 activeSpace,「当前空间管理」段就会消失,体验割裂。
 * 用 route.params 兜底,确保在空间设置页里这条入口始终出现。
 */
const routeSpaceId = computed(() => {
  if (route.name === 'space-edit' || route.name === 'manager-space-edit') {
    return String(route.params.id ?? '')
  }
  return ''
})
const activeSpace = computed(() => {
  if (routeSpaceId.value) {
    return spacesStore.spaces.value.find(
      (s) => s.id === routeSpaceId.value,
    ) ?? null
  }
  return spacesStore.activeSpace.value
})

const canAdminActiveSpace = computed(() => {
  const s = activeSpace.value
  if (!s) return false
  if (s.kind === 'personal') return false
  if (authStore.isAdmin) return true
  return s.viewerRole === 'admin'
})

const isManagingActiveSpace = computed(() => {
  return route.name === 'space-edit' || route.name === 'manager-space-edit'
})

const isOnGlobalAdmin = computed(() => {
  return route.path.startsWith('/manager')
})

/**
 * P1-9:用户只有空间管理角、没有全局管理角,且能 admin 当前 active shared
 * space 时,topbar 入口简化为单图标按钮(无 caret / 无 dropdown)。
 * 有全局管理角时仍走 dropdown —— 可能叠「当前空间管理」+「全局管理」两段。
 */
const singleButtonMode = computed(() => {
  return !isAdmin.value && canAdminActiveSpace.value
})

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

function goActiveSpace() {
  close()
  const s = activeSpace.value
  if (!s) return
  void router.push({
    name: isAdmin.value ? 'manager-space-edit' : 'space-edit',
    params: { id: s.id },
  })
}

function goGlobalAdmin() {
  close()
  void router.push('/manager/people')
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node | null
  if (rootEl.value && t && !rootEl.value.contains(t)) close()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="mm-root">
    <!-- P1-9: single button 模式 —— 无 caret,无 dropdown,点击直跳空间管理 -->
    <button
      v-if="singleButtonMode"
      type="button"
      class="mm-trigger-single"
      :class="{ 'mm-trigger-active': isManagingActiveSpace }"
      :title="activeSpace ? `管理「${activeSpace.name}」` : '管理'"
      :aria-label="activeSpace ? `管理「${activeSpace.name}」` : '管理'"
      @click="goActiveSpace"
    >
      <span class="material-symbols-outlined">shield_person</span>
    </button>

    <template v-else>
      <button
        type="button"
        class="mm-trigger"
        :class="{ open }"
        :aria-expanded="open"
        aria-haspopup="menu"
        title="管理"
        aria-label="管理"
        @click="toggle"
      >
        <span class="material-symbols-outlined">shield_person</span>
        <span class="material-symbols-outlined mm-caret">expand_more</span>
      </button>

      <transition name="mm-fade">
      <div v-if="open" class="mm-popover" role="menu">
        <template v-if="canAdminActiveSpace">
          <div class="mm-section-label">当前空间管理</div>
          <button
            type="button"
            class="mm-item"
            role="menuitem"
            :class="{ 'mm-item-active': isManagingActiveSpace }"
            @click="goActiveSpace"
          >
            <span class="material-symbols-outlined mm-icon">settings</span>
            <span class="mm-item-text">
              <span class="mm-item-name">{{ activeSpace?.name }}</span>
              <span class="mm-item-hint">成员授权 / 基本信息</span>
            </span>
          </button>
        </template>

        <template v-if="isAdmin">
          <div
            v-if="canAdminActiveSpace"
            class="mm-divider"
            aria-hidden="true"
          ></div>
          <div class="mm-section-label">全局管理</div>
          <button
            type="button"
            class="mm-item"
            role="menuitem"
            :class="{ 'mm-item-active': isOnGlobalAdmin }"
            @click="goGlobalAdmin"
          >
            <span class="material-symbols-outlined mm-icon">admin_panel_settings</span>
            <span class="mm-item-text">
              <span class="mm-item-name">人员 / 空间 / 组</span>
              <span class="mm-item-hint">系统级 admin 后台</span>
            </span>
          </button>
        </template>
      </div>
      </transition>
    </template>
  </div>
</template>

<style scoped>
.mm-root { position: relative; display: inline-flex; }

.mm-trigger {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 0 6px 0 8px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.mm-trigger:hover { background: var(--bg-canvas); color: var(--text-1); }
.mm-trigger.open {
  background: var(--accent-soft);
  color: var(--accent);
}
.mm-trigger:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.mm-trigger .material-symbols-outlined:first-child { font-size: 18px; }
.mm-caret { font-size: 16px !important; }

/* P1-9:space-admin-only 模式的单按钮。无 caret,纯 32×32 方形,跟
   .activity-btn / 顶栏其他图标按钮同档。active 态共用 .mm-trigger-active
   —— 跟 dropdown trigger 的 .open 视觉权重一致,空间管理页有反馈。 */
.mm-trigger-single {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.mm-trigger-single:hover { background: var(--bg-canvas); color: var(--text-1); }
.mm-trigger-single:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.mm-trigger-single .material-symbols-outlined { font-size: 18px; }
.mm-trigger-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.mm-trigger-active:hover { background: var(--accent-soft); }

.mm-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 260px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-md, 0 4px 8px -2px rgba(9, 30, 66, 0.08),
                       0 0 1px rgba(9, 30, 66, 0.08));
  padding: 6px;
  z-index: 50;
}

.mm-section-label {
  padding: 6px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.mm-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.mm-item {
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
  transition: background var(--duration-fast) var(--ease-out);
}
.mm-item:hover { background: var(--bg-canvas); }
.mm-item:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.mm-item-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.mm-item-active:hover { background: var(--accent-soft); }

.mm-icon {
  font-size: 18px;
  flex-shrink: 0;
  color: inherit;
}
.mm-item-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.mm-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-item-active .mm-item-name { color: var(--accent); }
.mm-item-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.3;
}

.mm-fade-enter-active,
.mm-fade-leave-active {
  transition: opacity var(--duration-fast) ease,
              transform var(--duration-fast) var(--ease-out);
}
.mm-fade-enter-from,
.mm-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>