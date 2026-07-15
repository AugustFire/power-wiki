<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import BrandLogo from '@/components/ui/BrandLogo.vue'
import TopBar from '@/components/layout/TopBar.vue'
import TopSearch from '@/components/layout/TopSearch.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import CheatSheetModal from '@/components/ui/CheatSheetModal.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
// P1-6: 自助修改姓名 / 颜色 — 顶层挂,uiStore 控制开关。
import SettingsDrawer from '@/components/layout/SettingsDrawer.vue'
import ImportMarkdownModal from '@/components/editor/ImportMarkdownModal.vue'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useAuthStore } from '@/stores/auth'
import { useNotifications } from '@/composables/useNotifications'
import { useNetworkStatus } from '@/composables/useNetworkStatus'

const uiStore = useUiStore()
const pagesStore = usePagesStore()
const authStore = useAuthStore()
const route = useRoute()

// Stage 6: kick off the notifications composable so it installs its
// `watch(auth.isAuthed)` once — login → startPolling, logout → invalidate.
// The composable is idempotent; multiple call sites can invoke it.
useNotifications()

// 监听 navigator.onLine 翻转 —— 离线时顶部显示细 banner,提示用户。
const { isOnline } = useNetworkStatus()

const { topSearchOpen, error } = storeToRefs(uiStore)
const { loading, loaded, loadError } = storeToRefs(pagesStore)
const { status: authStatus } = storeToRefs(authStore)

/**
 * Render branches:
 *
 *   1. auth initialising → centered spinner (no topbar, no layout — we don't
 *      yet know if this is /login or a protected route, so don't render
 *      either until the guard decides)
 *   2. unauthed OR on /reset-password → RouterView only. LoginView /
 *      ResetPasswordView render full-bleed (their own .login-page /
 *      .reset-page containers). /reset-password takes this branch even when
 *      authed so the page renders before the pages store hydrates — see
 *      isResetPasswordRoute below.
 *   3. transitioning → centered spinner. Set by LoginView between
 *      auth.login() resolving and router.replace() settling on the
 *      destination, AND by UserMenu between auth.logout() and the
 *      /login route settling. The `transitioning` flag alone (not gated on
 *      `isAuthed`) covers BOTH directions — otherwise the logout handoff
 *      would briefly unmount the authed shell and mount whatever the
 *      RouterView decides for the current authed route (e.g. an empty
 *      HomeView after `resetSessionState` wiped the page tree), which
 *      manifests as a white flash before the route changes to /login.
 *   4. authed → full shell with topbar + sidebar + RouterView.
 */
const isAuthed = computed(() => authStore.isAuthed)
const authInitialising = computed(
  () => authStatus.value === 'idle' || authStatus.value === 'loading',
)
const showBoot = computed(
  () => authInitialising.value || authStore.transitioning,
)
/**
 * ResetPasswordView is a full-bleed split layout (brand panel + form), not
 * a child of the app shell. It must render identically whether the user
 * arrived at /reset-password from LoginView (unauthed) or from the post-login
 * redirect (authed with mustResetPassword=true). In the latter case the auth
 * branch mounts the shell, but the pages store hasn't been init'd yet — so
 * `loaded` is false and the in-shell `<RouterView v-else-if="loaded">` would
 * skip rendering entirely, leaving a blank content area under the topbar.
 * Bypassing the shell for this route avoids that race without coupling the
 * reset flow to pages-store hydration.
 */
const isResetPasswordRoute = computed(() => route.name === 'reset-password')

/**
 * Global ⌘K / `/` shortcut — opens the top search palette from anywhere
 * in the authed shell. Skipped when focus is in a text input or contenteditable
 * (login form, editor, search box itself) so user typing is never hijacked.
 * The handler is registered even during the unauthed branch but bails out
 * silently — uiStore.openTopSearch is a no-op when there's no shell to
 * render the palette in.
 */
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (!isAuthed.value) return

  // `?` 唤起快捷键速查表 —— 故意**绕过 isTypingTarget 守卫**,跟 GitHub /
  // Slack 一致:即便用户在 Tiptap 编辑器里聚焦也应该能用。`isComposing`
  // 已经挡住 IME 进行中的问号输入,所以不会跟中文拼音冲突。
  if (e.key === '?') {
    e.preventDefault()
    if (uiStore.cheatSheetOpen) uiStore.closeCheatSheet()
    else uiStore.openCheatSheet()
    return
  }

  if (isTypingTarget(e.target)) return

  const mod = e.metaKey || e.ctrlKey
  // ⌘/ (Ctrl+/) 唤起快捷键速查表。放在 ⌘K 之前判断,因为二者都带 mod。
  // 注意:由于 isTypingTarget 守卫,这条在 Tiptap 编辑器里**不生效**(原 bug,
  // 由上面的 `?` 触发器兜底)。
  if (mod && e.key === '/') {
    e.preventDefault()
    if (uiStore.cheatSheetOpen) uiStore.closeCheatSheet()
    else uiStore.openCheatSheet()
    return
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    uiStore.openTopSearch()
    return
  }
  // Vim-style: bare "/" opens search. Shift+/ ("?") 已经被上面的分支吞掉,
  // 所以这里 e.shiftKey 必须为 false,跟 `?` 触发器不重叠。
  if (e.key === '/' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    uiStore.openTopSearch()
  }
}

