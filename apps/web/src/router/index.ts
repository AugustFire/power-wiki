import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

declare module 'vue-router' {
  // Augment route meta so we can declare public / requiresAdmin / requiresAuth
  // at the route table rather than hardcoding paths in beforeEach.
  interface RouteMeta {
    /** Mark route as accessible without any session. */
    public?: boolean
    /** Mark route as requiring an authenticated session (default for non-public). */
    requiresAuth?: boolean
    /** Mark route as requiring role === 'admin'. Falls back to NotFound (not /login)
     *  to avoid leaking the existence of /manager/* to non-admin users. */
    requiresAdmin?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  // ─── Public auth pages (Stage 4a) ────────────────────────────────────
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/auth/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('@/views/auth/ResetPasswordView.vue'),
    meta: { public: true, requiresAuth: true },
  },

  // ─── Authed app ─────────────────────────────────────────────────────
  {
    // M2: /me is now the personal Dashboard ("Your Work") — cross-space
    // personal awareness, NOT the user's personal space page tree. The
    // personal space is still accessible via SpaceSwitcher / direct nav.
    //
    // Registered before `/` so /me always matches this route, not the
    // catch-all.
    path: '/me',
    name: 'me-dashboard',
    component: () => import('@/views/MeDashboardView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/p/:id',
    name: 'read',
    component: () => import('@/views/ReadView.vue'),
    props: true,
    meta: { requiresAuth: true },
  },
  {
    path: '/p/:id/edit',
    name: 'edit',
    component: () => import('@/views/EditView.vue'),
    props: true,
    meta: { requiresAuth: true },
  },
  {
    // Confluence-style dedicated page history: full-viewport surface
    // (timeline list left + diff viewer right). Same `:id` param so
    // PageTree's active-highlight logic keeps working without changes.
    path: '/p/:id/history',
    name: 'history',
    component: () => import('@/views/HistoryView.vue'),
    props: true,
    meta: { requiresAuth: true },
  },
  {
    path: '/new',
    name: 'new',
    component: () => import('@/views/EditView.vue'),
    props: (route) => ({ parentId: route.query.parent ?? null }),
    meta: { requiresAuth: true },
  },
  // P1-3: workspace-wide 编辑活动流。TopBar history_toggle_off icon 入口。
  // Sidebar 不再暴露这条入口 — 三列布局 + 主 list,跟 HomeView / HistoryView 同档位。
  {
    path: '/activity',
    name: 'activity',
    component: () => import('@/views/ActivityView.vue'),
    meta: { requiresAuth: true },
  },

  // M13: 全量关注页面。Sidebar「我的关注」section 的「查看全部」跳到这里。
  // 独立成 /me/watched 而不是挂在 /me 下面 —— M2 的真 Dashboard 来之前不引入
  // /me?tab=xxx 模式;Phase 7 给出最简可访问页,M2 时再考虑迁到 /me/watched。
  {
    path: '/me/watched',
    name: 'watched',
    component: () => import('@/views/WatchedView.vue'),
    meta: { requiresAuth: true },
  },

  // ─── Notifications inbox ──────────────────────────────────────────
  // 2026-07-01: 删除了原来的 `/notifications` 顶级路由 + NotificationsView.
  // 通知中心现在是 TopBar 铃铛 → 右侧抽屉, 没有独立页面.

  // ─── Manager (admin-only, Stage 4b+) ─────────────────────────────
  // Layout renders the subnav; children render the section content.
  {
    path: '/manager',
    component: () => import('@/views/manager/ManagerLayout.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
    children: [
      {
        path: '',
        redirect: { name: 'manager-people' },
      },
      // Stage 5d: combined "人员" page (users + groups in one tabbed view).
      // Old /users and /groups paths redirect here for backward compat.
      {
        path: 'people',
        name: 'manager-people',
        components: {
          default: () => import('@/views/manager/PeopleView.vue'),
          context: () => import('@/views/manager/panels/PeopleContextPanel.vue'),
        },
      },
      {
        path: 'people/users/:id',
        name: 'manager-user-edit',
        component: () => import('@/views/manager/UserEditView.vue'),
        props: true,
      },
      {
        path: 'people/groups/:id',
        name: 'manager-group-edit',
        component: () => import('@/views/manager/GroupEditView.vue'),
        props: true,
      },
      // Back-compat redirects: old bookmarks (e.g. /manager/users, /manager/users/:id,
      // /manager/groups, /manager/groups/:id) keep working by landing on the
      // corresponding tab within /manager/people.
      {
        path: 'users',
        redirect: { name: 'manager-people', query: { tab: 'users' } },
      },
      {
        path: 'users/:id',
        redirect: (to) => ({ name: 'manager-user-edit', params: { id: to.params.id } }),
      },
      {
        path: 'groups',
        redirect: { name: 'manager-people', query: { tab: 'groups' } },
      },
      {
        path: 'groups/:id',
        redirect: (to) => ({ name: 'manager-group-edit', params: { id: to.params.id } }),
      },
      {
        path: 'spaces',
        name: 'manager-spaces',
        components: {
          default: () => import('@/views/manager/SpacesView.vue'),
          context: () => import('@/views/manager/panels/SpacesContextPanel.vue'),
        },
      },
      {
        path: 'spaces/:id',
        name: 'manager-space-edit',
        component: () => import('@/views/manager/SpaceEditView.vue'),
        props: true,
      },
      {
        // Stage 5: admin-only trash view. Single-component route (no
        // context panel) because the list IS the action surface.
        path: 'trash',
        name: 'manager-trash',
        component: () => import('@/views/manager/TrashView.vue'),
      },
    ],
  },

  // ─── Catch-all 404 ──────────────────────────────────────────────────
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { requiresAuth: true },
  },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  /**
   * 滚动行为:
   *   1. 后退/前进 → 用浏览器保存的位置(savedPosition)
   *   2. 有 hash → 等对应元素出现再 smooth-scroll。共享的
   *      `scrollToHashAsync` 同时被 main.ts 的 `watch(router.currentRoute)`
   *      调用 — 后者覆盖「同 path 切 hash」(vue-router 4 [issue #1929](https://github.com/vuejs/router/issues/1929)):
   *      router.replace 不会触发 scrollBehavior,所以这里只负责「真导航」
   *      场景(刷新页面进入带 hash 的 URL,前进/后退)。
   *      - `#h-xxx` 50ms × 30 = 1.5s(headings 是 sync 渲染,够冷启动 +
   *        Vue render)
   *      - `#comment-xxx` 100ms × 60 = 6s(评论 fetch + load-more)
   *   3. 无 hash → 顶部
   *
   * 注意:Vue Router 4 的 ScrollPosition 类型不暴露 `block` 字段(只能用
   * `top` / `left` / `behavior` / `offset`)。所以 heading 和 comment 都走
   * 默认 block:'start',靠 base.css 的 `scroll-padding-top` 让 TopBar 不挡。
   */
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) return scrollToHashAsync(to.hash)
    return { top: 0 }
  },
})

