<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { RouterView } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import TopSearch from '@/components/layout/TopSearch.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useUiStore } from '@/stores/ui'

const uiStore = useUiStore()
const { topSearchOpen } = storeToRefs(uiStore)
</script>

<template>
  <div class="app-shell">
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
        <div class="me-av">
          <UserAvatar :size="28" />
        </div>
      </div>
    </header>

    <main>
      <RouterView v-slot="{ Component }">
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
</style>
