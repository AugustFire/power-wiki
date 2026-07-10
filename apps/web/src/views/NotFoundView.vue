<script setup lang="ts">
import { useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import BrandLogo from '@/components/ui/BrandLogo.vue'
import { useDocumentTitle } from '@/composables/useDocumentTitle'

const router = useRouter()
useDocumentTitle(() => '页面未找到')

function goHome() {
  router.push('/')
}
</script>

<template>
  <div class="notfound-shell">
    <div class="subheader">
      <div class="breadcrumb">
        <a href="#/">我的知识库</a>
        <span class="sep">/</span>
        <span class="crumb-item current">页面不存在</span>
      </div>
    </div>

    <div class="layout no-toc">
      <Sidebar />

      <div class="content">
        <div class="empty notfound">
          <BrandLogo :size="32" class="nf-mark" />
          <div class="empty-illustration">
            <svg viewBox="0 0 240 160" width="220" height="146" aria-hidden="true">
              <circle cx="120" cy="80" r="56" fill="#FFEBE6" />
              <text x="120" y="98" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="42" font-weight="700" fill="#FF5630">404</text>
              <path d="M 60 50 L 80 30" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
              <path d="M 180 50 L 160 30" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
              <path d="M 64 110 L 80 110" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
              <path d="M 176 110 L 160 110" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
            </svg>
          </div>
          <h2>找不到这个页面</h2>
          <p>你访问的链接已失效,或地址输入有误。</p>
          <div class="notfound-actions">
            <button class="btn primary" @click="goHome">返回首页</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notfound-shell { min-height: calc(100vh - var(--topbar-h)); }
.empty.notfound { display: flex; flex-direction: column; align-items: center; }
.nf-mark { margin-bottom: 12px; }
.empty.notfound h2 { margin-top: 4px; }
.notfound-actions { margin-top: 12px; }
</style>