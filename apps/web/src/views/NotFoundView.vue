<script setup lang="ts">
/**
 * NotFoundView — catch-all 404(`/:pathMatch(.*)*`,requiresAuth)。
 *
 * 模块 2 P0(2.5)改造要点:
 *   1. 正文换 `.content-inner` 容器,不再用全局 `.empty`(它带
 *      `min-height: calc(100vh - topbar - sub)` + `justify-content:center`,
 *      在 2560×1440 视口下整块飘在屏幕正中,视觉上像「应用崩了」而不是
 *      「这一页不存在」)。顶部对齐后跟 ReadView / WatchedView 等
 *      同一套 chrome 节奏。
 *   2. 显式回显失效路径(mono 字体 + 灰底 chip)—— 用户从别人分享的链接
 *      过来时,「我点的到底是什么」是第一诉求;同时方便他把这段贴回群里
 *      问原作者。
 *   3. 双 CTA:返回首页 + 搜索页面(`uiStore.openTopSearch()`,跟 TopBar
 *      的 ⌘K 同一个入口)。原来只有「返回首页」,是死路一条 —— 用户想找
 *      的页面可能只是被改名 / 移动了,搜索比回首页再手动翻树高效。
 *   4. 下方「最近访问」列表(useRecentPages 前 5 条)—— Confluence / Notion
 *      404 的标配。让用户一键跳回刚才的上下文,不必重新导航。
 *
 * 去掉了原来的 `<BrandLogo>` —— TopBar 里已经有一份品牌标识,404 正文再挂
 * 一个反而强化「这是一个独立的错误页」的错觉,跟改造目标(它是 app 内的
 * 一个普通空态)相反。404 SVG 插画保留,它是这个页面唯一的强信号。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Space } from '@power-wiki/shared'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { useRecentPages } from '@/composables/useRecentPages'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { formatRelativeTime } from '@/lib/relativeTime'

const router = useRouter()
const route = useRoute()
const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const uiStore = useUiStore()
const { list: recentList } = useRecentPages()

useDocumentTitle(() => '页面未找到')

/** 失效路径回显。用 `route.fullPath` 而不是 `location.pathname` —— 路由是
 *  hash history(见 router/index.ts),pathname 永远是 `/`,拿不到用户
 *  真正访问的那段。fullPath 已含 query,正是用户手里那条链接的内容。 */
const failedPath = computed(() => route.fullPath)

const spaceById = computed<Map<string, Space>>(() => {
  const result = new Map<string, Space>()
  for (const space of spacesStore.spaces.value) result.set(space.id, space)
  return result
})

/**
 * 最近访问前 5 条。跟 PersonalHomeView 同一套 spaceId 取值优先级
 * (entry 自带 → pagesStore lookup → null),但这里**过滤掉 dead row**
 * ——404 页的 CTA 语义是「换条路走」,给一行点不动的灰条只会二次挫败;
 * PersonalHomeView 保留 dead row 是因为那是「我的历史」有记录价值。
 */
const recentItems = computed(() =>
  recentList.value
    .map((entry) => {
      const page = pagesStore.getPage(entry.id)
      return {
        id: entry.id,
        title: page?.title || entry.title,
        spaceId: entry.spaceId ?? page?.spaceId ?? null,
        timestamp: entry.visitedAt,
        alive: !!page && !page.deletedAt,
      }
    })
    .filter((item) => item.alive)
    .slice(0, 5),
)

function spaceOf(spaceId: string | null): Space | null {
  if (!spaceId) return null
  return spaceById.value.get(spaceId) ?? null
}

function goHome() {
  router.push('/')
}

function openRecent(item: { id: string; spaceId: string | null }) {
  if (item.spaceId && spacesStore.activeSpaceId.value !== item.spaceId) {
    spacesStore.setActiveSpace(item.spaceId)
  }
  void router.push(`/p/${item.id}`)
}

function relativeTime(timestamp: number): string {
  return formatRelativeTime(timestamp)
}
</script>

