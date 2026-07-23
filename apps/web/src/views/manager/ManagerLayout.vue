<script setup lang="ts">
/**
 * Manager layout — Stage 4c.
 *
 * Provides the /manager sub-navigation shell:
 *   - Subheader with breadcrumb (我的知识库 / 管理后台 / <sub>)
 *   - Left sub-nav (200px) with admin sections: 用户 / 用户组 / 空间
 *   - Main content via <RouterView />
 *
 * The sub-nav is a NavLink list — active item gets --accent-soft background
 * + --accent text. Reusing the same accent treatment as the sidebar tree.
 */
import { RouterView, RouterLink, useRoute } from 'vue-router'
import { computed } from 'vue'

const route = useRoute()

const section = computed(() => {
  const name = String(route.name ?? '')
  // People tab covers both user- and group-related sub-routes.
  if (name === 'manager-people') {
    const tab = route.query.tab
    return tab === 'groups' ? '用户组' : '用户'
  }
  if (name.startsWith('manager-user-edit')) return '用户'
  if (name.startsWith('manager-group-edit')) return '用户组'
  if (name.startsWith('manager-spaces')) return '空间'
  if (name.startsWith('manager-trash')) return '回收站'
  if (name.startsWith('manager-audit')) return '审计日志'
  return '管理后台'
})
</script>

<template>
  <div class="manager-shell">
    <div class="subheader">
      <div class="breadcrumb">
        <a href="#/">我的知识库</a>
        <span class="sep">/</span>
        <RouterLink to="/manager/people" class="crumb-item">管理后台</RouterLink>
        <template v-if="section !== '管理后台'">
          <span class="sep">/</span>
          <span class="crumb-item current">{{ section }}</span>
        </template>
      </div>
    </div>

    <div class="manager-grid">
      <nav class="manager-subnav" aria-label="管理后台导航">
        <RouterLink to="/manager/people" class="mn-link" active-class="active">
          <span class="material-symbols-outlined mn-icon">group</span>
          <span>人员</span>
        </RouterLink>
        <RouterLink to="/manager/spaces" class="mn-link" active-class="active">
          <span class="material-symbols-outlined mn-icon">folder</span>
          <span>空间</span>
        </RouterLink>
        <RouterLink to="/manager/trash" class="mn-link" active-class="active">
          <span class="material-symbols-outlined mn-icon">restore_from_trash</span>
          <span>回收站</span>
        </RouterLink>
        <RouterLink to="/manager/audit" class="mn-link" active-class="active">
          <span class="material-symbols-outlined mn-icon">history</span>
          <span>审计日志</span>
        </RouterLink>
      </nav>

      <main class="manager-main">
        <RouterView v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </RouterView>
      </main>

      <!--
        Right-side context panel. Filled by routes that register a `context`
        named component (UsersView / GroupsView / SpacesView). Edit views
        don't register one, so the column collapses to empty.
      -->
      <aside class="manager-context">
        <RouterView name="context" v-slot="{ Component: Ctx }">
          <transition name="fade" mode="out-in">
            <component v-if="Ctx" :is="Ctx" />
          </transition>
        </RouterView>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/*
 * Manager shell — Stage 5d (post-revert).
 *
 * Three-column layout that fills the viewport edge-to-edge so 2K screens
 * get full use of the horizontal real estate. Each list view internally
 * caps its own content width and centers it (see PeopleView / SpacesView
 * / TrashView). The right context panel stays at 320px so on 2K its
 * content needs to be richer (PeopleContextPanel adds 最近登录 + 最近
 * 活动 to fill the space).
 */
.manager-shell { min-height: calc(100vh - var(--topbar-h)); }

.manager-grid {
  display: grid;
  /* Subnav width matches the app's --sidebar-w (280) so the content
     column inside the main area starts at the same X as the editor's
     `.content-inner` — i.e. the manager page's content area is the
     same width AND position as ReadView/EditView's content area. */
  grid-template-columns: 280px minmax(0, 1fr) 320px;
  height: calc(100vh - var(--topbar-h) - var(--sub-h));
  background: var(--bg-canvas);
}

.manager-subnav {
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.mn-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-2);
  border-radius: var(--radius-md, 4px);
  text-decoration: none;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
  cursor: pointer;
  user-select: none;
}
.mn-link:hover {
  background: var(--bg-canvas);
  color: var(--text-1);
  text-decoration: none;
}
.mn-link.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.mn-link.disabled {
  color: var(--text-3);
  opacity: 0.7;
  cursor: not-allowed;
}
.mn-link.disabled:hover {
  background: transparent;
  color: var(--text-3);
}
.mn-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.mn-tag {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 6px;
  background: var(--bg-subtle);
  color: var(--text-3);
  border-radius: var(--radius-pill, 999px);
}

.manager-main {
  overflow-y: auto;
  padding: 24px 32px;
}

.manager-context {
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  padding: 24px 20px;
  overflow-y: auto;
}
.manager-context:empty {
  display: none;
}
</style>