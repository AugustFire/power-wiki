<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import BrandLogo from '@/components/ui/BrandLogo.vue'
import AppShell from '@/components/layout/AppShell.vue'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useNotifications } from '@/composables/useNotifications'

const uiStore = useUiStore()
const authStore = useAuthStore()
const route = useRoute()

useNotifications()

const { status: authStatus } = storeToRefs(authStore)
const isAuthed = computed(() => authStore.isAuthed)
const isPublicPageRoute = computed(() => route.name === 'public-page')
const authInitialising = computed(
  () => authStatus.value === 'idle' || authStatus.value === 'loading',
)
const showBoot = computed(
  () => !isPublicPageRoute.value && (authInitialising.value || authStore.transitioning),
)
const isResetPasswordRoute = computed(() => route.name === 'reset-password')

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (!isAuthed.value) return

  const modEarly = e.metaKey || e.ctrlKey
  if (modEarly && (e.key === '/' || e.key === '?')) {
    e.preventDefault()
    if (uiStore.cheatSheetOpen) uiStore.closeCheatSheet()
    else uiStore.openCheatSheet()
    return
  }

  if (isTypingTarget(e.target)) return

  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    uiStore.openTopSearch()
    return
  }
  if (e.key === '/' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    uiStore.openTopSearch()
  }
}

onMounted(() => document.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <div v-if="showBoot" class="auth-boot">
    <BrandLogo :size="48" class="ab-mark" />
    <div class="ab-spinner" aria-hidden="true"></div>
  </div>

  <RouterView v-else-if="isPublicPageRoute || !isAuthed || isResetPasswordRoute" />

  <AppShell v-else />
</template>

<style scoped>
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
</style>
