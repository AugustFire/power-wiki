<script setup lang="ts">
/**
 * NotificationsView — `/notifications` 顶级路由 view.
 *
 * 平级 `/p/:id`,不挂 `/manager/*`(普通用户也有). 列出当前用户的全部
 * notification(已读 + 未读),提供「全部标为已读」和「清空已读」按钮,
 * 支持 loadMore.
 *
 * 复用 NotificationBell 的 BellListItem 渲染 shape(同一个 Notification
 * shape,只是 detail 略不同 — 这是 view 内的复制渲染,避免 Bell 与 view
 * 共享一个 component 的 popover-state 复杂度).
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useNotificationsStore } from '@/stores/notifications'
import { useNotifications } from '@/composables/useNotifications'
import Sidebar from '@/components/layout/Sidebar.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'

const store = useNotificationsStore()
const router = useRouter()
const { ensureLoaded } = useNotifications()

onMounted(() => {
  void ensureLoaded()
})

const HUMAN: Record<string, string> = {
  mention: '在评论里提到你',
  reply: '回复了你的评论',
  comment_on_my_page: '评论了你的页面',
}

const items = computed(() => store.items)

function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const s = Math.round(diff / 1000)
  if (s < 60) return '刚刚'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}

function open(id: string, pageId: string): void {
  void store.markRead([id])
  router.push(`/p/${pageId}`)
}

async function onMarkAll(): Promise<void> {
  await store.markRead(undefined, true)
}
async function onClearRead(): Promise<void> {
  await store.clearRead()
}
</script>

<template>
  <div class="nv-shell">
    <Sidebar />
    <main class="nv-main">
      <header class="nv-head">
        <h1 class="nv-title">通知中心</h1>
        <div class="nv-actions">
          <button type="button" class="nv-btn" @click="onMarkAll">
            全部标为已读
          </button>
          <button type="button" class="nv-btn" @click="onClearRead">
            清空已读
          </button>
        </div>
      </header>
      <div v-if="store.loaded && items.length === 0" class="nv-empty">没有通知</div>
      <ul v-else class="nv-list">
        <li
          v-for="n in items"
          :key="n.id"
          class="nv-item"
          :class="{ 'is-unread': !n.isRead }"
          @click="open(n.id, n.pageId)"
        >
          <UserAvatar
            :label="n.actorName ?? n.actorId"
            :color="n.actorColor ?? '#0052CC'"
            :size="36"
            class="nv-avatar"
          />
          <div class="nv-text">
            <div class="nv-row1">
              <span class="nv-actor">{{ n.actorName ?? n.actorId }}</span>
              <span class="nv-kind">{{ HUMAN[n.kind] ?? '通知' }}</span>
            </div>
            <div class="nv-page">{{ n.pageTitle ?? '(已删除)' }}</div>
          </div>
          <span class="nv-time">{{ relTime(n.createdAt) }}</span>
        </li>
      </ul>
      <button
        v-if="store.hasMore"
        type="button"
        class="nv-btn-loadmore"
        :disabled="store.loadingMore"
        @click="store.loadMore"
      >
        {{ store.loadingMore ? '加载中…' : '加载更多' }}
      </button>
    </main>
  </div>
</template>

<style scoped>
.nv-shell {
  display: grid;
  grid-template-columns: 280px 1fr;
  min-height: calc(100vh - var(--topbar-h));
}
.nv-main {
  padding: 32px;
  max-width: 920px;
}
.nv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border, #ebeef0);
  margin-bottom: 16px;
}
.nv-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  color: var(--text-1, #172b4d);
}
.nv-actions {
  display: flex;
  gap: 8px;
}
.nv-btn {
  border: 1px solid var(--border, #dfe1e6);
  background: var(--bg, #fff);
  color: var(--text-2, #42526e);
  padding: 6px 12px;
  border-radius: 3px;
  font-size: 13px;
  cursor: pointer;
}
.nv-btn:hover {
  background: var(--hover-bg, #f4f5f7);
}
.nv-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-3, #5e6c84);
  font-size: 14px;
}
.nv-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.nv-item {
  display: grid;
  grid-template-columns: 36px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--border, #ebeef0);
  cursor: pointer;
}
.nv-item:hover {
  background: var(--hover-bg, #f4f5f7);
}
.nv-item.is-unread {
  background: rgba(0, 82, 204, 0.04);
}
.nv-row1 {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.nv-actor {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1, #172b4d);
}
.nv-kind {
  font-size: 13px;
  color: var(--text-2, #42526e);
}
.nv-page {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3, #5e6c84);
}
.nv-time {
  font-size: 12px;
  color: var(--text-3, #5e6c84);
}
.nv-btn-loadmore {
  display: block;
  margin: 16px auto;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #dfe1e6);
  color: var(--text-2, #42526e);
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.nv-btn-loadmore:hover:not([disabled]) {
  background: var(--hover-bg, #f4f5f7);
}
.nv-btn-loadmore[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
