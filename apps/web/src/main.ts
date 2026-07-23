import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router, scrollToHashAsync } from './router'
import { usePagesStore } from './stores/pages'
import { useSpacesStore } from './stores/spaces'
import { useAuthStore } from './stores/auth'
import { useUiStore } from './stores/ui'
import { writeJSON } from './lib/storage'
import { setUnauthorizedHandler } from './lib/api'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/mention.css'
import './styles/print.css'
import 'tippy.js/dist/tippy.css'

const KEY_EXPANDED = 'power-wiki:tree-expanded'

const app = createApp(App)
app.use(createPinia())
app.use(router)

// 早期 instantiate ui store: 触发 tree-expanded watch + 默认值写入
useUiStore()

// 全局 401 拦截:任何非 auth-flow 的请求返回 401,清掉本地 session 并跳登录。
// 必须在 router 安装之后、任何 authed 请求之前装配。handler 不调用 auth.logout()
// —— 401 已经说明 cookie 无效,再发一次 sign-out 既浪费又可能再次触发此 handler。
//
// 模块 9 P0:先 resetSessionState() 再跳转。只清 user / mustResetPassword 会把
// 前一个 session 的 pages / spaces / recents 等数据 store 留在内存里,401 → /login
// 的过渡窗口会闪一帧旧数据(旧页面树 / 旧空间)。resetSessionState() 一次性
// 抹掉全部 per-session 内存状态,与 logout() 走同一条清理路径。
setUnauthorizedHandler(async () => {
  const auth = useAuthStore()
  auth.user = null
  auth.mustResetPassword = false
  auth.personalSpaceId = null
  auth.resetSessionState()
  const currentRoute = router.currentRoute.value
  if (currentRoute.meta.public) return
  await router.push({
    name: 'login',
    query: { redirect: currentRoute.fullPath },
  })
})

/**
 * In-app same-path hash change → scroll to the new hash.
 *
 * vue-router 4 [doesn't fire `scrollBehavior` when only the hash changes
 * on the same path](https://github.com/vuejs/router/issues/1929) (TocPanel
 * click on `/p/abc#h-foo` → `/p/abc#h-bar`, NotificationBell jump to
 * `#comment-…`, etc.). The shared `scrollToHashAsync` helper used by
 * `router.scrollBehavior` does the element-poll + smooth-scroll, so we
 * reuse it here to keep both paths consistent.
 *
 * We only fire when path is the same — cross-path navigations are routed
 * through `scrollBehavior` already.
 */
watch(
  () => router.currentRoute.value,
  (to, from) => {
    if (to.hash && to.path === from.path && to.hash !== from.hash) {
      void scrollToHashAsync(to.hash)
    }
  },
)

// 先 mount,再异步加载页面数据 — 这样 RouterView 能立刻渲染骨架,
// Store 的 loading 状态由 App.vue 内部的 <PageLoading> 接管。
app.mount('#app')

router.isReady().then(async () => {
  // Stage 4: router beforeEach runs authStore.init() before any navigation.
  // Skip data loaders when unauthed — login flow doesn't need pages/spaces yet.
  const authStore = useAuthStore()
  if (!authStore.isAuthed) return
  if (!localStorage.getItem(KEY_EXPANDED)) writeJSON(KEY_EXPANDED, [])
  // Stage 4c: spaces must load before pages so HomeView can show the active
  // space's root pages. Order matters — spaces first, then pages.
  await useSpacesStore().init()
  // /manager/* 用 ManagerLayout,没有 page-tree sidebar —— 跳过页面根拉取
  // 避免无用的 cold-boot fetch。但 App.vue 的 RouterView gate 依赖
  // `pagesStore.loaded` 为 true 才渲染 manager 视图,所以用 `markLoaded()`
  // 把 flag 翻成 true 但不触发任何 fetch。LoginView 的 onSubmit 已有同样
  // gate(登录后落地),这里覆盖 reload-on-/manager 路径。用户从 /manager
  // 切到 wiki view 时,Sidebar 的 activeSpaceId watch 会兜底 ensureRootsLoaded。
  const onManagerRoute = router.currentRoute.value.path.startsWith('/manager')
  if (onManagerRoute) {
    usePagesStore().markLoaded()
  } else {
    await usePagesStore().init()
  }
})