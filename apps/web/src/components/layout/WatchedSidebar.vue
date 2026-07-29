<script setup lang="ts">
/**
 * Sidebar "此空间的关注" section —— M13。
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
import { useUiStore } from '@/stores/ui'
import SidebarSectionHeader from './SidebarSectionHeader.vue'
import type { PageNode } from '@power-wiki/shared'

const router = useRouter()
const route = useRoute()
const spaces = useSpacesStore()
const pagesStore = usePagesStore()
const uiStore = useUiStore()

const activeSpaceId = computed(() => spaces.activeSpaceId.value)

/** 默认折叠 —— sticky 顶部 + 此空间的关注三块(section 自带 chrome)视觉统一
 *  但默认收起,只有「我的工作台」常驻入口。其余按用户兴趣展开,避免
 *  sidebar 顶部 + 底部出现多个始终展开的辅助列表互相争屏。
 *  2026-07-29:折叠态挪进 uiStore 持久化 —— 刷新后保留用户偏好,跟
 *  「此空间的页面」共用同一套 section 折叠机制。 */
const SECTION_KEY = 'watched'
const collapsed = computed(() => uiStore.isSectionCollapsed(SECTION_KEY, true))
const expanded = computed(() => !collapsed.value)

function toggle(): void {
  uiStore.toggleSection(SECTION_KEY, true)
}

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
    // P1-9: 后端 /users/me/watched 偶发返回 soft-deleted pages(PIN 过的页
    // 被删后,watch 记录还在)。这里过滤 deletedAt,跟 sidebar 顶部其它
    // 两块(pinned / recents)同款:trashed 不该出现在 sidebar 关注列表。
    // 改用服务端彻底过滤是后续优化项(GET 时 JOIN pages 的 deletedAt);
    // 当前已是 5 条 limit,前端 filter 不会让 UI 短于 5 条显著变空(分页
    // 兜底)。
    items.value = r.items.filter((p) => p.deletedAt == null)
    total.value = r.hasMore ? items.value.length + 1 : items.value.length
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
    <!-- 2026-07-29:「我的关注」→「此空间的关注」。
         数据来源 GET /api/users/me/watched?space=<activeSpaceId>,是按
         active space 过滤的子集(不在当前空间内被 watch 的页不显示),
         跟「此空间的页面」共享同一 scope 语言:
         - 「此空间的页面」= 当前空间所有可见页(全局)
         - 「此空间的关注」= 当前空间里我 watch 过的页(子集)
         底部「查看全部」继续跳 /me/watched(全空间汇总),从子集 → 全集
         形成清晰的二级跳转。标题栏走共用的 SidebarSectionHeader,跟
        「此空间的页面」同一份结构 + 样式。 -->
    <SidebarSectionHeader
      icon="visibility"
      label="此空间的关注"
      :count="hasItems ? items.length : null"
      :collapsed="collapsed"
      @toggle="toggle"
    />

    <template v-if="expanded">
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
    </template>
  </div>
</template>

<style scoped>
/* 标题栏样式全部搬进 SidebarSectionHeader.vue —— 两块 section 共用一份,
   不再在这里覆写 .sidebar-section-title。 */

/* Empty state —— padding 0 8px 0 20px 让"暂无关注"跟 watched-row 文字
   起点对齐(2026-07-29:跟 tree-row 缩进一起右移,确保 empty state 跟 row
   同 X 起点)。 */
.watched-empty {
  min-height: 28px;
  line-height: 28px;
  padding: 0 8px 0 20px;
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
  /* 2026-07-29:padding-left 20px(原 8px) —— 跟 .tree-row 缩进对齐。
     tree-row 在 P1-9 修完 accent-bar / caret 间距后整体右移 12px,doc-
     icon 起点落在 sidebar-x=32;watched-row 没跟上,doc-icon 还在老的
     sidebar-x=20,两个 list 在视觉上错开 12px。统一到 sidebar-x=32 让
     「此空间的页面」跟「此空间的关注」下面的 row 起点 X 完全对齐。 */
  padding: 0 8px 0 20px;
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