<script setup lang="ts">
/**
 * WatchedView — /me/watched 完整关注页面(M13 Phase 7)。
 *
 * 与 Sidebar 的 WatchedSidebar 区别:
 *   - WatchedSidebar:space-scoped,只显示当前空间;上限 5 条;嵌入左栏
 *   - WatchedView(本页): 全空间,不设上限,paginated
 *
 * 数据:`GET /api/users/me/watched` —— 不带 space 过滤,后端返回当前用户
 * 全部被关注的页面(走空间可见性过滤,见 apps/api/src/routes/users.ts
 * GET /me/watched 注释)。每页 30,load more append。
 *
 * 不挂在 /me 下面作为 tab:2026-07-10 锁定 SPEC 把 /me 留给 M2 的 Dashboard
 * 接管;M13 阶段先做独立可访问页,Sidebar「查看全部」链接到这里。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/lib/api'
import Sidebar from '@/components/layout/Sidebar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useSpacesStore } from '@/stores/spaces'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { formatRelativeTime } from '@/lib/relativeTime'
import { usePagesStore } from '@/stores/pages'
import type { PageNode } from '@power-wiki/shared'

const route = useRoute()
const router = useRouter()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
useDocumentTitle(() => '我的关注')

const PAGE_SIZE = 30
const items = ref<PageNode[]>([])
const offset = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const loadError = ref<string | null>(null)

/** Map pageId → space,渲染每行的「space chip」 + 切换 active space 后跳。 */
const spaceById = computed(() => {
  const m = new Map<string, (typeof spacesStore.spaces.value)[number]>()
  for (const s of spacesStore.spaces.value) m.set(s.id, s)
  return m
})

async function loadFirstPage() {
  loading.value = true
  loadError.value = null
  try {
    const r = await api.users.me.watched({
      limit: PAGE_SIZE,
      offset: 0,
    })
    items.value = r.items
    offset.value = r.items.length
    hasMore.value = r.hasMore
    // 顺手让 pages store 知道这些页面 id,让 Sidebar 树能立刻匹配
    for (const p of r.items) pagesStore.syncPageFromServer(p)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const r = await api.users.me.watched({
      limit: PAGE_SIZE,
      offset: offset.value,
    })
    items.value.push(...r.items)
    offset.value += r.items.length
    hasMore.value = r.hasMore
    for (const p of r.items) pagesStore.syncPageFromServer(p)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '加载更多失败'
  } finally {
    loadingMore.value = false
  }
}

onMounted(async () => {
  if (!spacesStore.loaded) {
    try { await spacesStore.init() } catch { /* 留待 UI 渲染错误 */ }
  }
  if (!pagesStore.loaded) {
    try { await pagesStore.init() } catch { /* 同上 */ }
  }
  await loadFirstPage()
})

// 路由 fullPath 变化触发重新拉 — 同 ActivityView 模式,future-proof keep-alive
watch(() => route.fullPath, () => void loadFirstPage())

function openPage(p: PageNode) {
  // 切到页面所在空间 — Sidebar autoExpandAndLocate 会展开祖先。
  if (spacesStore.activeSpaceId.value !== p.spaceId) {
    spacesStore.setActiveSpace(p.spaceId)
  }
  void router.push(`/p/${p.id}`)
}

function spaceChip(p: PageNode): { name: string; color: string; isPersonal: boolean } | null {
  const s = spaceById.value.get(p.spaceId)
  if (!s) return null
  return {
    name: s.name,
    color: s.color,
    isPersonal: s.kind === 'personal',
  }
}
</script>

<template>
  <div class="read-shell">
    <div class="subheader">
      <div class="breadcrumb">
        <a href="#/">我的知识库</a>
        <span class="sep">/</span>
        <span class="crumb-item current">我的关注</span>
      </div>
    </div>

    <div class="layout">
      <Sidebar />
      <div class="content">
        <div class="content-inner watched-page">
          <h1 class="page-title">我的关注</h1>
          <p class="watched-hint">
            所有我关注的页面(跨空间)。点击标题进入,顶部 👁 按钮可取消关注。
          </p>

          <Skeleton v-if="loading" :count="6" height="48px" />
          <div v-else-if="loadError" class="empty error">
            <p>加载失败:{{ loadError }}</p>
            <button class="btn ghost" @click="loadFirstPage">重试</button>
          </div>
          <EmptyState
            v-else-if="items.length === 0"
            icon="visibility"
            title="还没有关注任何页面"
            message="在任意页面右上角点 👁 即可关注。编辑、改名、移动、删除都会通知你。"
          />
          <div v-else class="watched-list">
            <button
              v-for="p in items"
              :key="p.id"
              type="button"
              class="watched-card"
              @click="openPage(p)"
            >
              <div class="watched-card-row1">
                <span class="material-symbols-outlined doc-icon">description</span>
                <span class="watched-card-title">{{ p.title }}</span>
                <span v-if="spaceChip(p)" class="watched-space-chip" :style="{ background: spaceChip(p)!.color + '22', color: spaceChip(p)!.color }">
                  {{ spaceChip(p)!.name }}
                </span>
              </div>
              <div class="watched-card-row2">
                <span v-if="p.authorName" class="watched-card-author">{{ p.authorName }} ·</span>
                <span>更新于 {{ formatRelativeTime(p.updatedAt) }}</span>
              </div>
            </button>

            <div v-if="hasMore" class="watched-loadmore">
              <button
                class="btn ghost"
                :disabled="loadingMore"
                @click="loadMore"
              >
                {{ loadingMore ? '加载中…' : '加载更多' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.read-shell { min-height: calc(100vh - var(--topbar-h)); }
.watched-page { padding-top: 24px; max-width: 880px; }

.page-title {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text-1);
}

.watched-hint {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 24px;
}

.watched-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.watched-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background var(--duration-fast), border-color var(--duration-fast);
}
.watched-card:hover {
  background: var(--bg-subtle);
  border-color: var(--accent);
}

.watched-card-row1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.watched-card-row2 {
  font-size: 12px;
  color: var(--text-3);
}

.doc-icon {
  font-size: 18px;
  color: var(--text-3);
  flex-shrink: 0;
}
.watched-card:hover .doc-icon { color: var(--accent); }

.watched-card-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.watched-space-chip {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}

.watched-card-author {
  color: var(--text-2);
  margin-right: 2px;
}

.watched-loadmore {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}

.empty.error {
  text-align: center;
  padding: 32px 0;
  color: var(--text-3);
}
</style>
