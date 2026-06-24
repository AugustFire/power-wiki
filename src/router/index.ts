import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
  },
  {
    path: '/p/:id',
    name: 'read',
    component: () => import('@/views/ReadView.vue'),
    props: true,
  },
  {
    path: '/p/:id/edit',
    name: 'edit',
    component: () => import('@/views/EditView.vue'),
    props: true,
  },
  {
    path: '/new',
    name: 'new',
    component: () => import('@/views/EditView.vue'),
    props: (route) => ({ parentId: route.query.parent ?? null }),
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
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