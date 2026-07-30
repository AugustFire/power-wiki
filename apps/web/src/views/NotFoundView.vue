<script setup lang="ts">
import { useRouter } from 'vue-router'
import BrandLogo from '@/components/ui/BrandLogo.vue'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import { useDocumentTitle } from '@/composables/useDocumentTitle'

const router = useRouter()
useDocumentTitle(() => '页面未找到')

function goHome() {
  router.push('/')
}
</script>

<template>
  <div class="notfound-shell">
    <Breadcrumb :segments="[
      { label: '我的知识库', to: '/' },
      { label: '页面不存在' },
    ]" />

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
</template>

<style scoped>
.empty.notfound { display: flex; flex-direction: column; align-items: center; }
.nf-mark { margin-bottom: 12px; }
.empty.notfound h2 { margin-top: 4px; }
.notfound-actions { margin-top: 12px; }
</style>