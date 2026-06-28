/**
 * Spaces store — Stage 4c.
 *
 *   - Holds the list of spaces the current user can see.
 *   - Tracks `activeSpaceId` (which space the sidebar / HomeView is scoped to).
 *   - Persists `activeSpaceId` to localStorage so reload keeps the user where they were.
 *   - Admin CRUD wrappers (createSpace / updateSpace / deleteSpace / setAccess)
 *     all refresh the list on success.
 *
 * The active space has to be one of the visible spaces — the server returns 404
 * for any page outside the active user's accessible set, so switching to a space
 * the user can't actually access would just render an empty tree.
 */
import { computed, ref, watch } from 'vue'
import type { CreateSpaceInput, SetSpaceAccessInput, Space, UpdateSpaceInput } from '@power-wiki/shared'
import { PERSIST_KEYS } from '@power-wiki/shared/keys'
import { api } from '@/lib/api'
import { readJSON, writeJSON } from '@/lib/storage'

const spaces = ref<Space[]>([])
const activeSpaceId = ref<string | null>(readJSON<string | null>(PERSIST_KEYS.ACTIVE_SPACE, null))
const loading = ref(false)
const loaded = ref(false)
const loadError = ref<string | null>(null)

export function useSpacesStore() {
  const visible = computed(() => spaces.value)
  const activeSpace = computed(
    () => spaces.value.find((s) => s.id === activeSpaceId.value) ?? null,
  )

  /** Persist activeSpaceId whenever it changes. */
  watch(
    activeSpaceId,
    (id) => {
      writeJSON(PERSIST_KEYS.ACTIVE_SPACE, id)
    },
    { flush: 'post' },
  )

  async function init() {
    if (loaded.value || loading.value) return
    loading.value = true
    loadError.value = null
    try {
      spaces.value = await api.spaces.list()
      // Active space resolution priority:
      //   1. Persisted ID, if still visible
      //   2. First space in the list
      //   3. null (user has no accessible spaces — sidebar will show empty state)
      const persisted = activeSpaceId.value
      if (persisted && spaces.value.some((s) => s.id === persisted)) {
        activeSpaceId.value = persisted
      } else if (!activeSpaceId.value && spaces.value.length > 0) {
        activeSpaceId.value = spaces.value[0]!.id
      } else if (activeSpaceId.value && !spaces.value.some((s) => s.id === activeSpaceId.value)) {
        // Persisted space no longer visible (removed from groups). Fall back.
        activeSpaceId.value = spaces.value[0]?.id ?? null
      }
      loaded.value = true
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : 'failed to load spaces'
      throw e
    } finally {
      loading.value = false
    }
  }

  /** Re-fetch the list — used after admin operations and after sign-out. */
  async function refresh() {
    loaded.value = false
    await init()
  }

  /**
   * Stage 5d: drop all in-memory state including the persisted active-space
   * id. Called by auth.logout() / auth.login() so the next user doesn't
   * inherit the previous user's space selection (which they likely can't
   * access — would 401 the trash page).
   */
  function reset(): void {
    spaces.value = []
    activeSpaceId.value = null
    loaded.value = false
    loading.value = false
    loadError.value = null
    // Wipe the persisted active-space too, so the next init() picks
    // the first visible space (or null if the new user has none).
    writeJSON(PERSIST_KEYS.ACTIVE_SPACE, null)
  }

  /** Switch the active space. Caller should ensure the ID is in the visible list. */
  function setActiveSpace(id: string) {
    if (spaces.value.some((s) => s.id === id)) {
      activeSpaceId.value = id
    }
  }

  /**
   * Apply an updated space in-place (from admin PATCH / PUT response).
   * Avoids a full re-fetch when the response carries the full entity.
   */
  function upsert(space: Space) {
    const idx = spaces.value.findIndex((s) => s.id === space.id)
    if (idx >= 0) spaces.value[idx] = space
    else spaces.value.push(space)
  }

  /* ─── Admin operations (manager UI) ─────────────────────────────── */

  async function createSpace(input: CreateSpaceInput): Promise<Space> {
    const created = await api.admin.spaces.create(input)
    upsert(created)
    return created
  }

  async function updateSpace(id: string, input: UpdateSpaceInput): Promise<Space> {
    const updated = await api.admin.spaces.update(id, input)
    upsert(updated)
    return updated
  }

  async function deleteSpace(id: string): Promise<void> {
    await api.admin.spaces.delete(id)
    spaces.value = spaces.value.filter((s) => s.id !== id)
    if (activeSpaceId.value === id) {
      activeSpaceId.value = spaces.value[0]?.id ?? null
    }
  }

  async function setSpaceAccess(id: string, input: SetSpaceAccessInput): Promise<Space> {
    const updated = await api.admin.spaces.setAccess(id, input)
    upsert(updated)
    return updated
  }

  return {
    // state
    spaces: visible,
    activeSpace,
    activeSpaceId,
    loading,
    loaded,
    loadError,
    // actions
    init,
    refresh,
    reset,
    setActiveSpace,
    upsert,
    createSpace,
    updateSpace,
    deleteSpace,
    setSpaceAccess,
  }
}
