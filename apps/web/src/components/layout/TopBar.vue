<script setup lang="ts">
/**
 * TopBar — the 56px global header.
 *
 * Three regions, left → right:
 *   1. Brand mark + space switcher (current scope indicator)
 *   2. Global search trigger (opens TopSearch via uiStore; ⌘K is handled
 *      globally in App.vue's keydown listener)
 *   3. Right rail: Help / Activity / Bell / UserMenu
 *
 * Lives at the top of the authed app shell. The error banner and page
 * content sit below — those stay in App.vue since they're driven by
 * other stores.
 */
import BrandLogo from '@/components/ui/BrandLogo.vue'
import SpaceSwitcher from '@/components/layout/SpaceSwitcher.vue'
import UserMenu from '@/components/ui/UserMenu.vue'
import NotificationBell from '@/components/layout/NotificationBell.vue'
import HelpButton from '@/components/layout/HelpButton.vue'
import { useUiStore } from '@/stores/ui'
import { MOD_KEY } from '@/lib/platform'

const uiStore = useUiStore()
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <BrandLogo :size="24" with-wordmark class="topbar-logo" />
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
      <NotificationBell />
      <UserMenu />
    </div>
  </header>
</template>

<style scoped>
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
</style>