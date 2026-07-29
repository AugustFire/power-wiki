<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DashboardCard from '@/components/page/DashboardCard.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { useNotificationsStore } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { usePinnedPages } from '@/composables/usePinnedPages'
import { useRecentPages } from '@/composables/useRecentPages'
import { formatRelativeTime } from '@/lib/relativeTime'
import { newId } from '@/lib/id'
import { canCreateInSpace as canCreateInSpaceOf } from '@/lib/permissions'
import { api } from '@/lib/api'
import type { DashboardPayload, PageNode, Space } from '@power-wiki/shared'

const router = useRouter()
const auth = useAuthStore()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const notifications = useNotificationsStore()
const uiStore = useUiStore()
const { list: pinnedList } = usePinnedPages()
const { list: recentList } = useRecentPages()

useDocumentTitle(() => '我的工作台')

const payload = ref<DashboardPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const personalSpace = computed(() =>
  spacesStore.spaces.value.find((space) => space.kind === 'personal') ?? null,
)
const canCreatePersonalPage = computed(() =>
  canCreateInSpaceOf(auth.user, personalSpace.value),
)
const spaceById = computed<Map<string, Space>>(() => {
  const result = new Map<string, Space>()
  for (const space of spacesStore.spaces.value) result.set(space.id, space)
  return result
})
const hasMentions = computed(() => (payload.value?.mentions.length ?? 0) > 0)
const hasCreated = computed(() => (payload.value?.created.length ?? 0) > 0)
const profileSummary = computed(() => {
  const mentions = payload.value?.mentions.length ?? 0
  const created = payload.value?.created.length ?? 0
  if (mentions > 0) return `有 ${mentions} 条未读提到等待处理,最近创建了 ${created} 个页面。`
  if (created > 0) return '集中查看你跨空间创建、固定和最近访问的内容。'
  return '这是你跨空间的个人工作台,从这里开始记录和整理知识。'
})
const pinnedItems = computed(() => pinnedList.value.map((entry) => {
  // P1-9: 死 row = page 已被 soft-delete。pagesStore.getPage 走内部 pages
  // map,soft-delete 后的页不在那里(API 列表过滤 deletedAt)→ getPage 返
  // 回 undefined。`alive` 必须显式区分「找到且未删」与「找不到」两种情况,
  // 否则 undefined?.deletedAt === undefined 让 `!undefined` = true,死 row
  // 被误判为 alive,stored-row-dead + disabled 视觉降级不生效。
  const page = pagesStore.getPage(entry.id)
  return {
    id: entry.id,
    title: page?.title || entry.title,
    spaceId: entry.spaceId,
    timestamp: entry.pinnedAt,
    alive: !!page && !page.deletedAt,
  }
}))
const recentItems = computed(() => recentList.value.map((entry) => {
  const page = pagesStore.getPage(entry.id)
  return {
    id: entry.id,
    title: page?.title || entry.title,
    spaceId: page?.spaceId ?? null,
    timestamp: entry.visitedAt,
    // 同上 — 见 pinnedItems 注释
    alive: !!page && !page.deletedAt,
  }
}))

