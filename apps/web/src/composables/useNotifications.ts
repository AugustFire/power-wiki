/**
 * useNotifications — Stage 6 module-level composable.
 *
 * Mirrors the `useManagerStats` pattern: a single promise cache + reactive
 * state shared across all callers. The most-cited benefit here is the bell
 * (`NotificationBell.vue` in TopBar) AND the `/notifications` route being
 * able to share the same in-memory data without re-fetching on mount.
 *
 * Three jobs:
 *   1. **First-load caching** — `ensureLoaded()` returns immediately if
 *      data is already loaded, otherwise kicks off a single fetch that
 *      subsequent callers piggy-back on.
 *   2. **Bell poll** — `startPolling()` registers a 30s interval that calls
 *      `refreshUnread()`. Pauses while the tab is hidden (`document.hidden`)
 *      and resumes on `visibilitychange`. Stops on `stopPolling()`.
 *   3. **Auth-driven invalidation** — watch `auth.isAuthed`; on login
 *      start polling + ensure load; on logout stop + reset().
 *
 * The composable is invoked once at app boot (App.vue `setup()`) — its
 * side-effects (watch, interval) live for the lifetime of the SPA. The
 * returned functions are what components consume.
 */
import { watch } from 'vue'
import { useNotificationsStore } from '@/stores/notifications'
import { useAuthStore } from '@/stores/auth'

const POLL_MS = 30_000

let bootPromise: Promise<void> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * Lazy one-shot fetch of the inbox + unread count. Shared across concurrent
 * callers — second caller piggy-backs on the first one's network roundtrip.
 */
async function ensureLoaded(): Promise<void> {
  const store = useNotificationsStore()
  if (store.loaded) return
  if (bootPromise) return bootPromise
  bootPromise = (async () => {
    await store.load(false)
    await store.refreshUnread()
  })().finally(() => {
    bootPromise = null
  })
  return bootPromise
}

async function tickPoll(): Promise<void> {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return
  }
  const store = useNotificationsStore()
  await store.refreshUnread()
}

function startPolling(): void {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    void tickPoll()
  }, POLL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function invalidate(): void {
  stopPolling()
  bootPromise = null
  const store = useNotificationsStore()
  store.reset()
}

let bootWatcherInstalled = false

export function useNotifications(): {
  ensureLoaded: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  invalidate: () => void
} {
  // First-call side effects: wire the auth watcher once.
  if (!bootWatcherInstalled) {
    bootWatcherInstalled = true
    const auth = useAuthStore()
    watch(
      () => auth.isAuthed,
      (v) => {
        if (v) {
          // Login: start polling + lazy first-load.
          startPolling()
          void ensureLoaded()
        } else {
          // Logout: stop + drop state.
          invalidate()
        }
      },
      { immediate: true },
    )
    // Cross-tab visibility — resume polling on focus so we catch fresh
    // notifications promptly after backgrounding.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void tickPoll()
        }
      })
    }
  }

  return {
    ensureLoaded,
    startPolling,
    stopPolling,
    invalidate,
  }
}
