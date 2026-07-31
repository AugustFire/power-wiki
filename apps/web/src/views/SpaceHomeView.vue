<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useRecentPages } from '@/composables/useRecentPages'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { newId } from '@/lib/id'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import Breadcrumb from '@/components/ui/Breadcrumb.vue'
import { excerpt as makeExcerpt } from '@/lib/textMetrics'
import { formatRelativeTime } from '@/lib/relativeTime'
import { canCreateInSpace as canCreateInSpaceOf } from '@/lib/permissions'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const uiStore = useUiStore()
const authStore = useAuthStore()
const { list: recentList } = useRecentPages()
const router = useRouter()

const activeSpaceId = computed(() => spacesStore.activeSpaceId.value)
const activeSpace = computed(() => spacesStore.activeSpace.value)
const isPersonal = computed(() => activeSpace.value?.kind === 'personal')
const fallbackSpaceName = computed(() =>
  isPersonal.value ? '我的个人空间' : '团队空间',
)
/**
 * 团队空间主页跳转:Confluence space homepage 的同构。
 *
 * 当 activeSpace 配置了 homepagePageId(管理员在 SpaceEditView 里挑的本
 * 空间内一篇页面),`/` 路由应该渲染那篇页面的 ReadView,而不是系统仪
 * 表盘。个人空间永远为 null(没这个概念),跳过此分支。
 *
 * 用 router.replace 而不是 push —— `/` 是入口,「返回 `/`」不应再触发
 * 一次 redirect(否则 history 里堆栈爆炸)。
 *
 * 处理边界:homepagePageId 指向的页可能是 trash 或已 hard-delete。
 *   - soft-delete(进回收站):API 没自动清字段,保留信息让 admin 知情;
 *     ReadView 的 trash 渲染会接管(trashed 页面访问会显示相应状态)。
 *   - hard-delete(purge):pages.ts purge transaction 已同事务清空引用,
 *     所以「悬挂引用」不会发生(除非用户在 purge 流程完成前就缓存了
 *     stale activeSpace —— 此时 router.replace 会撞 ReadView 的 404,
 *     ReadView 显示错误页,用户可手动回 `/` 重试,这次就会走仪表盘)。
 */
const homepagePageId = computed(() => {
  if (isPersonal.value) return null
  return activeSpace.value?.homepagePageId ?? null
})
watch(
  [homepagePageId, activeSpaceId],
  ([target, sid]) => {
    if (!target || !sid) return
    // 仅当确实停在 `/`(home 路由)时跳;用户在 home 之后又点了别的页
    // 进来(罕见),不要把人家踢回主页。
    if (router.currentRoute.value.name !== 'home') return
    void router.replace(`/p/${target}`)
  },
  { immediate: true },
)
const homeTitle = computed(() => activeSpace.value?.name ?? fallbackSpaceName.value)
useDocumentTitle(() => `${homeTitle.value} · 首页`)
const me = computed(() => authStore.user)
const canCreateInSpace = computed(() =>
  canCreateInSpaceOf(authStore.user, activeSpace.value),
)
const inSpace = computed(() =>
  pagesStore.pages.filter((page) => page.spaceId === activeSpaceId.value),
)
const rootPages = computed(() =>
  inSpace.value
    .filter((page) => page.parentId === null)
    .sort((a, b) => a.order - b.order),
)
const recentPages = computed(() =>
  [...inSpace.value]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6),
)
const myRecentPages = computed(() =>
  recentList.value
    .filter((entry) => pagesStore.getPage(entry.id)?.spaceId === activeSpaceId.value)
    .slice(0, 6),
)
const stats = computed(() => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  const weekMs = todayMs - 7 * 86400000
  const meId = authStore.user?.id
  let editedToday = 0
  let thisWeek = 0
  let childCount = 0
  let myPages = 0

  for (const page of inSpace.value) {
    if (page.updatedAt >= todayMs) editedToday++
    if (page.updatedAt >= weekMs) thisWeek++
    if (page.parentId !== null) childCount++
    if (meId && page.authorId === meId) myPages++
  }

  return {
    total: inSpace.value.length,
    roots: rootPages.value.length,
    children: childCount,
    editedToday,
    thisWeek,
    myPages,
  }
})

function goPage(id: string): void {
  void router.push(`/p/${id}`)
}

