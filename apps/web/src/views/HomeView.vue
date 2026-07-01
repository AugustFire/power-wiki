<script setup lang="ts">
import { computed } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { useRouter } from 'vue-router'
import { newId } from '@/lib/id'
import Sidebar from '@/components/layout/Sidebar.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { excerpt as makeExcerpt } from '@/lib/textMetrics'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const uiStore = useUiStore()
const router = useRouter()

// Stage 4c: Home is scoped to the active space. Stats / root list / recents
// all filter by activeSpaceId — switching spaces from the sidebar refreshes
// the home view without a network call.
const activeSpaceId = computed(() => spacesStore.activeSpaceId.value)
const activeSpace = computed(() => spacesStore.activeSpace.value)

const inSpace = computed(() =>
  pagesStore.pages.filter((p) => p.spaceId === activeSpaceId.value),
)

const rootPages = computed(() =>
  inSpace.value
    .filter((p) => p.parentId === null)
    .sort((a, b) => a.order - b.order),
)
const recentPages = computed(() =>
  [...inSpace.value]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)
)

const stats = computed(() => {
  const all = inSpace.value
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  const editedToday = all.filter((p) => p.updatedAt >= todayMs).length
  const childCount = all.filter((p) => p.parentId !== null).length
  const thisWeek = all.filter((p) => p.updatedAt >= todayMs - 7 * 86400000).length
  // 估算 localStorage 占用(JSON 序列化字节数 / 1024 取一位小数 KB)
  let bytes = 0
  try {
    bytes = new Blob([JSON.stringify(all)]).size
  } catch {
    bytes = 0
  }
  const kb = bytes / 1024
  const storageValue =
    kb < 1024 ? kb.toFixed(1) : (kb / 1024).toFixed(2)
  const storageUnit = kb < 1024 ? 'KB' : 'MB'
  return {
    total: all.length,
    roots: rootPages.value.length,
    children: childCount,
    editedToday,
    thisWeek,
    storageValue,
    storageUnit,
  }
})

function goPage(id: string) {
  router.push(`/p/${id}`)
}

async function createRoot() {
  // Stage B.3: client-side nanoid + immediate URL push + async create.
  // Mirrors Sidebar's createRoot — URL is stable by the time the
  // editor mounts, no blank flash waiting on POST.
  const clientId = newId()
  router.push(`/p/${clientId}/edit`)
  try {
    await pagesStore.createPage({ id: clientId, parentId: null })
  } catch {
    // store already shows the error banner
  }
}

