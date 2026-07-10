<script setup lang="ts">
/**
 * Sidebar "我的关注" section —— M13。
 *
 * 设计参考 design/wiki-read.html:317 (sidebar 「已加星标」section):
 *   - plain 标题 + icon(visibility)
 *   - row 用 PageTree 同款 `.tree-row` 视觉(28px 高 / 14px 字号 / 18px doc-icon)
 *   - active row 用 accent-soft
 *
 * 数据来源:`GET /api/users/me/watched?space=<activeSpaceId>&limit=5`。
 * Scope 锁死当前空间(2026-07-10 锁定 spec),换空间时重新拉。`space === null`
 * 时(active space 还没解析出来)静默渲染空态 placeholder。
 *
 * 行为:
 *   - 当前空间下我关注的 page 列表,上限 5 条,按 watched_at DESC
 *   - 每行 = doc-icon + 标题(单行 truncate,跟设计稿一致)
 *   - 点击行 → /p/<id>
 *   - 当前页面那条:高亮
 *   - > 5 条:底部 "查看全部" 链接 → /me/watched
 *   - 0 条:显示一行 "暂无关注"(行高 28 / padding 0 8px 0 4px,跟 row 同起点)
 *
 * 刷新 trigger:
 *   - activeSpaceId 变化(切空间)
 *   - pagesStore.watchVersion 变化(本页或任何其他页的 watch/unwatch 操作)
 *
 * 缓存:api.users.me.watched() 走 GET 30s 缓存 + api.pages.watch/unwatch 命中
 * 后 invalidatePrefix('/users/me/watched') → 自动刷新一次。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import type { PageNode } from '@power-wiki/shared'

const router = useRouter()
const route = useRoute()
const spaces = useSpacesStore()
const pagesStore = usePagesStore()

const activeSpaceId = computed(() => spaces.activeSpaceId.value)

const items = ref<PageNode[]>([])
const total = ref(0)
const loading = ref(false)

const currentPageId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? id : ''
})

const hasItems = computed(() => items.value.length > 0)
const showAll = computed(() => total.value > items.value.length)

async function load() {
  const sid = activeSpaceId.value
  if (!sid) {
    items.value = []
    total.value = 0
    return
  }
  loading.value = true
  try {
    const r = await api.users.me.watched({
      spaceId: sid,
      limit: 5,
      offset: 0,
    })
    items.value = r.items
    total.value = r.hasMore ? r.items.length + 1 : r.items.length
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
watch(activeSpaceId, () => void load())
// pagesStore.watchVersion 在每次成功 toggle 后 +1 —— 触发本页(或别的页)
// 关注状态变化时立即重新拉取,保证侧栏始终跟 server 同步。
watch(() => pagesStore.watchVersion, () => void load())

function goPage(pageId: string) {
  router.push(`/p/${pageId}`)
}
</script>

<template>
  <div class="sidebar-section watched-section">
    <div class="sidebar-section-title">
      <span>
        <span class="material-symbols-outlined section-icon">visibility</span>
        我的关注
      </span>
    </div>

    <div v-if="loading && !hasItems" class="watched-empty">加载中…</div>
    <div v-else-if="!hasItems" class="watched-empty">暂无关注</div>

    <div v-else class="watched-list">
      <button
        v-for="p in items"
        :key="p.id"
        type="button"
        class="watched-row"
        :class="{ active: p.id === currentPageId }"
        :title="p.title"
        @click="goPage(p.id)"
      >
        <span class="material-symbols-outlined watched-icon">description</span>
        <span class="watched-title">{{ p.title }}</span>
      </button>
      <RouterLink
        v-if="showAll"
        to="/me/watched"
        class="watched-all"
      >
        查看全部
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
/* 跟 PageTree .tree-row 视觉对齐(components.css:294 起):
   height 28 / padding 0 8px 0 4px / font-size 14。
   icon 用 18px(doc-icon 同款),title 14px(.label 同款)。
   空态也用同 padding + 28px min-height,保证 "暂无关注" 跟 row 起点 X 对齐。 */

.watched-empty {
  min-height: 28px;
  line-height: 28px;
  padding: 0 8px 0 12px;
  font-size: 12px;
  color: var(--text-3);
}

.watched-list {
  display: flex;
  flex-direction: column;
}

.watched-row {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 8px 0 4px;
  border-radius: var(--radius);
  background: transparent;
  border: 0;
  font: inherit;
  cursor: pointer;
  text-align: left;
  width: 100%;
  color: var(--text-2);
  transition: background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.watched-row:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}

.watched-row.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.watched-icon {
  font-size: 18px;
  color: var(--text-3);
  flex-shrink: 0;
  margin-right: 4px;
}
.watched-row:hover .watched-icon,
.watched-row.active .watched-icon {
  color: var(--accent);
}

.watched-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.watched-all {
  display: inline-block;
  padding: 4px 8px 4px 12px;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}
.watched-all:hover {
  text-decoration: underline;
}
</style>