import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { usePagesStore } from './stores/pages'
import { useUiStore } from './stores/ui'
import { hasKey, writeJSON } from './lib/storage'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import 'tippy.js/dist/tippy.css'

const KEY_EXPANDED = 'power-wiki:tree-expanded'

const app = createApp(App)
app.use(createPinia())
app.use(router)

router.isReady().then(() => {
  const pagesStore = usePagesStore()
  pagesStore.init()
  // ui store 实例化以触发持久化监听,并确保 tree-expanded key 立即写入
  const uiStore = useUiStore()
  void uiStore
  if (!hasKey(KEY_EXPANDED)) writeJSON(KEY_EXPANDED, [])
  app.mount('#app')
})