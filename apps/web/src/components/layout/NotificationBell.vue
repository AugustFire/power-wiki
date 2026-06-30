<script setup lang="ts">
/**
 * NotificationBell — TopBar 内的铃铛 + popover.
 *
 * Reads the module-shared `useNotifications()` composable so the bell and
 * the `/notifications` page render the same data without a second fetch.
 *
 * Popover:
 *   - header: title + "全部标为已读" + "查看全部" links
 *   - list: first 5 unread OR most-recent items, with a 1-line preview
 *   - clicked item → route to `/p/{pageId}` and mark-as-read in the
 *     background (optimistic UI — the row is marked locally first)
 *
 * Implemented to mirror `UserMenu.vue` pattern: `position: absolute` on
 * a portaled container that's anchored to the bell button. No `Teleport`
 * to body — TopBar's parent layout already has its own stacking context.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useNotificationsStore } from '@/stores/notifications'
import { useNotifications } from '@/composables/useNotifications'

const store = useNotificationsStore()
const { ensureLoaded } = useNotifications()
const router = useRouter()

const open = ref(false)
const bellEl = ref<HTMLElement | null>(null)

onMounted(() => {
  void ensureLoaded()
})

const previewItems = computed(() => store.items.slice(0, 5))

const unreadDisplay = computed(() => {
  if (store.unreadCount <= 0) return ''
  if (store.unreadCount > 99) return '99+'
  return String(store.unreadCount)
})

function toggle(): void {
  open.value = !open.value
  if (open.value) void ensureLoaded()
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return
  if (!bellEl.value) return
  if (!ev.target) return
  if (!bellEl.value.contains(ev.target as Node)) open.value = false
}

function onItemClick(id: string, pageId: string): void {
  void store.markRead([id])
  open.value = false
  router.push(`/p/${pageId}`)
}

function onMarkAll(): void {
  void store.markRead(undefined, true)
}

async function onClearRead(): Promise<void> {
  await store.clearRead()
}

const HUMAN_KIND: Record<string, string> = {
  mention: '提到你',
  reply: '回复了你的评论',
  comment_on_my_page: '评论了你的页面',
}

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
</script>

<template>
  <div ref="bellEl" class="bell-wrap" @click="onDocClick">
    <button class="bell-btn" type="button" aria-label="通知" @click="toggle">
      <span class="material-symbols-outlined">notifications</span>
      <span v-if="unreadDisplay" class="bell-badge">{{ unreadDisplay }}</span>
    </button>
    <div v-if="open" class="bell-popover" role="dialog" aria-label="通知">
      <div class="bp-head">
        <span class="bp-title">通知</span>
        <a class="bp-link" href="#/notifications">查看全部</a>
      </div>
      <div class="bp-actions">
        <button class="bp-btn" type="button" @click="onMarkAll">全部标为已读</button>
        <button class="bp-btn" type="button" @click="onClearRead">清空已读</button>
      </div>
      <div class="bp-list">
        <div v-if="previewItems.length === 0" class="bp-empty">暂无通知</div>
        <button
          v-for="n in previewItems"
          :key="n.id"
          class="bp-row"
          :class="{ 'is-unread': !n.isRead }"
          type="button"
          @click="onItemClick(n.id, n.pageId)"
        >
          <span class="bp-avatar" :style="{ background: n.actorColor ?? '#0052CC' }">
            {{ (n.actorName ?? n.actorId).slice(0, 1) }}
          </span>
          <span class="bp-text">
            <span class="bp-kind">{{ HUMAN_KIND[n.kind] ?? '通知' }}</span>
            <span class="bp-page">{{ n.pageTitle ?? '(已删除)' }}</span>
          </span>
          <span class="bp-time">{{ relTime(n.createdAt) }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bell-wrap {
  position: relative;
}
.bell-btn {
  position: relative;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2, #42526e);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bell-btn:hover {
  background: var(--hover-bg, #f4f5f7);
}
.bell-btn .material-symbols-outlined {
  font-size: 20px;
}
.bell-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background: var(--danger, #de350b);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
}
.bell-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 320px;
  max-width: 380px;
  max-height: 480px;
  overflow-y: auto;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
  z-index: 100;
}
.bp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #ebeef0);
}
.bp-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1, #172b4d);
}
.bp-link {
  font-size: 12px;
  color: var(--accent, #0052cc);
  text-decoration: none;
}
.bp-link:hover {
  text-decoration: underline;
}
.bp-actions {
  display: flex;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, #ebeef0);
}
.bp-btn {
  background: transparent;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 3px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-2, #42526e);
  cursor: pointer;
}
.bp-btn:hover {
  background: var(--hover-bg, #f4f5f7);
}
.bp-list {
  padding: 4px 0;
}
.bp-empty {
  padding: 14px;
  color: var(--text-3, #5e6c84);
  font-size: 13px;
  text-align: center;
}
.bp-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 14px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border, #f4f5f7);
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.bp-row:hover {
  background: var(--hover-bg, #f4f5f7);
}
.bp-row.is-unread {
  background: rgba(0, 82, 204, 0.04);
}
.bp-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bp-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.bp-kind {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1, #172b4d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-page {
  font-size: 11px;
  color: var(--text-3, #5e6c84);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-time {
  font-size: 11px;
  color: var(--text-3, #5e6c84);
}
</style>
