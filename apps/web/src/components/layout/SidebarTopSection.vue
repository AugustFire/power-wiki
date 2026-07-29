<script setup lang="ts">
/**
 * SidebarTopSection — Sidebar 顶部 sticky 「我的工作台」入口。
 *
 * P1-9 收尾:原本这里挂三个子组件(SidebarHomeItem + Pinned + Recents)。
 * 「已固定 / 最近访问」两块在 PersonalHomeView(`/me`) 页面里已经有完整
 * 渲染,sidebar 顶部再叠一份 → 用户撞两份重复列表(同样的标题、同样的
 * row、同样的折叠交互),只是位置不同。
 *
 * 用户意图(2026-07-29):删掉 sidebar 这两块。「我的工作台」是 sidebar
 * 顶部唯一保留的 sticky 入口 —— 点击进去能看到完整的 Pinned/Recents
 * 列表,没有重复,sidebar 顶部也变得极简(只有「我在这里 + 我的工作台」),
 * 把视觉空间留给 page tree。
 *
 * 因此本组件现在只剩 SidebarHomeItem 一个子组件。结构本身(sidebar-top-
 * section 的 sticky / border-bottom / bg)保留,因为 page tree 跟顶部入口
 * 之间仍然需要 1px 边线做视觉分隔。
 *
 * 历史:本组件原本叫 SidebarTopSection 是为多 section 预留容器,删两块后
 * 实际只剩一个孩子。保留这个名字 + sticky 容器语义以免破坏 Sidebar.vue
 * 的 import 名;后续如果 SidebarHomeItem 也外移,可考虑直接 inline 到
 * Sidebar.vue。
 */
import SidebarHomeItem from './SidebarHomeItem.vue'
</script>

<template>
  <div class="sidebar-top-section">
    <SidebarHomeItem />
  </div>
</template>

<style scoped>
/* sticky 行为依赖 .sidebar 是 overflow-y 容器 + this 在 DOM 里直接子 —
   父级 sticky 在 overflow-y:auto 容器里工作正常。background 给 var(--bg)
   是为了 .sidebar 滚动时这个区不"穿透"显示下面的 page tree。z-index: 2
   保证 sticky 时盖住下面的 page tree。 */
.sidebar-top-section {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
</style>