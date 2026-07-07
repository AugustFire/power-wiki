<script setup lang="ts">
/**
 * TopBar — the 56px global header.
 *
 * Three regions, left → right:
 *   1. Brand mark + space switcher (current scope indicator)
 *   2. Global search trigger (opens TopSearch via uiStore; ⌘K is handled
 *      globally in App.vue's keydown listener)
 *   3. User menu (sign-out, profile)
 *
 * Lives at the top of the authed app shell. The error banner and page
 * content sit below — those stay in App.vue since they're driven by
 * other stores.
 */
import BrandLogo from '@/components/ui/BrandLogo.vue'
import SpaceSwitcher from '@/components/layout/SpaceSwitcher.vue'
import UserMenu from '@/components/ui/UserMenu.vue'
import NotificationBell from '@/components/layout/NotificationBell.vue'
import HelpButton from '@/components/layout/HelpButton.vue'
import { useUiStore } from '@/stores/ui'

const uiStore = useUiStore()
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <BrandLogo :size="24" with-wordmark class="topbar-logo" />
      <span class="brand-divider" aria-hidden="true"></span>
      <SpaceSwitcher />
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
      <HelpButton />
      <NotificationBell />
      <UserMenu />
    </div>
  </header>
</template>

<style scoped>
.topbar-logo { flex-shrink: 0; }
</style>