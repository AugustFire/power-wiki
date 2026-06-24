<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">P</span>
        <span class="brand-name">power-wiki</span>
      </div>
      <div class="global-search">
        <span class="material-symbols-outlined icon">search</span>
        <input type="text" placeholder="搜索页面、附件、人员…" />
      </div>
      <div class="topbar-right">
        <button class="icon-btn" title="通知" disabled>
          <span class="material-symbols-outlined">notifications</span>
        </button>
        <button class="icon-btn" title="帮助" disabled>
          <span class="material-symbols-outlined">help</span>
        </button>
        <button class="icon-btn" title="更多" disabled>
          <span class="material-symbols-outlined">more_horiz</span>
        </button>
        <div class="me-av" title="我">ME</div>
      </div>
    </header>

    <main>
      <RouterView v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.app-shell { min-height: 100vh; }
</style>