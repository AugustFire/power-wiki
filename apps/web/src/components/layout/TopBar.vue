<script setup lang="ts">
/**
 * TopBar — the 56px global header.
 *
 * Three regions, left → right:
 *   1. Brand mark + space switcher (current scope indicator)
 *   2. Global search trigger (opens TopSearch via uiStore; ⌘K is handled
 *      globally in App.vue's keydown listener)
 *   3. Right rail: Help / Activity / ManagementMenu / Bell / UserMenu
 *
 * Lives at the top of the authed app shell. The error banner and page
 * content sit below — those stay in App.vue since they're driven by
 * other stores.
 *
 * P1-8: 「管理」入口从单个图标按钮升级为 dropdown(`ManagementMenu`)。
 * 原因见该组件 doc — 主要解决「全局 admin + space-admin 同时存在时」
 * 的语义分裂问题,让两条入口各自有清晰的标题段。
 *
 * 早一版(P0-1)在 `.brand` 里硬塞 SpaceBreadcrumb,在 1280 视口下会让
 * grid 列撑超 192px(数学上不可能再放新元素)。改在 subheader 的既有
 * `<Breadcrumb>` 第一段改用 active space 名字 + kind icon —— 详见
 * ReadView/EditView/HistoryView 的 breadcrumbSegments 改动 + .topbar
 * CSS 没有变化。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import BrandLogo from '@/components/ui/BrandLogo.vue'
import SpaceSwitcher from '@/components/layout/SpaceSwitcher.vue'
import UserMenu from '@/components/ui/UserMenu.vue'
import NotificationBell from '@/components/layout/NotificationBell.vue'
import HelpButton from '@/components/layout/HelpButton.vue'
import ManagementMenu from '@/components/layout/ManagementMenu.vue'
import { useUiStore } from '@/stores/ui'
import { MOD_KEY } from '@/lib/platform'

const uiStore = useUiStore()
const authStore = useAuthStore()
const spacesStore = useSpacesStore()

/**
 * 「管理」trigger 是否渲染 —— 至少一段菜单不为空时显示:
 *  - isAdmin(全局管理)
 *  - canAdminActiveSpace(当前 shared 空间是 admin)
 * 两段的具体可见性由 ManagementMenu 内部判断,这里只决定 trigger。
 */
const canAdminActiveSpace = computed(() => {
  const s = spacesStore.activeSpace.value
  if (!s) return false
  if (s.kind === 'personal') return false
  if (authStore.isAdmin) return true
  return s.viewerRole === 'admin'
})

const showManagement = computed(
  () => authStore.isAdmin || canAdminActiveSpace.value,
)
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <!-- 2026-08-07: BrandLogo 套 RouterLink 跳 / —— 让 brand 回归 Confluence /
           Notion 默认的「点 logo 回 home」直觉。`/` 在 active=team 时渲染
           SpaceHomeView(team home 或配置的 homepagePageId),active=personal 时
           由 SpaceHomeView 的 setup watch 重定向到 /me(P0 3929f74)。brand
           是「回主场景」入口不是「我在 home」指示,所以显式 override router-link-
           active / -exact-active 高亮,跟下面 activity-btn 的「我在 activity」
           语义区分。 -->
      <RouterLink to="/" class="topbar-logo-link" title="回到首页">
        <BrandLogo :size="24" with-wordmark class="topbar-logo" />
      </RouterLink>
      <span class="brand-divider" aria-hidden="true"></span>
      <SpaceSwitcher />
    </div>
    <button
      type="button"
      class="global-search"
      title="搜索所有页面"
      @click="uiStore.openTopSearch()"
    >
      <span class="material-symbols-outlined icon">search</span>
      <span class="gs-placeholder">搜索所有页面…</span>
      <kbd class="gs-kbd">{{ MOD_KEY }}K</kbd>
    </button>
    <div class="topbar-right">
      <HelpButton />
      <!-- P1-3: workspace-wide 活动流入口。点击跳 /activity。
        视觉跟 HelpButton 同款 32×32 + hover 灰底,语义上跟"全局入口"
        一档(都是无障碍级 help-y 的 "go to view" 控件)。 -->
      <RouterLink
        to="/activity"
        class="activity-btn"
        title="最近页面活动"
        aria-label="最近页面活动"
      >
        <span class="material-symbols-outlined">history_toggle_off</span>
      </RouterLink>
      <!-- P1-8: 管理入口 dropdown(ManagementMenu)。trigger 在两段菜单
           都不为空时才显示(全局 admin / space-admin)。dropdown 内部
           按需渲染:仅全局 admin 时只出「全局管理」段,仅 space-admin
           时只出「当前空间管理」段,两者兼具则两段都出。 -->
      <ManagementMenu v-if="showManagement" />
      <NotificationBell />
      <UserMenu />
    </div>
  </header>
</template>

<style scoped>
.topbar-logo-link {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  color: inherit;
  border-radius: 4px;
  /* brand 是「回主场景」入口不是「我在 home」指示 —— 任何路由都不该高亮,
     避免 router-link-active 的 accent-soft 跟下面 activity-btn 的「我在
     activity」语义撞色。 */
}
.topbar-logo-link.router-link-active,
.topbar-logo-link.router-link-exact-active {
  background: transparent;
  color: inherit;
}
.topbar-logo-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.topbar-logo { flex-shrink: 0; }
.activity-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  text-decoration: none;
  transition: background var(--duration-fast);
}
.activity-btn:hover {
  background: var(--bg-canvas);
  color: var(--text-1);
}
.activity-btn.router-link-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.activity-btn .material-symbols-outlined {
  font-size: 18px;
}
/* ManagementMenu 自带样式 — 见 components/layout/ManagementMenu.vue。
   当前空间管理页 active 高亮覆盖在 popover 项里(.mm-item-active)。 */
</style>