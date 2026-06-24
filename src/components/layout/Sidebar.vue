<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useUiStore } from '@/stores/ui'
import PageTree from './PageTree.vue'

const pagesStore = usePagesStore()
const uiStore = useUiStore()
const router = useRouter()

const tree = computed(() => pagesStore.getTree())

const totalPages = computed(() => pagesStore.pages.length)

function createRoot() {
  uiStore.closeMenu()
  const p = pagesStore.createPage({ parentId: null })
  router.push(`/p/${p.id}/edit`)
}
</script>

<template>
  <aside class="sidebar">
    <div class="space-card">
      <div class="space-avatar">KB</div>
      <div class="space-info">
        <div class="space-name">我的知识库</div>
        <div class="space-meta">{{ totalPages }} 个页面</div>
      </div>
      <button class="icon-btn space-settings" title="空间设置(即将上线)">
        <span class="material-symbols-outlined" style="font-size:18px">settings</span>
      </button>
    </div>

    <div class="quick-nav">
      <a class="quick-nav-item" href="#/">
        <span class="material-symbols-outlined">home</span>
        <span>首页</span>
      </a>
      <a class="quick-nav-item" href="#/" :class="{ disabled: true }" title="即将上线">
        <span class="material-symbols-outlined">star</span>
        <span>已加星标</span>
        <span class="coming-soon">即将上线</span>
      </a>
      <a class="quick-nav-item" href="#/" :class="{ disabled: true }" title="即将上线">
        <span class="material-symbols-outlined">edit_note</span>
        <span>我的草稿</span>
        <span class="coming-soon">即将上线</span>
      </a>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-title">
        <span>
          <span class="material-symbols-outlined section-icon">layers</span>
          页面树
        </span>
        <span class="count">{{ totalPages }}</span>
      </div>
      <div v-if="tree.length === 0" class="tree-empty">
        <div class="tree-empty-icon">
          <span class="material-symbols-outlined" style="font-size:24px">inbox</span>
        </div>
        <div class="tree-empty-text">还没有页面</div>
        <button class="tree-empty-cta" @click="createRoot">
          <span class="material-symbols-outlined" style="font-size:14px">add</span>
          创建第一个
        </button>
      </div>
      <div v-else class="tree">
        <PageTree
          v-for="root in tree"
          :key="root.id"
          :node="root"
        />
      </div>
    </div>

    <div class="sidebar-bottom">
      <button class="create-page-btn" @click="createRoot">
        <span class="material-symbols-outlined" style="font-size:18px">add</span>
        创建页面
        <kbd>/</kbd>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.space-card { position: relative; }
.space-settings {
  width: 24px; height: 24px;
  border-radius: var(--radius);
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}
.space-card:hover .space-settings { opacity: 1; }
.space-settings:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}

.quick-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 20px;
}
.quick-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 14px;
  text-decoration: none;
  transition: all 0.1s;
  position: relative;
}
.quick-nav-item:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
  text-decoration: none;
}
.quick-nav-item.disabled { color: var(--text-3); cursor: default; }
.quick-nav-item.disabled:hover { background: transparent; }
.quick-nav-item .material-symbols-outlined {
  font-size: 18px;
  color: var(--text-3);
}
.quick-nav-item:hover .material-symbols-outlined { color: var(--text-1); }
.quick-nav-item .coming-soon {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 500;
}

.section-icon {
  font-size: 14px !important;
  color: var(--text-3);
  vertical-align: -2px;
  margin-right: 4px;
}

.sidebar-section-title .count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}

.tree-empty {
  padding: 16px 4px 4px;
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
}
.tree-empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--bg-subtle);
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 10px;
}
.tree-empty-text {
  color: var(--text-3);
  font-size: 13px;
  margin-bottom: 10px;
}
.tree-empty-cta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
}
.tree-empty-cta:hover {
  background: var(--accent);
  color: white;
}

.create-page-btn {
  position: relative;
  font-weight: 500;
}
.create-page-btn kbd {
  margin-left: auto;
  background: rgba(0, 82, 204, 0.08);
  color: var(--accent);
  border-color: transparent;
}
.create-page-btn:hover kbd {
  background: rgba(255, 255, 255, 0.25);
  color: white;
}
</style>