function describeSpace(id: string | null | undefined): {
  name: string
  color: string
  kind: 'personal' | 'shared'
} {
  const space = id ? spaceById.value.get(id) : null
  if (!space) return { name: '(已删除空间)', color: 'var(--text-3)', kind: 'shared' }
  return {
    name: space.name,
    color: space.color,
    kind: space.kind ?? 'shared',
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    if (!spacesStore.loaded.value) await spacesStore.init()
    payload.value = await api.users.me.dashboard(5)
    void notifications.refreshUnread()
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => { void load() })

function openPage(pageId: string): void {
  const page = payload.value?.created.find((entry) => entry.id === pageId)
    ?? pagesStore.getPage(pageId)
  if (page?.spaceId && spacesStore.activeSpaceId.value !== page.spaceId) {
    spacesStore.setActiveSpace(page.spaceId)
  }
  void router.push(`/p/${pageId}`)
}

function openStoredPage(item: { id: string; spaceId: string | null; alive: boolean }): void {
  if (!item.alive) return
  if (item.spaceId && spacesStore.activeSpaceId.value !== item.spaceId) {
    spacesStore.setActiveSpace(item.spaceId)
  }
  void router.push(`/p/${item.id}`)
}

async function openMention(pageId: string, commentId: string | null): Promise<void> {
  const matchingMentions = payload.value?.mentions.filter(
    (notification) => !notification.isRead
      && notification.pageId === pageId
      && (commentId == null || notification.commentId === commentId),
  ) ?? []
  const idsToMarkRead = matchingMentions.map((notification) => notification.id)
  if (idsToMarkRead.length > 0) {
    try {
      await api.notifications.markRead({ ids: idsToMarkRead })
      void notifications.refreshUnread()
    } catch {
      // Navigation remains available if marking the notification fails.
    }
  }

  const page = payload.value?.created.find((entry) => entry.id === pageId)
    ?? pagesStore.getPage(pageId)
  if (page?.spaceId && spacesStore.activeSpaceId.value !== page.spaceId) {
    spacesStore.setActiveSpace(page.spaceId)
  }
  const hash = commentId ? `#comment-${commentId}` : ''
  void router.push(`/p/${pageId}${hash}`)
}

async function createPersonalPage(): Promise<void> {
  const space = personalSpace.value
  if (!space || !canCreatePersonalPage.value) return
  spacesStore.setActiveSpace(space.id)
  const id = newId()
  void router.push(`/p/${id}/edit`)
  try {
    await pagesStore.createPage({ id, parentId: null, spaceId: space.id })
  } catch {
    // The store surfaces the error.
  }
}

function goPersonalSpace(): void {
  const space = personalSpace.value
  if (!space) return
  spacesStore.setActiveSpace(space.id)
  if (router.currentRoute.value.path !== '/') {
    void router.push('/')
  }
}

function ensurePageLoaded(page: PageNode): void {
  if (pagesStore.getPage(page.id)) return
  void pagesStore.ensureAncestorsLoaded(page.id)
}

function relativeTime(timestamp: number): string {
  return formatRelativeTime(timestamp)
}
</script>

<template>
  <div class="personal-home-shell">
    <Teleport to="#app-subheader">
      <div class="breadcrumb">
        <span class="crumb-item current">我的工作台</span>
      </div>
      <div class="page-actions">
        <button
          v-if="canCreatePersonalPage"
          class="btn"
          type="button"
          @click="createPersonalPage"
        >
          <span class="material-symbols-outlined icon-lg">add</span>
          新建个人页面
        </button>
        <button class="btn primary" type="button" @click="uiStore.openSettings()">
          <span class="material-symbols-outlined icon-lg">edit</span>
          编辑资料
        </button>
      </div>
    </Teleport>

    <div class="content-inner personal-home-page content-wide">
      <header class="profile-cover">
        <UserAvatar
          :size="80"
          :label="auth.user?.name ?? '我'"
          :color="auth.user?.color"
          :avatar-kind="auth.user?.avatarKind ?? null"
          :avatar-ref="auth.user?.avatarRef ?? null"
          :user-id="auth.user?.id ?? null"
        />
        <div class="profile-copy">
          <span class="profile-eyebrow">个人工作台</span>
          <h1 class="profile-name">{{ auth.user?.name ?? '我' }}</h1>
          <p v-if="auth.user?.email" class="profile-email">{{ auth.user.email }}</p>
          <p class="profile-summary">{{ profileSummary }}</p>
          <button
            v-if="personalSpace"
            type="button"
            class="profile-space-link"
            @click="goPersonalSpace"
          >
            <span class="material-symbols-outlined">lock_person</span>
            <span>进入个人空间 →</span>
          </button>
        </div>
        <button class="profile-edit" type="button" @click="uiStore.openSettings()">
          <span class="material-symbols-outlined">manage_accounts</span>
          编辑资料
        </button>
      </header>

      <div v-if="error" class="personal-home-error">
        <span class="material-symbols-outlined">error</span>
        <span>{{ error }}</span>
        <button class="link-btn" type="button" @click="load">重试</button>
      </div>

      <div class="personal-sections">
        <section class="personal-section">
          <header class="section-head">
            <h2 class="section-title">
              <span class="material-symbols-outlined section-icon mention-icon">alternate_email</span>
              @提到我
            </h2>
            <span class="section-meta">{{ payload?.mentions.length ?? 0 }} 条未读</span>
          </header>
          <div v-if="loading && !payload" class="section-loading">
            <div v-for="index in 3" :key="index" class="row-skeleton">
              <Skeleton circle :width="32" :height="32" />
              <div class="row-skeleton-text">
                <Skeleton :width="`${55 + index * 7}%`" :height="14" />
                <Skeleton :width="`${30 + index * 5}%`" :height="11" />
              </div>
            </div>
          </div>
          <ul v-else-if="hasMentions" class="section-list">
            <li v-for="notification in payload!.mentions" :key="notification.id">
              <DashboardCard
                variant="mention"
                :notification="notification"
                @open-mention="(pageId, commentId) => openMention(pageId, commentId)"
              />
            </li>
          </ul>
          <EmptyState
            v-else
            icon="forum"
            title="没有被 @ 提到"
            hint="有人在评论里 @ 你时会出现在这里。"
            size="sm"
          />
        </section>

        <section class="personal-section">
          <header class="section-head">
            <h2 class="section-title">
              <span class="material-symbols-outlined section-icon">add_circle</span>
              我创建的
            </h2>
            <span class="section-meta">最近 {{ payload?.created.length ?? 0 }} 个</span>
          </header>
          <div v-if="loading && !payload" class="section-loading">
            <div v-for="index in 3" :key="index" class="row-skeleton">
              <Skeleton :width="32" :height="32" />
              <div class="row-skeleton-text">
                <Skeleton :width="`${50 + index * 7}%`" :height="14" />
                <Skeleton :width="`${30 + index * 5}%`" :height="11" />
              </div>
            </div>
          </div>
          <ul v-else-if="hasCreated" class="section-list">
            <li
              v-for="page in payload!.created"
              :key="page.id"
              @mouseenter="ensurePageLoaded(page)"
            >
              <DashboardCard
                variant="page"
                :page="page"
                :space-name="describeSpace(page.spaceId).name"
                :space-color="describeSpace(page.spaceId).color"
                :space-kind="describeSpace(page.spaceId).kind"
                @open-page="openPage"
              />
            </li>
          </ul>
          <EmptyState
            v-else
            icon="article"
            title="还没有创建过页面"
            hint="去任意空间创建你的第一页,会出现在这里。"
            size="sm"
          />
        </section>

        <section class="personal-section">
          <header class="section-head">
            <h2 class="section-title">
              <span class="material-symbols-outlined section-icon">push_pin</span>
              已固定
            </h2>
            <span class="section-meta">{{ pinnedItems.length }} 个</span>
          </header>
          <ul v-if="pinnedItems.length > 0" class="stored-list">
            <li v-for="item in pinnedItems" :key="item.id">
              <button
                type="button"
                class="stored-row"
                :class="{ 'stored-row-dead': !item.alive }"
                :disabled="!item.alive"
                @click="openStoredPage(item)"
              >
                <span class="material-symbols-outlined stored-icon">description</span>
                <span class="stored-title">{{ item.title }}</span>
                <span class="stored-meta">{{ relativeTime(item.timestamp) }}</span>
              </button>
            </li>
          </ul>
          <EmptyState
            v-else
            icon="push_pin"
            title="还没有固定页面"
            hint="在页面操作中固定常用内容,它们会出现在这里。"
            size="sm"
          />
        </section>

        <section class="personal-section">
          <header class="section-head">
            <h2 class="section-title">
              <span class="material-symbols-outlined section-icon">history</span>
              最近访问
            </h2>
            <span class="section-meta">{{ recentItems.length }} 个</span>
          </header>
          <ul v-if="recentItems.length > 0" class="stored-list">
            <li v-for="item in recentItems" :key="item.id">
              <button
                type="button"
                class="stored-row"
                :class="{ 'stored-row-dead': !item.alive }"
                :disabled="!item.alive"
                @click="openStoredPage(item)"
              >
                <span class="material-symbols-outlined stored-icon">history</span>
                <span class="stored-title">{{ item.title }}</span>
                <span class="stored-meta">{{ relativeTime(item.timestamp) }}</span>
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
  </div>
</template>

<style scoped>
.personal-home-page {
  padding-top: 32px;
  padding-bottom: 64px;
}
.profile-cover {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  align-items: center;
  gap: 24px;
  padding: 28px 32px;
  margin-bottom: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
  box-shadow: var(--shadow-sm);
}
.profile-copy { min-width: 0; }
.profile-eyebrow {
  display: block;
  margin-bottom: 5px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.profile-name {
  margin: 0;
  color: var(--text-1);
  font-size: 28px;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
.profile-email {
  margin: 5px 0 0;
  color: var(--text-3);
  font-size: 13px;
}
.profile-summary {
  margin: 12px 0 0;
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.6;
}

/* 「进入个人空间 →」— cover 内的 inline link,把"工作台"跟"个人空间
 * 容器视图"两个产品连起来。视觉上做成 tertiary 链接(text-2 → text-1
 * → accent on hover),跟 .profile-summary 同字号但更轻量,避免盖过
 * 主 CTA(右侧的「编辑资料」)。lock_person icon 跟 SpaceSwitcher
 * 触发器徽章复用,降低首次见到的认知成本。 */
.profile-space-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out);
}
.profile-space-link:hover { color: var(--accent); }
.profile-space-link .material-symbols-outlined {
  font-size: 15px !important;
  color: inherit;
}
.profile-edit {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.profile-edit:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.profile-edit .material-symbols-outlined { font-size: 18px !important; }
.personal-home-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-bottom: 20px;
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  color: var(--danger);
  font-size: 14px;
}
.link-btn {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.personal-sections {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  align-items: start;
}
.personal-section {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.personal-section:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.section-title {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-1);
  font-size: 15px;
  font-weight: 600;
}
.section-icon {
  color: var(--text-2);
  font-size: 20px !important;
}
.mention-icon { color: var(--danger); }
.section-meta {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-subtle);
  color: var(--text-3);
  font-size: 12px;
  font-weight: 500;
}
.section-list,
.stored-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.section-list > li:last-child :deep(.dash-card) { border-bottom: 0; }
.section-loading { padding: 8px 0; }
.row-skeleton {
  display: grid;
  grid-template-columns: 32px 1fr;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.row-skeleton:last-child { border-bottom: 0; }
.row-skeleton-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stored-list > li + li { border-top: 1px solid var(--border); }
.stored-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  padding: 8px 16px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.stored-row:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.stored-row-dead {
  opacity: 0.45;
  cursor: not-allowed;
}
.stored-icon {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 20px !important;
}
.stored-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
}
.stored-meta {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 12px;
}
</style>
