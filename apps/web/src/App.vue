<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { RouterView } from 'vue-router'
import UserMenu from '@/components/ui/UserMenu.vue'
import TopSearch from '@/components/layout/TopSearch.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useAuthStore } from '@/stores/auth'

const uiStore = useUiStore()
const pagesStore = usePagesStore()
const authStore = useAuthStore()

const { topSearchOpen, error } = storeToRefs(uiStore)
const { loading, loaded, loadError } = storeToRefs(pagesStore)
const { status: authStatus } = storeToRefs(authStore)

/**
 * Three render branches:
 *
 *   1. auth initialising → centered spinner (no topbar, no layout — we don't
 *      yet know if this is /login or a protected route, so don't render
 *      either until the guard decides)
 *   2. unauthed → RouterView only. LoginView / ResetPasswordView render
 *      full-bleed (their own .login-page / .reset-page containers).
 *   3. authed → full shell with topbar + sidebar + RouterView.
 */
const isAuthed = computed(() => authStore.isAuthed)
const authInitialising = computed(
  () => authStatus.value === 'idle' || authStatus.value === 'loading',
)
</script>

<template>
  <!-- 1. auth initialising -->
  <div v-if="authInitialising" class="auth-boot">
    <div class="ab-spinner" aria-hidden="true"></div>
  </div>

  <!-- 2. unauthed: LoginView / ResetPasswordView render full-bleed -->
  <RouterView v-else-if="!isAuthed" />

  <!-- 3. authed: full app shell -->
  <div v-else class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">P</span>
        <span class="brand-name">power-wiki</span>
      </div>
      <button
        type="button"
        class="global-search"
        title="搜索所有页面"
        @click="uiStore.openTopSearch()"
      >
        <span class="material-symbols-outlined icon">search</span>
        <span class="gs-placeholder">搜索所有页面…</span>
        <kbd class="gs-kbd">⌘K</kbd>
      </button>
      <div class="topbar-right">
        <UserMenu />
      </div>
    </header>

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
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </RouterView>
    </main>

    <TopSearch :open="topSearchOpen" @close="uiStore.closeTopSearch()" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.app-shell { min-height: 100vh; }

/* ─── 启动时的鉴权检查占位 ─── */
.auth-boot {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas, #F4F5F7);
}
.ab-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--border, #DFE1E6);
  border-top-color: var(--accent, #0052CC);
  border-radius: 50%;
  animation: ab-spin 0.8s linear infinite;
}
@keyframes ab-spin { to { transform: rotate(360deg); } }

/* ─── 顶部错误 banner ─── */
.error-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 24px;
  background: var(--danger-soft, #FFEBE6);
  color: var(--danger, #FF5630);
  font-size: 14px;
  border-bottom: 1px solid var(--danger, #FF5630);
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
  color: var(--text-3, #6B778C);
}
.pl-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--border, #DFE1E6);
  border-top-color: var(--accent, #0052CC);
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
  color: var(--text-2, #44546F);
}
.pe-icon {
  font-size: 56px;
  color: var(--danger, #FF5630);
}
.pe-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-1, #172B4D);
  margin: 0;
}
.pe-text {
  font-size: 14px;
  margin: 0;
  color: var(--danger, #FF5630);
}
.pe-hint {
  font-size: 13px;
  color: var(--text-3, #6B778C);
  margin: 0;
  max-width: 480px;
}
.pe-hint code {
  background: var(--bg-muted, #F4F5F7);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.pe-retry {
  margin-top: 8px;
  padding: 8px 20px;
  background: var(--accent, #0052CC);
  color: white;
  border: 0;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.pe-retry:hover { background: var(--accent-hover, #0747A6); }
</style>