function openTopSearch() {
  uiStore.openTopSearch()
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

// 取内容纯文本作为摘要(去掉 HTML 标签 + 图标文字,截取前 80 字)
function excerpt(html: string): string {
  return makeExcerpt(html)
}
</script>

<template>
  <div class="home-shell">
    <div class="subheader">
      <div class="breadcrumb">
        <span class="crumb-item current">{{ activeSpace?.name ?? '我的知识库' }}</span>
      </div>
      <div class="page-actions">
        <button class="btn ghost" disabled title="导入 / 导出暂未支持(请手动复制到本地存档)">
          <span class="material-symbols-outlined icon-lg">upload_file</span>
          导入
        </button>
        <button class="btn ghost" disabled title="导入 / 导出暂未支持(请手动复制到本地存档)">
          <span class="material-symbols-outlined icon-lg">file_export</span>
          导出
        </button>
        <button class="btn primary" @click="createRoot">
          <span class="material-symbols-outlined icon-lg">add</span>
          新建页面
        </button>
      </div>
    </div>

    <div class="layout no-toc">
      <Sidebar />

      <div class="content">
        <div class="content-inner home-page">
          <!-- 空状态 -->
          <div v-if="rootPages.length === 0" class="empty">
            <div class="empty-illustration">
              <svg viewBox="0 0 240 160" width="240" height="160" aria-hidden="true">
                <rect x="40" y="36" width="120" height="14" rx="3" fill="#DEEBFF" />
                <rect x="50" y="58" width="90" height="10" rx="3" fill="#EBECF0" />
                <rect x="50" y="74" width="100" height="10" rx="3" fill="#EBECF0" />
                <rect x="50" y="90" width="80" height="10" rx="3" fill="#EBECF0" />
                <rect x="120" y="20" width="80" height="100" rx="6" fill="#FFFFFF" stroke="#DFE1E6" stroke-width="1.5" />
                <rect x="132" y="34" width="40" height="6" rx="2" fill="#0052CC" />
                <rect x="132" y="50" width="56" height="4" rx="2" fill="#DFE1E6" />
                <rect x="132" y="60" width="48" height="4" rx="2" fill="#DFE1E6" />
                <rect x="132" y="70" width="52" height="4" rx="2" fill="#DFE1E6" />
                <circle cx="184" cy="118" r="14" fill="#0052CC" />
                <path d="M 178 118 L 182 122 L 190 114" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <h2>{{ activeSpace ? `${activeSpace.name} 还是空的` : '知识库还是空的' }}</h2>
            <p>创建第一个页面,开始记录团队的思考、决策和成果。</p>
            <button class="btn primary create-first" @click="createRoot">
              <span class="material-symbols-outlined icon-lg">add</span>
              创建第一个页面
            </button>
          </div>

          <!-- 正常状态 -->
          <template v-else>
            <!-- 欢迎区 -->
            <div class="home-hero">
              <h1 class="page-title">{{ activeSpace?.name ?? '我的知识库' }}</h1>
              <div class="page-byline">
                <span class="author"><UserAvatar :size="20" /> 我</span>
                <span class="dot">·</span>
                <span>共 {{ stats.total }} 个页面 · {{ stats.roots }} 个根页面 · {{ stats.children }} 个子页面</span>
              </div>
            </div>

            <!-- 统计卡片 -->
            <div class="stat-grid">
              <div class="stat-card">
                <div class="stat-label">
                  <span class="material-symbols-outlined">description</span>
                  全部页面
                </div>
                <div class="stat-value">{{ stats.total }}</div>
                <div class="stat-trend">{{ stats.roots }} 根 · {{ stats.children }} 子</div>
              </div>
              <div class="stat-card success">
                <div class="stat-label">
                  <span class="material-symbols-outlined">today</span>
                  今日活跃
                </div>
                <div class="stat-value">{{ stats.editedToday }}</div>
                <div class="stat-trend">最近 24h 更新过</div>
              </div>
              <div class="stat-card purple">
                <div class="stat-label">
                  <span class="material-symbols-outlined">schedule</span>
                  本周更新
                </div>
                <div class="stat-value">{{ stats.thisWeek }}</div>
                <div class="stat-trend">过去 7 天</div>
              </div>
              <div class="stat-card warning">
                <div class="stat-label">
                  <span class="material-symbols-outlined">storage</span>
                  云端存储
                </div>
                <div class="stat-value">{{ stats.storageValue }}<span class="stat-unit">{{ stats.storageUnit }}</span></div>
                <div class="stat-trend">存储备份 · {{ stats.total }} 页</div>
              </div>
            </div>

            <!-- 快速入口 -->
            <div class="quick-actions">
              <button class="quick-action" @click="createRoot">
                <span class="qa-icon"><span class="material-symbols-outlined">add_circle</span></span>
                <div>
                  <div>新建空白页面</div>
                  <div class="qa-meta">从零开始记录</div>
                </div>
              </button>
              <button class="quick-action" @click="$el.querySelector('.page-grid')?.scrollIntoView({behavior:'smooth'})">
                <span class="qa-icon"><span class="material-symbols-outlined">folder_open</span></span>
                <div>
                  <div>浏览所有根页面</div>
                  <div class="qa-meta">{{ stats.roots }} 个主题</div>
                </div>
              </button>
              <button class="quick-action" @click="openTopSearch">
                <span class="qa-icon"><span class="material-symbols-outlined">search</span></span>
                <div>
                  <div>搜索页面</div>
                  <div class="qa-meta">按标题 · 已支持</div>
                </div>
              </button>
            </div>

            <!-- 最近编辑 -->
            <div class="section-title">
              <span>最近编辑</span>
            </div>
            <ul class="recent-list">
              <li v-for="p in recentPages" :key="p.id" @click="goPage(p.id)">
                <span class="material-symbols-outlined doc-icon" style="font-size:18px">description</span>
                <span class="rl-title">{{ p.title }}</span>
                <span class="rl-meta">{{ relativeTime(p.updatedAt) }}</span>
              </li>
            </ul>

            <!-- 根页面 -->
            <div class="section-title">
              <span>所有主题</span>
              <span class="count">{{ stats.roots }}</span>
            </div>
            <div class="page-grid">
              <a
                v-for="p in rootPages"
                :key="p.id"
                class="page-card"
                @click.prevent="goPage(p.id)"
                href="#"
              >
                <span class="material-symbols-outlined pc-icon" style="font-size:22px">folder_open</span>
                <div class="pc-title">{{ p.title }}</div>
                <div class="pc-excerpt">{{ excerpt(p.contentHTML) || '空白页面' }}</div>
                <div class="pc-meta">
                  <span class="material-symbols-outlined icon-xs">schedule</span>
                  {{ relativeTime(p.updatedAt) }}
                  <span style="margin: 0 4px">·</span>
                  <span class="material-symbols-outlined icon-xs">layers</span>
                  {{ pagesStore.getChildren(p.id).length }} 子页面
                </div>
              </a>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-shell { min-height: calc(100vh - var(--topbar-h)); }

.home-hero { margin-bottom: 8px; }

.empty-illustration {
  margin: 0 auto 20px;
  display: flex;
  justify-content: center;
}
.empty .create-first {
  margin-top: 8px;
  height: 40px;
  padding: 0 20px;
  font-size: 15px;
  box-shadow: var(--shadow-sm);
}
.empty .create-first:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
</style>
