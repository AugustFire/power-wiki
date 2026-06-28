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
    path: '/new',
    name: 'new',
    component: () => import('@/views/EditView.vue'),
    props: (route) => ({ parentId: route.query.parent ?? null }),
    meta: { requiresAuth: true },
  },

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
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    return { top: 0 }
  },
})

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