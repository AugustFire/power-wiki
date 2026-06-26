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

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const mustResetPassword = ref(false)
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const loadError = ref<string | null>(null)

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
    status.value = 'loading'
    initRef.current = (async () => {
      try {
        try {
          const { user: u, mustResetPassword: mrp } = await api.auth.getSession()
          user.value = u
          mustResetPassword.value = mrp
          status.value = 'ready'
          loadError.value = null
        } catch (e) {
          // 401 = not signed in; any other error is a real failure.
          const err = e as { status?: number; message?: string }
          if (err.status === 401) {
            user.value = null
            mustResetPassword.value = false
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
    const { user: u, mustResetPassword: mrp } = await api.auth.signIn({ email, password })
    user.value = u
    mustResetPassword.value = mrp
    status.value = 'ready'
    loadError.value = null
  }

  async function logout(): Promise<void> {
    await api.auth.signOut()
    user.value = null
    mustResetPassword.value = false
  }

  async function resetPassword(currentPassword: string, newPassword: string): Promise<void> {
    const { user: u } = await api.auth.resetPassword({ currentPassword, newPassword })
    user.value = u
    mustResetPassword.value = false
  }

  return {
    // state
    user,
    mustResetPassword,
    status,
    loadError,
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