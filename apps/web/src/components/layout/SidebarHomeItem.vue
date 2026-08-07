<script setup lang="ts">
/**
 * SidebarHomeItem — Sidebar 顶部 sticky 区的「我的工作台」单行入口。
 *
 * 参考 Confluence Cloud left rail 的 Home entry 视觉:home icon + 文字,
 * 28px 高,跟 sidebar 其他 row 同款 baseline。
 *
 * Active 态:`route.name === 'me-dashboard'` 高亮。
 * 「我的工作台」语义就是 personal workspace(`/me`),不该跟 team home(`/`)
 * 共享 active 状态。早期版本(P1-9 之前)用 `|| 'home'` 让两边都亮,导致
 * 点 sidebar 顶部「激活的空间」chip 跳到 `/` 时,「我的工作台」也自动加
 * accent-soft 高亮 —— 两个 active 视觉锚点同时出现在 sidebar 顶部,看起来
 * 像 chip 单点击了 workspace,语义上割裂。修法:严格限定为 personal home。
 *
 * 2026-08-07 P2:sidebar 顶部 quick-nav chip 删除后,`team home`(/) 不再
 * 有 sidebar 锚点 —— 「我在 team home」的视觉表达改由 TopBar SpaceSwitcher
 * 触发器里 active space name 高亮 + SpaceHomeView hero 标题承担。SidebarHomeItem
 * active 态保持 personal home 专属(route.name === 'me-dashboard'),跟 team
 * home 正交。
 *
 * 不覆盖 `/p/:id`、`/me/watched` 等子路由 —— 那些不是"home 界面"。
 *
 * 点击:router push /me。**不**调 setActiveSpace — PersonalHomeView 不依赖
 * active space。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

const isActive = computed(() => route.name === 'me-dashboard')

function goHome(): void {
  void router.push('/me')
}
</script>

<template>
  <button
    type="button"
    class="sh-item"
    :class="{ 'sh-item-active': isActive }"
    :title="'我的工作台 — 跨空间首页'"
    @click="goHome"
  >
    <span class="material-symbols-outlined sh-icon">home</span>
    <span class="sh-label">我的工作台</span>
  </button>
</template>

<style scoped>
.sh-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius, 4px);
  background: transparent;
  border: 0;
  color: var(--text-2);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast, 120ms) var(--ease-out, ease),
    color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.sh-item:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.sh-icon {
  font-size: 18px !important;
  color: var(--text-3);
  flex-shrink: 0;
}
.sh-item:hover .sh-icon { color: var(--text-1); }

.sh-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Active 态 —— 跟 WatchedSidebar.watched-row.active 同款 token:
   accent-soft 底 + accent 字色 + 加粗,一眼能看到"我在 home"。 */
.sh-item-active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.sh-item-active .sh-icon { color: var(--accent); }
.sh-item-active:hover {
  /* active 态 hover 不再加深(已经是 accent-soft),避免视觉抖动 */
  background: var(--accent-soft);
}
</style>