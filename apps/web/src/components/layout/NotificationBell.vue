<script setup lang="ts">
/**
 * NotificationBell — TopBar 内的铃铛 + 右侧抽屉式通知中心.
 *
 * Reads the module-shared `useNotifications()` composable.
 *
 * Drawer (主流 App pattern — Slack / Linear / Notion / 飞书):
 *   - 固定右侧 440px 抽屉,通过 <Teleport to="body"> 脱离 TopBar 层级
 *   - 半透明 backdrop 接受 click → close
 *   - window keydown Escape → close
 *   - 打开时锁 body 滚动,关闭恢复
 *   - 两个独立 <Transition>:backdrop opacity(200ms) + panel transform(240ms)
 *   - 头部:title + 全部标为已读 + 更多菜单(清空已读)+ X
 *   - 标签:全部 / 未读(角标显示数量)
 *   - 列表:每行左侧未读强调条,正文 actor + kind + pageTitle,右侧时间
 *   - 点击行 → 路由 /p/:id + markRead + 关闭抽屉
 *
 * 历史:
 *   - 2026-07-01 v1: 从小弹窗(380px, 无 backdrop)改为右侧抽屉,
 *     解决 2K 屏"塞不下"和"只能点铃铛关闭"两个 UX 问题.
 *   - 2026-07-01 v2: 删 /notifications 顶级页 + 抽屉底部"查看全部"链接;
 *     清空已读改放到抽屉头部的 ⋮ 菜单里, 抽屉本身就是通知中心.
 */
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useNotificationsStore } from '@/stores/notifications'
import { useNotifications } from '@/composables/useNotifications'

type TabKey = 'all' | 'unread'

const store = useNotificationsStore()
const { ensureLoaded } = useNotifications()
const router = useRouter()

const open = ref(false)
const activeTab = ref<TabKey>('all')
const menuOpen = ref(false)
const menuWrapEl = ref<HTMLElement | null>(null)

onMounted(() => {
  void ensureLoaded()
})

const tabs = computed(() => [
  { key: 'all' as TabKey, label: '全部', count: store.items.length },
  { key: 'unread' as TabKey, label: '未读', count: store.unreadCount },
])

const visibleItems = computed(() => {
  const list = activeTab.value === 'unread' ? store.items.filter((n) => !n.isRead) : store.items
  return list
})

const unreadDisplay = computed(() => {
  if (store.unreadCount <= 0) return ''
  if (store.unreadCount > 99) return '99+'
  return String(store.unreadCount)
})

function toggle(): void {
  open.value = !open.value
  if (open.value) void ensureLoaded()
}

function close(): void {
  open.value = false
}

function onItemClick(id: string, pageId: string): void {
  void store.markRead([id])
  close()
  router.push(`/p/${pageId}`)
}

function onMarkAll(): void {
  void store.markRead(undefined, true)
}

function onClearRead(): void {
  menuOpen.value = false
  void store.clearRead()
}

function onMenuDocClick(ev: MouseEvent): void {
  if (!menuOpen.value) return
  if (!menuWrapEl.value) return
  if (!ev.target) return
  if (!menuWrapEl.value.contains(ev.target as Node)) menuOpen.value = false
}
watch(menuOpen, (isOpen) => {
  if (isOpen) document.addEventListener('click', onMenuDocClick)
  else document.removeEventListener('click', onMenuDocClick)
})

// Body scroll lock + Escape key, only active while drawer is open.
let prevBodyOverflow = ''
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close()
}
watch(open, (isOpen) => {
  if (isOpen) {
    prevBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeydown)
  } else {
    document.body.style.overflow = prevBodyOverflow
    document.removeEventListener('keydown', onKeydown)
  }
})
onScopeDispose(() => {
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = prevBodyOverflow
})