onMounted(() => document.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <!-- 1. auth initialising / 3. post-login transitioning -->
  <div v-if="showBoot" class="auth-boot">
    <BrandLogo :size="48" class="ab-mark" />
    <div class="ab-spinner" aria-hidden="true"></div>
  </div>

  <!-- 2. unauthed OR on /reset-password: LoginView / ResetPasswordView render full-bleed -->
  <RouterView v-else-if="!isAuthed || isResetPasswordRoute" />

  <!-- 4. authed: full app shell -->
  <div v-else class="app-shell">
    <TopBar />

    <!-- 离线 banner —— 物理网络断开时顶部细提示,与 uiStore.error 区分:
         error-banner 是后端报错(红色,持续到清除);
         offline-banner 是 OS 层网络状态(黄色,自动随 online/offline 翻转)。
         优先级:offline > error,都显示时 offline 在上。 -->
    <div v-if="!isOnline" class="offline-banner" role="status">
      <span class="material-symbols-outlined ob-icon">wifi_off</span>
      <span class="ob-text">网络连接已断开,正在等待恢复…</span>
    </div>

    <div v-if="error" class="error-banner" role="alert">
      <span class="material-symbols-outlined eb-icon">error</span>
      <span class="eb-text">{{ error }}</span>
      <button type="button" class="eb-close" title="关闭" @click="uiStore.clearError()">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>

    <main>
      <div v-if="loading" class="page-loading">
        <div class="pl-spinner" aria-hidden="true"></div>
        <p class="pl-text">正在连接后端…</p>
      </div>

      <div v-else-if="loadError" class="page-error">
        <span class="material-symbols-outlined pe-icon">cloud_off</span>
        <h2 class="pe-title">无法连接到后端</h2>
        <p class="pe-text">{{ loadError }}</p>
        <p class="pe-hint">确认 <code>apps/api</code> 服务已启动(<code>pnpm dev</code> 会同时起 web + api)。</p>
        <button type="button" class="pe-retry" @click="pagesStore.init()">重试</button>
      </div>
      <RouterView v-else-if="loaded" v-slot="{ Component }">
        <!-- 取消 transition wrapper — 在 HomeView 内嵌 MeDashboardView(v-if)
             切换到 /p/:id 时,transition mode="out-in" 会让 leave 阶段的根 DOM
             与 enter 阶段不一致,新组件进不来,只渲染空注释。直接 component 渲染,
             RouterView 自己负责按路由切组件。 -->
        <component :is="Component" />
      </RouterView>
    </main>

    <TopSearch :open="topSearchOpen" @close="uiStore.closeTopSearch()" />
    <ConfirmDialog />
    <CheatSheetModal />
    <ToastContainer />
    <SettingsDrawer />
    <ImportMarkdownModal />
  </div>
</template>

<style scoped>
.app-shell { min-height: 100vh; }

/* ─── 启动时的鉴权检查占位 ─── */
.auth-boot {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  background: var(--bg-canvas);
}
.ab-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ab-spin 0.8s linear infinite;
}
@keyframes ab-spin { to { transform: rotate(360deg); } }

/* ─── 顶部离线 banner ───
   物理网络断开时显示,黄色调 + wifi_off 图标,
   自动随 navigator.onLine 翻转,无需手动关闭。 */
.offline-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  background: var(--warning-soft);
  color: var(--warning-text);
  font-size: var(--text-sm, 13px);
  border-bottom: 1px solid var(--warning);
}
.offline-banner .ob-icon {
  font-size: 18px;
  flex-shrink: 0;
}

/* ─── 顶部错误 banner ─── */
.error-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 24px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 14px;
  border-bottom: 1px solid var(--danger);
}
.eb-icon { font-size: 20px; flex-shrink: 0; }
.eb-text { flex: 1; }
.eb-close {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  padding: 4px;
  display: flex;
  border-radius: 4px;
}
.eb-close:hover { background: rgba(255, 86, 48, 0.12); }
.eb-close .material-symbols-outlined { font-size: 18px; }

/* ─── 加载占位 ─── */
.page-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 16px;
  color: var(--text-3);
}
.pl-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: pl-spin 0.8s linear infinite;
}
.pl-text { font-size: 14px; margin: 0; }
@keyframes pl-spin { to { transform: rotate(360deg); } }

/* ─── 加载失败 ─── */
.page-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: var(--text-2);
}
.pe-icon {
  font-size: 56px;
  color: var(--danger);
}
.pe-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}
.pe-text {
  font-size: 14px;
  margin: 0;
  color: var(--danger);
}
.pe-hint {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
  max-width: 480px;
}
.pe-hint code {
  background: var(--bg-muted);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.pe-retry {
  margin-top: 8px;
  padding: 8px 20px;
  background: var(--accent);
  color: white;
  border: 0;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.pe-retry:hover { background: var(--accent-hover); }
</style>