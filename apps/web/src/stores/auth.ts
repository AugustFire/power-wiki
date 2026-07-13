/**
 * Auth store — Pinia setup store for the current session.
 *
 * Responsibilities:
 *   - Hold the current `User` (null if signed out)
 *   - Track `mustResetPassword` (true on first login for newly-created users)
 *   - Provide init / login / logout / resetPassword actions
 *   - Expose `isAdmin` / `isAuthed` / `needsPasswordReset` computed
 *
 * `init()` is idempotent (multiple callers re-use the same promise). It runs
 * once at app boot via `router.beforeEach` to populate the user before the
 * first navigation decision.
 *
 * The `mustResetPassword` flag is sticky: it stays true until resetPassword()
 * succeeds, even across re-init() calls — because reset-password sets
 * `status='active'` and the next /api/auth/session call returns mustReset=false.
 *
 * Errors thrown from login/logout/resetPassword propagate to the caller so
 * views can show a banner. The store does NOT call uiStore.setError() itself —
 * the views own their error UX (login form, topbar menu).
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { User } from '@power-wiki/shared'
import { api } from '@/lib/api'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useManagerActions } from '@/composables/useManagerActions'
import { usePageVersions } from '@/composables/usePageVersions'
import { useRecentPages } from '@/composables/useRecentPages'
import { useUiStore } from '@/stores/ui'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const mustResetPassword = ref(false)
  /**
   * Personal space id for the current user (kind='personal', ownerId=me).
   * Server returns this from sign-in / session / reset-password responses so
   * the sidebar and /me route can resolve it without an extra round-trip.
   * null when the user has no personal space yet (defensive — bootstrap should
   * always create one).
   */
  const personalSpaceId = ref<string | null>(null)
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const loadError = ref<string | null>(null)
  /**
   * True during the LoginView → destination transition. App.vue shows a
   * centered boot spinner while this is set, so the brief unmount frame
   * between LoginView (unauthed branch) and the authed shell doesn't flash
   * blank. LoginView sets it after auth.login() resolves and clears it
   * once router.replace() has settled on the destination.
   */
  const transitioning = ref(false)

  // Module-scoped so concurrent init() callers share the same promise.
  // We keep this outside the store factory since the store factory re-runs
  // in HMR — the flag needs to survive across hot-reloads of the auth store.
  const initRef = { current: null as Promise<void> | null }

  const isAuthed = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  const needsPasswordReset = computed(() => mustResetPassword.value && isAuthed.value)

  /**
   * Fetches the current session from /api/auth/session. Safe to call multiple
   * times — concurrent calls share one promise.
   *
   * Throws only on unexpected errors (network down). A 401 response is
   * silently treated as "not signed in" — NOT an error condition.
   */
  function init(): Promise<void> {
    if (initRef.current) return initRef.current
    // Only flip status to 'loading' on the FIRST call. After the initial
    // boot init resolves, status is 'ready' (or 'error'). Subsequent calls
    // — router.beforeEach re-fires init() on every route change — must
    // leave status alone, otherwise App.vue's `showBoot` computed (which
    // keys off status === 'loading') flips to true and unmounts the entire
    // RouterView, replacing it with the auth-boot spinner. That mid-route
    // unmount interrupts any in-flight EditView / Dashboard lifecycle and
    // causes an infinite mount → unmount → re-mount loop, manifesting as
    // a hang when navigating during auth init.
    if (status.value === 'idle') status.value = 'loading'
    initRef.current = (async () => {
      try {
        try {
          const { user: u, mustResetPassword: mrp, personalSpaceId: psid } =
            await api.auth.getSession()
          user.value = u
          mustResetPassword.value = mrp
          personalSpaceId.value = psid
          status.value = 'ready'
          loadError.value = null
          // M2: 拿到 user 后立刻从 server 拉一次 recents,覆盖 localStorage 离线
          // 缓存,实现跨设备同步。fire-and-forget —— 网络失败时本地缓存仍能用。
          // (login() 也会在登入后调一次。)
          if (user.value) void useRecentPages().syncFromServer()
        } catch (e) {
          // 401 = not signed in; any other error is a real failure.
          const err = e as { status?: number; message?: string }
          if (err.status === 401) {
            user.value = null
            mustResetPassword.value = false
            personalSpaceId.value = null
            status.value = 'ready'
            loadError.value = null
          } else {
            loadError.value = err.message ?? 'session check failed'
            status.value = 'error'
          }
        }
      } finally {
        initRef.current = null
      }
    })()
    return initRef.current
  }

  async function login(email: string, password: string): Promise<void> {
    // Clear any in-memory data from the previous session BEFORE setting the
    // new user. The new session's first view will re-init() the stores, but
    // until then we don't want stale data leaking (e.g. the sidebar still
    // showing the old user's page tree).
    resetSessionState()
    const { user: u, mustResetPassword: mrp, personalSpaceId: psid } =
      await api.auth.signIn({ email, password })
    user.value = u
    mustResetPassword.value = mrp
    personalSpaceId.value = psid
    status.value = 'ready'
    loadError.value = null
    // M2: 登入后从 server 拉一次 recents 覆盖 localStorage,实现跨设备
    // 同步。fire-and-forget。
    void useRecentPages().syncFromServer()
  }

  async function logout(): Promise<void> {
    await api.auth.signOut()
    user.value = null
    mustResetPassword.value = false
    personalSpaceId.value = null
    // Drop every data store the previous user populated. Without this the
    // next user would see the old page tree, the old trashed list, and a
    // 401 from `/api/pages/trash?space=<oldSpaceId>` (because the new user
    // can't access the previous user's last-selected space).
    resetSessionState()
  }

  /**
   * Stage 5d: wipe all in-memory state tied to the current session.
   * Called from both login() and logout() so the next user starts with a
   * clean slate. Idempotent and safe to call on any state.
   */
  function resetSessionState(): void {
    usePagesStore().reset()
    useSpacesStore().reset()
    useManagerActions().resetAll()
    usePageVersions().invalidate()
    // 清掉 recents — 这是 per-device 的本地数据,但登出后下一个用户看到
    // 前任的访问历史仍然不对劲。localStorage 是当前登录态的边界,清空。
    useRecentPages().clear()
    useUiStore().clearError()
  }

  async function resetPassword(currentPassword: string, newPassword: string): Promise<void> {
    const { user: u, personalSpaceId: psid } = await api.auth.resetPassword({
      currentPassword,
      newPassword,
    })
    user.value = u
    mustResetPassword.value = false
    personalSpaceId.value = psid
  }

  return {
    // state
    user,
    mustResetPassword,
    personalSpaceId,
    status,
    loadError,
    transitioning,
    // computed
    isAuthed,
    isAdmin,
    needsPasswordReset,
    // actions
    init,
    login,
    logout,
    resetPassword,
  }
})