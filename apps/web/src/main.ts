import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { usePagesStore } from './stores/pages'
import { useSpacesStore } from './stores/spaces'
import { useAuthStore } from './stores/auth'
import { useUiStore } from './stores/ui'
import { writeJSON } from './lib/storage'
import { setUnauthorizedHandler } from './lib/api'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
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
setUnauthorizedHandler(async () => {
  const auth = useAuthStore()
  auth.user = null
  auth.mustResetPassword = false
  const redirect = router.currentRoute.value.fullPath
  await router.push({ name: 'login', query: { redirect } })
})

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
  await usePagesStore().init()
})