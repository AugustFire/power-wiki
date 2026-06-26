import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { usePagesStore } from './stores/pages'
import { useSpacesStore } from './stores/spaces'
import { useAuthStore } from './stores/auth'
import { useUiStore } from './stores/ui'
import { writeJSON } from './lib/storage'

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