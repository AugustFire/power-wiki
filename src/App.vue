<script setup lang="ts">
import { ref } from 'vue'
import { RouterView } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import TopSearch from '@/components/layout/TopSearch.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

const searchOpen = ref(false)

function openSearch() {
  searchOpen.value = true
}
function closeSearch() {
  searchOpen.value = false
}
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
        title="搜索页面 (Enter 打开)"
        @click="openSearch"
      >
        <span class="material-symbols-outlined icon">search</span>
        <span class="gs-placeholder">搜索页面、附件、人员…</span>
        <kbd class="gs-kbd">/</kbd>
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

    <TopSearch :open="searchOpen" @close="closeSearch" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.app-shell { min-height: 100vh; }
</style>