async function createRoot(): Promise<void> {
  const clientId = newId()
  void router.push(`/p/${clientId}/edit`)
  try {
    await pagesStore.createPage({ id: clientId, parentId: null })
  } catch {
    // The store surfaces the error.
  }
}

function relativeTime(timestamp: number): string {
  return formatRelativeTime(timestamp)
}

function excerpt(html: string): string {
  return makeExcerpt(html)
}
</script>

<template>
  <div class="home-shell">
    <Breadcrumb :segments="[{ label: homeTitle + ' · 首页' }]">
      <template #current>
        <span class="crumb-item current">
          {{ homeTitle }} · 首页
          <span
            v-if="!canCreateInSpace"
            class="material-symbols-outlined crumb-lock"
            title="你在此空间只有只读权限,无法创建新页面"
          >lock</span>
        </span>
      </template>
    </Breadcrumb>
    <!-- page-actions 同样 Teleport 到 #app-subheader,与面包屑并列渲染,
         视觉上「页面名/操作按钮」左右两段,顺序由 CSS .app-subheader-content
         下 .breadcrumb/.page-actions 的 order 锁死(见 components.css)。
         空间为空时不显示,空状态的「创建第一个页面」已经承担了主 CTA 职责;
         同时空(连首页空状态图都画好了)再叠一个 subheader 按钮会让用户
         在两个「+」之间挑,视觉冗余。 -->
    <div class="page-actions">
      <button v-if="canCreateInSpace && rootPages.length > 0" class="btn primary" @click="createRoot">
        <span class="material-symbols-outlined icon-lg">add</span>
        新建页面
      </button>
    </div>

    <div class="content-inner home-page content-wide">
      <div v-if="rootPages.length === 0" class="empty">
        <div class="empty-illustration">
          <svg viewBox="0 0 240 160" width="240" height="160" aria-hidden="true">
            <rect x="40" y="36" width="120" height="14" rx="3" fill="var(--accent-soft)" />
            <rect x="50" y="58" width="90" height="10" rx="3" fill="var(--bg-subtle)" />
            <rect x="50" y="74" width="100" height="10" rx="3" fill="var(--bg-subtle)" />
            <rect x="50" y="90" width="80" height="10" rx="3" fill="var(--bg-subtle)" />
            <rect x="120" y="20" width="80" height="100" rx="6" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5" />
            <rect x="132" y="34" width="40" height="6" rx="2" fill="var(--accent)" />
            <rect x="132" y="50" width="56" height="4" rx="2" fill="var(--border)" />
            <rect x="132" y="60" width="48" height="4" rx="2" fill="var(--border)" />
            <rect x="132" y="70" width="52" height="4" rx="2" fill="var(--border)" />
            <circle cx="184" cy="118" r="14" fill="var(--accent)" />
            <path d="M 178 118 L 182 122 L 190 114" stroke="var(--bg)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <h2>{{ activeSpace ? `${activeSpace.name} 还是空的` : `${fallbackSpaceName}还是空的` }}</h2>
        <p v-if="canCreateInSpace">
          <template v-if="isPersonal">创建第一个页面,记录只属于自己的笔记、想法和草稿。</template>
          <template v-else>创建第一个页面,开始记录团队的思考、决策和成果。</template>
        </p>
        <p v-else>该空间目前还没有任何内容,你只有只读权限。</p>
        <button v-if="canCreateInSpace" class="btn primary create-first" @click="createRoot">
          <span class="material-symbols-outlined icon-lg">add</span>
          创建第一个页面
        </button>
      </div>

      <template v-else>
        <div class="home-hero">
          <h1 class="page-title">{{ homeTitle }}</h1>
          <div class="page-byline">
            <span class="author">
              <UserAvatar
                :size="20"
                :label="me?.name ?? '我'"
                :color="me?.color"
                :avatar-kind="me?.avatarKind ?? null"
                :avatar-ref="me?.avatarRef ?? null"
                :user-id="me?.id ?? null"
              />
              {{ me?.name ?? '我' }}
            </span>
            <span class="dot">·</span>
            <span>共 {{ stats.total }} 个页面 · {{ stats.roots }} 个根页面 · {{ stats.children }} 个子页面</span>
          </div>
        </div>

        <section v-if="activeSpace?.description" class="space-overview">
          <SpaceAvatar :space="activeSpace" :size="40" :show-name="true" />
          <p class="space-overview-desc">{{ activeSpace.description }}</p>
        </section>

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
              <span class="material-symbols-outlined">person</span>
              我的页面
            </div>
            <div class="stat-value">{{ stats.myPages }}</div>
            <div class="stat-trend">我创建的 · 本空间内</div>
          </div>
        </div>

        <div class="quick-actions">
          <button v-if="canCreateInSpace" class="quick-action" @click="createRoot">
            <span class="qa-icon"><span class="material-symbols-outlined">add_circle</span></span>
            <span>
              <span>新建空白页面</span>
              <span class="qa-meta">从零开始记录</span>
            </span>
          </button>
          <button class="quick-action" @click="$el.querySelector('.page-grid')?.scrollIntoView({ behavior: 'smooth' })">
            <span class="qa-icon"><span class="material-symbols-outlined">folder_open</span></span>
            <span>
              <span>浏览所有根页面</span>
              <span class="qa-meta">{{ stats.roots }} 个主题</span>
            </span>
          </button>
          <button class="quick-action" @click="uiStore.openTopSearch()">
            <span class="qa-icon"><span class="material-symbols-outlined">search</span></span>
            <span>
              <span>搜索页面</span>
              <span class="qa-meta">按标题搜索</span>
            </span>
          </button>
        </div>

        <div class="section-title">
          <span>{{ myRecentPages.length > 0 ? '我最近访问' : '推荐浏览' }}</span>
        </div>
        <ul v-if="myRecentPages.length > 0" class="recent-list recent-list--mine">
          <li v-for="entry in myRecentPages" :key="entry.id" @click="goPage(entry.id)">
            <span class="material-symbols-outlined doc-icon">history</span>
            <span class="rl-title">{{ entry.title }}</span>
            <span class="rl-meta">{{ relativeTime(entry.visitedAt) }}</span>
          </li>
        </ul>
        <ul v-else class="recent-list">
          <li v-for="page in recentPages.slice(0, 3)" :key="page.id" @click="goPage(page.id)">
            <span class="material-symbols-outlined doc-icon">description</span>
            <span class="rl-title">{{ page.title }}</span>
            <span class="rl-meta">{{ relativeTime(page.updatedAt) }}</span>
          </li>
        </ul>

        <div class="section-title">
          <span>最近编辑</span>
        </div>
        <ul class="recent-list">
          <li v-for="page in recentPages" :key="page.id" @click="goPage(page.id)">
            <span class="material-symbols-outlined doc-icon">description</span>
            <span class="rl-title">{{ page.title }}</span>
            <span class="rl-meta">{{ relativeTime(page.updatedAt) }}</span>
          </li>
        </ul>

        <div class="section-title">
          <span>所有主题</span>
          <span class="count">{{ stats.roots }}</span>
        </div>
        <div class="page-grid">
          <a
            v-for="page in rootPages"
            :key="page.id"
            class="page-card"
            href="#"
            @click.prevent="goPage(page.id)"
          >
            <span class="material-symbols-outlined pc-icon">folder_open</span>
            <div class="pc-title">{{ page.title }}</div>
            <div class="pc-excerpt">{{ excerpt(page.contentHTML) || '空白页面' }}</div>
            <div class="pc-meta">
              <span class="material-symbols-outlined icon-xs">schedule</span>
              {{ relativeTime(page.updatedAt) }}
              <span class="meta-separator">·</span>
              <span class="material-symbols-outlined icon-xs">layers</span>
              {{ pagesStore.getChildren(page.id).length }} 子页面
            </div>
          </a>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.home-hero { margin-bottom: 8px; }
.space-overview {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 16px 0 20px;
  padding: 12px 16px;
  background: var(--bg-subtle);
  border-radius: var(--radius-md, 6px);
}
.space-overview :deep(.sa-name) {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin-right: 8px;
}
.space-overview-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  flex: 1;
  min-width: 0;
}
.empty-illustration {
  margin: 0 auto 20px;
  display: flex;
  justify-content: center;
}
.crumb-lock {
  font-size: 14px !important;
  color: var(--text-3);
  flex-shrink: 0;
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
.quick-action > span:last-child {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.doc-icon { font-size: 18px !important; }
.pc-icon { font-size: 22px !important; }
.meta-separator { margin: 0 4px; }
</style>
