<script setup lang="ts">
/**
 * TopBar — the 56px global header.
 *
 * Three regions, left → right:
 *   1. Brand mark + space switcher (current scope indicator)
 *   2. Global search trigger (opens TopSearch via uiStore; ⌘K is handled
 *      globally in App.vue's keydown listener)
 *   3. Right rail: Help / Activity / SpaceAdmin / Bell / UserMenu
 *
 * Lives at the top of the authed app shell. The error banner and page
 * content sit below — those stay in App.vue since they're driven by
 * other stores.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandLogo from '@/components/ui/BrandLogo.vue'
import SpaceSwitcher from '@/components/layout/SpaceSwitcher.vue'
import UserMenu from '@/components/ui/UserMenu.vue'
import NotificationBell from '@/components/layout/NotificationBell.vue'
import HelpButton from '@/components/layout/HelpButton.vue'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { MOD_KEY } from '@/lib/platform'

const uiStore = useUiStore()
const authStore = useAuthStore()
const spacesStore = useSpacesStore()
const router = useRouter()
const route = useRoute()

/**
 * v0.7 → v0.7.1: 管理空间入口从 sidebar 移到 TopBar 右侧栏。原因:
 *  - sidebar-bottom 跟「创建页面 / 导入 markdown」内容操作混在一起违和
 *  - active space header 右侧放 chip 又跟 [count] 抢视觉重量
 *  - TopBar 右侧栏是「控制 / 入口」语义位,跟 Activity / Help 同档,
 *    跟 Bell / UserMenu 形成清晰的「contextual → personal」梯度
 * 仅在 active space 是 shared(团队空间)且本用户能管理(全局 admin OR
 * viewerRole='admin')时显示。**个人空间永远是 owner-only,不存在
 * 「管理」页面** — kind='personal' 直接 false。
 */
const canAdminActiveSpace = computed(() => {
  const s = spacesStore.activeSpace.value
  if (!s) return false
  if (s.kind === 'personal') return false
  if (authStore.isAdmin) return true
  return s.viewerRole === 'admin'
})

function goAdminSpace() {
  const s = spacesStore.activeSpace.value
  if (!s) return
  void router.push({
    name: authStore.isAdmin ? 'manager-space-edit' : 'space-edit',
    params: { id: s.id },
  })
}

const isManagingSpace = computed(
  () => route.name === 'space-edit' || route.name === 'manager-space-edit',
)
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
      <!-- 当前空间的「管理」入口,放在 Activity 跟 Bell 之间。
           仅 space-admin / 全局 admin 可见。全局 admin 进入 manager layout,
           space-admin 进入顶层 /spaces/:id;两个路由都保持 active 高亮。 -->
      <button
        v-if="canAdminActiveSpace"
        type="button"
        class="space-admin-btn"
        title="管理当前空间(成员授权、基本信息)"
        aria-label="管理当前空间"
        :class="{ 'is-current': isManagingSpace }"
        @click="goAdminSpace"
      >
        <span class="material-symbols-outlined">shield_person</span>
      </button>
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
/* 当前空间管理页高亮同时覆盖全局 admin 的 manager 子路由与
   space-admin 的顶层路由。 */
.space-admin-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--duration-fast);
}
.space-admin-btn:hover {
  background: var(--bg-canvas);
  color: var(--text-1);
}
.space-admin-btn.is-current {
  background: var(--accent-soft);
  color: var(--accent);
}
.space-admin-btn .material-symbols-outlined {
  font-size: 18px;
}
</style>