const HUMAN_KIND: Record<string, string> = {
  mention: '提到了你',
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
  <button
    class="bell-btn"
    type="button"
    aria-label="通知"
    :aria-expanded="open"
    @click="toggle"
  >
    <svg
      class="bell-icon"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span v-if="unreadDisplay" class="bell-badge">{{ unreadDisplay }}</span>
  </button>

  <Teleport to="body">
    <Transition name="nd-backdrop">
      <div v-if="open" class="nd-backdrop" @click="close" />
    </Transition>
    <Transition name="nd-panel">
      <aside
        v-if="open"
        class="nd-panel"
        role="dialog"
        aria-label="通知中心"
        aria-modal="true"
      >
        <header class="nd-head">
          <h2 class="nd-title">通知</h2>
          <button
            v-if="store.unreadCount > 0"
            class="nd-mark-all"
            type="button"
            @click="onMarkAll"
          >
            全部标为已读
          </button>
          <div ref="menuWrapEl" class="nd-menu-wrap">
            <button
              class="nd-kebab"
              type="button"
              aria-label="更多操作"
              @click.stop="menuOpen = !menuOpen"
            >
              <span class="material-symbols-outlined">more_vert</span>
            </button>
            <div v-if="menuOpen" class="nd-menu" role="menu">
              <button
                type="button"
                class="nd-menu-item is-danger"
                @click="onClearRead"
              >
                清空已读
              </button>
            </div>
          </div>
          <button class="nd-close" type="button" aria-label="关闭" @click="close">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>
        <div class="nd-tabs" role="tablist">
          <button
            v-for="t in tabs"
            :key="t.key"
            class="nd-tab"
            :class="{ 'is-active': activeTab === t.key }"
            type="button"
            role="tab"
            :aria-selected="activeTab === t.key"
            @click="activeTab = t.key"
          >
            <span>{{ t.label }}</span>
            <span class="nd-tab-count">{{ t.count }}</span>
          </button>
        </div>
        <div class="nd-list">
          <div v-if="visibleItems.length === 0" class="nd-empty">
            <span class="material-symbols-outlined nd-empty-icon">notifications_none</span>
            <p>{{ activeTab === 'unread' ? '没有未读通知' : '暂无通知' }}</p>
          </div>
          <button
            v-for="n in visibleItems"
            :key="n.id"
            class="nd-row"
            :class="{ 'is-unread': !n.isRead }"
            type="button"
            @click="onItemClick(n.id, n.pageId)"
          >
            <span class="nd-avatar" :style="{ background: n.actorColor ?? '#0052CC' }">
              {{ (n.actorName ?? n.actorId).slice(0, 1) }}
            </span>
            <span class="nd-text">
              <span class="nd-line1">
                <strong class="nd-actor">{{ n.actorName ?? n.actorId }}</strong>
                <span class="nd-kind">{{ HUMAN_KIND[n.kind] ?? '通知' }}</span>
              </span>
              <span class="nd-page">{{ n.pageTitle ?? '(已删除)' }}</span>
            </span>
            <span class="nd-time">{{ relTime(n.createdAt) }}</span>
          </button>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
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
.bell-icon {
  width: 18px;
  height: 18px;
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

.nd-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(9, 30, 66, 0.32);
  z-index: 9998;
}

.nd-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 440px;
  max-width: 100vw;
  background: var(--bg, #fff);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  z-index: 9999;
}

.nd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border, #ebeef0);
  flex-shrink: 0;
}
.nd-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1, #172b4d);
  margin: 0;
  flex: 1;
}
.nd-mark-all {
  background: transparent;
  border: 0;
  color: var(--accent, #0052cc);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 4px;
}
.nd-mark-all:hover {
  background: rgba(0, 82, 204, 0.08);
}
.nd-close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2, #42526e);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.nd-close:hover {
  background: var(--hover-bg, #f4f5f7);
}
.nd-close .material-symbols-outlined {
  font-size: 18px;
}

.nd-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #ebeef0);
  flex-shrink: 0;
}
.nd-tab {
  background: transparent;
  border: 0;
  padding: 6px 12px;
  border-radius: 16px;
  font-size: 13px;
  color: var(--text-2, #42526e);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.nd-tab:hover {
  background: var(--hover-bg, #f4f5f7);
}
.nd-tab.is-active {
  background: rgba(0, 82, 204, 0.08);
  color: var(--accent, #0052cc);
  font-weight: 600;
}
.nd-tab-count {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--hover-bg, #f4f5f7);
  color: var(--text-3, #5e6c84);
  min-width: 18px;
  text-align: center;
}
.nd-tab.is-active .nd-tab-count {
  background: var(--accent, #0052cc);
  color: #fff;
}

.nd-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.nd-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--text-3, #5e6c84);
  gap: 12px;
}
.nd-empty-icon {
  font-size: 40px;
  opacity: 0.5;
}
.nd-empty p {
  margin: 0;
  font-size: 13px;
}
.nd-row {
  display: grid;
  grid-template-columns: 36px 1fr auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border, #ebeef0);
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
  position: relative;
  transition: background 100ms ease;
}
.nd-row:hover {
  background: var(--hover-bg, #f4f5f7);
}
.nd-row.is-unread {
  background: rgba(0, 82, 204, 0.04);
}
.nd-row.is-unread::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent, #0052cc);
}
.nd-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.nd-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.nd-line1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.nd-actor {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1, #172b4d);
  white-space: nowrap;
  flex-shrink: 0;
}
.nd-kind {
  font-size: 12px;
  color: var(--text-2, #42526e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nd-page {
  font-size: 12px;
  color: var(--text-3, #5e6c84);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nd-time {
  font-size: 11px;
  color: var(--text-3, #5e6c84);
  white-space: nowrap;
  flex-shrink: 0;
}

.nd-menu-wrap {
  position: relative;
}
.nd-kebab {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2, #42526e);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.nd-kebab:hover {
  background: var(--hover-bg, #f4f5f7);
}
.nd-kebab .material-symbols-outlined {
  font-size: 18px;
}
.nd-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 160px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
  z-index: 10000;
  padding: 4px 0;
}
.nd-menu-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  font-size: 13px;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
}
.nd-menu-item:hover {
  background: var(--hover-bg, #f4f5f7);
}
.nd-menu-item.is-danger {
  color: var(--danger, #de350b);
}

.nd-backdrop-enter-active,
.nd-backdrop-leave-active {
  transition: opacity 200ms ease;
}
.nd-backdrop-enter-from,
.nd-backdrop-leave-to {
  opacity: 0;
}

.nd-panel-enter-active,
.nd-panel-leave-active {
  transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
}
.nd-panel-enter-from,
.nd-panel-leave-to {
  transform: translateX(100%);
}
</style>