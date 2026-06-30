/**
 * Notifications Pinia store — Stage 6.
 *
 * Holds the current user's inbox (read + unread) and the unread badge
 * counter. The store is intentionally thin: the heavy lifting — module-
 * level promise caching and 30s `unreadCount` polling — lives in
 * `composables/useNotifications.ts`. UI components read this store for
 * reactive bindings.
 *
 * NOT responsible for fan-out (that's the backend's `enqueueNotifications`).
 * This store only consumes.
 *
 * Mutations done here:
 *   - `load(append)` — replaces or extends `items`.
 *   - `refreshUnread()` — calls API and writes `unreadCount`.
 *   - `markRead(ids?, all)` — optimistically flips local `isRead` flags
 *     and decrements `unreadCount`. On failure the caller can retry.
 *   - `clearRead()` — drops read-only rows from `items`.
 *   - `reset()` — wipes everything (used by composable's invalidate()).
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { Notification } from '@power-wiki/shared'

const PAGE_SIZE = 50

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<Notification[]>([])
  const unreadCount = ref(0)
  const loaded = ref(false)
  const loadingMore = ref(false)
  const refreshing = ref(false)
  const hasMore = ref(false)
  let offset = 0
  const error = ref<unknown>(null)

  async function load(append = false): Promise<void> {
    if (append) {
      if (!hasMore.value || loadingMore.value) return
      loadingMore.value = true
    } else {
      refreshing.value = true
    }
    error.value = null
    try {
      const result = await api.notifications.list({ limit: PAGE_SIZE, offset: append ? offset : 0 })
      if (append) {
        items.value = [...items.value, ...result.items]
      } else {
        items.value = result.items
      }
      offset = (append ? offset : 0) + result.items.length
      hasMore.value = result.hasMore
      loaded.value = true
    } catch (e) {
      error.value = e
      throw e
    } finally {
      loadingMore.value = false
      refreshing.value = false
    }
  }

  async function loadMore(): Promise<void> {
    await load(true)
  }

  async function refreshUnread(): Promise<void> {
    try {
      const r = await api.notifications.unreadCount()
      unreadCount.value = r.count
    } catch {
      // swallow — poll is best-effort; UI stays at last known count
    }
  }

  async function markRead(ids?: string[], all = false): Promise<void> {
    await api.notifications.markRead({ ids, all })
    const now = Date.now()
    items.value = items.value.map((n) =>
      all || (ids && ids.includes(n.id))
        ? { ...n, isRead: true, readAt: now }
        : n,
    )
    // Re-count (cheap). For `all` the count should now be 0; for `ids` we
    // decrement by the number of previously-unread ids we hit (1:1 since
    // they were unread by definition of being explicitly marked).
    unreadCount.value = items.value.filter((n) => !n.isRead).length
  }

  async function clearRead(): Promise<void> {
    await api.notifications.clearAll()
    items.value = items.value.filter((n) => !n.isRead)
  }

  function reset(): void {
    items.value = []
    unreadCount.value = 0
    loaded.value = false
    hasMore.value = false
    loadingMore.value = false
    refreshing.value = false
    offset = 0
    error.value = null
  }

  return {
    items,
    unreadCount,
    loaded,
    loadingMore,
    refreshing,
    hasMore,
    error,
    load,
    loadMore,
    refreshUnread,
    markRead,
    clearRead,
    reset,
  }
})