<template>
  <div class="notfound-shell">
    <Breadcrumb :segments="[
      { label: '我的知识库', to: '/' },
      { label: '页面不存在' },
    ]" />

    <div class="content-inner notfound-page">
      <div class="nf-hero">
        <svg viewBox="0 0 240 160" width="220" height="146" aria-hidden="true">
          <circle cx="120" cy="80" r="56" fill="#FFEBE6" />
          <text x="120" y="98" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="42" font-weight="700" fill="#FF5630">404</text>
          <path d="M 60 50 L 80 30" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
          <path d="M 180 50 L 160 30" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
          <path d="M 64 110 L 80 110" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
          <path d="M 176 110 L 160 110" stroke="#DFE1E6" stroke-width="3" stroke-linecap="round" />
        </svg>
        <h1 class="nf-title">找不到这个页面</h1>
        <p class="nf-hint">页面可能已被删除或移动,也可能是链接地址有误。</p>
        <code class="nf-path">{{ failedPath }}</code>
        <div class="nf-actions">
          <button class="btn primary" type="button" @click="goHome">返回首页</button>
          <button class="btn" type="button" @click="uiStore.openTopSearch()">
            <span class="material-symbols-outlined icon-md">search</span>
            搜索页面
          </button>
        </div>
      </div>

      <section class="nf-recent" aria-label="最近访问">
        <header class="nf-recent-head">
          <span class="material-symbols-outlined nf-recent-icon">history</span>
          最近访问
        </header>
        <ul v-if="recentItems.length > 0" class="nf-recent-list">
          <li v-for="item in recentItems" :key="item.id">
            <button type="button" class="nf-recent-row" @click="openRecent(item)">
              <SpaceAvatar
                v-if="spaceOf(item.spaceId)"
                :space="spaceOf(item.spaceId)"
                :size="20"
                class="nf-recent-avatar"
              />
              <span v-else class="material-symbols-outlined nf-recent-fallback">description</span>
              <span class="nf-recent-title">{{ item.title }}</span>
              <span class="nf-recent-meta">{{ relativeTime(item.timestamp) }}</span>
            </button>
          </li>
        </ul>
        <EmptyState
          v-else
          icon="history"
          title="暂无最近访问"
          hint="打开过的页面会按访问时间显示在这里。"
          size="sm"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 收窄到 720px —— 404 是「一句话 + 几个出口」的窄内容,继承
   .content-inner 的 1680px 会让 CTA 和最近访问列表横向拉得过散。
   margin: 0 auto 由 .content-inner 提供。 */
.notfound-page {
  max-width: 720px;
  padding-top: 56px;
}

.nf-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.nf-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-1);
  margin: 8px 0 0;
}

.nf-hint {
  font-size: var(--text-sm);
  color: var(--text-2);
  margin: 8px 0 0;
  max-width: 400px;
}

/* 失效路径 chip —— mono 字体 + 灰底,视觉上明确是「一段字面量」而不是
   正文。long path 允许换行(break-all),不让它撑破 720px 容器。 */
.nf-path {
  margin-top: 16px;
  padding: 4px 10px;
  max-width: 100%;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text-2);
  word-break: break-all;
}

.nf-actions {
  display: flex;
  gap: 8px;
  margin-top: 24px;
}

/* 最近访问块 —— 上方 40px 留白 + 顶部分隔线,跟 hero 明确分层
   (hero 是「出了什么事」,这里是「你可以去哪」)。 */
.nf-recent {
  margin-top: 40px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}

.nf-recent-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.nf-recent-icon {
  font-size: 16px;
}

.nf-recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.nf-recent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--text-sm);
  color: var(--text-1);
  transition: background-color var(--duration-fast) var(--ease-out);
}
.nf-recent-row:hover {
  background: var(--bg-subtle);
}

.nf-recent-avatar,
.nf-recent-fallback {
  flex: 0 0 auto;
}
.nf-recent-fallback {
  font-size: 20px;
  color: var(--text-3);
}

.nf-recent-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nf-recent-meta {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-3);
}
</style>