/**
 * Poll for an element matching `hash` and scroll to it.
 *
 * Shared by:
 *   1. `scrollBehavior` above — handles initial navigation (e.g. page
 *      reload with `#h-…` in URL).
 *   2. The `watch(router.currentRoute)` in main.ts — handles in-app
 *      same-path hash changes (TOC click, `#comment-…` jumps from
 *      notifications). vue-router 4 [doesn't fire scrollBehavior for
 *      these](https://github.com/vuejs/router/issues/1929), so we
 *      need a separate trigger that uses the exact same poll+scroll
 *      logic to keep both paths consistent.
 *
 * Why a poll:
 *   - `#h-…` heading ids are injected by `headingAnchors.ts` AFTER
 *     ReadView's `v-html` commits, so the element isn't present in
 *     the first frame after a hash change. 50ms × 30 = 1.5s covers
 *     cold start + Vue render.
 *   - `#comment-…` elements are mounted by `CommentsSection` after
 *     an async fetch + initial load-more, so we give it 100ms × 60
 *     = 6s to appear.
 *
 * Returns a `ScrollPosition`-compatible Promise so vue-router
 * considers the navigation handled; resolve with `{ top: 0 }` on
 * timeout so we don't strand the user at scrollY=0.
 */
export function scrollToHashAsync(hash: string) {
  const isComment = hash.startsWith('#comment-')
  const maxAttempts = isComment ? 60 : 30
  const interval = isComment ? 100 : 50
  return new Promise<{ el: string; behavior?: ScrollOptions['behavior'] } | { top: number }>((resolve) => {
    let attempts = 0
    const tryScroll = () => {
      const el = document.querySelector(hash) as HTMLElement | null
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        resolve({ el: hash, behavior: 'smooth' })
      } else if (attempts++ < maxAttempts) {
        setTimeout(tryScroll, interval)
      } else {
        resolve({ top: 0 })
      }
    }
    tryScroll()
  })
}

/**
 * Per-route auth gate.
 *
 * Order matters:
 *   1. Idempotent auth init — concurrent first navigations share one promise.
 *   2. public routes (login / reset-password) skip auth checks but still
 *      need init() to know whether to bounce a logged-in user.
 *   3. mustResetPassword → force /reset-password (only escape is sign-out).
 *   4. requiresAdmin → NotFound, not /login, to avoid leaking /manager/*.
 *   5. requiresAuth (default) → /login?redirect=<from>.
 *
 * Note: requiresAdmin implies requiresAuth, so admin check runs after auth.
 */
router.beforeEach(async (to) => {
  const authStore = useAuthStore()
  await authStore.init()

  // 2. public pages: login is reachable unauthed; reset-password requires
  //    the mustResetPassword session to actually be present, so we still
  //    gate it below.
  if (to.meta.public && to.name !== 'reset-password') {
    // Already logged in without mustReset? Bounce to home so /login is unreachable.
    if (authStore.isAuthed && !authStore.needsPasswordReset && to.name === 'login') {
      return { path: '/' }
    }
    return true
  }

  // 3. force password reset — bypass everything except the reset page itself
  if (authStore.needsPasswordReset) {
    if (to.name === 'reset-password') return true
    return { name: 'reset-password' }
  }

  // 4. admin gate — fall through to NotFound rather than /login so non-admins
  //    can't probe whether /manager exists.
  if (to.meta.requiresAdmin && !authStore.isAdmin) {
    return { name: 'not-found' }
  }

  // 5. auth gate — most routes require a session
  if (!authStore.isAuthed) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  return true
})