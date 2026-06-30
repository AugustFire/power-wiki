/**
 * useManagerStats — module-level singleton holding the admin users /
 * groups lists, shared between PeopleView's main table and the right-
 * side context panel PeopleContextPanel.
 *
 * Both views are mounted together (the panel comes from the router's
 * `context:` named view, so passing data through Vue props would be
 * awkward). This composable dedupes fetches by promise-caching: the
 * first caller fires the network request, subsequent callers (until
 * it resolves) await the same promise and see the same data.
 *
 * `users` / `groups` are mutable refs — callers can append (loadMore)
 * or upsert (after CRUD) and other consumers stay in sync via Vue's
 * standard reactivity. `invalidate()` clears the cache after logout
 * or admin re-auth.
 *
 * Page size caps at 200, matching the existing `?limit=` ceiling.
 * For teams above 200, loadMore() extends the list.
 */
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { User, UserGroup } from '@power-wiki/shared'

const users = ref<User[]>([])
const groups = ref<UserGroup[]>([])

const usersLoading = ref(false)
const usersRefreshing = ref(false)
const usersError = ref<unknown>(null)
let usersPromise: Promise<void> | null = null
let usersOffset = 0
const usersHasMore = ref(false)

const groupsLoading = ref(false)
const groupsRefreshing = ref(false)
const groupsError = ref<unknown>(null)
let groupsPromise: Promise<void> | null = null
let groupsOffset = 0
const groupsHasMore = ref(false)

const PAGE_SIZE = 200

async function loadUsersPage(offset: number, refresh: boolean): Promise<void> {
  if (refresh) usersRefreshing.value = true
  else usersLoading.value = true
  usersError.value = null
  try {
    const result = await api.admin.users.list({ limit: PAGE_SIZE, offset })
    if (offset === 0) {
      users.value = result.items
    } else {
      // append, dedup by id
      const seen = new Set(users.value.map((u) => u.id))
      for (const u of result.items) {
        if (!seen.has(u.id)) users.value.push(u)
      }
    }
    usersOffset = offset + result.items.length
    usersHasMore.value = result.hasMore
  } catch (e) {
    usersError.value = e
    throw e
  } finally {
    usersLoading.value = false
    usersRefreshing.value = false
  }
}

async function loadGroupsPage(offset: number, refresh: boolean): Promise<void> {
  if (refresh) groupsRefreshing.value = true
  else groupsLoading.value = true
  groupsError.value = null
  try {
    const result = await api.admin.groups.list({ limit: PAGE_SIZE, offset })
    if (offset === 0) {
      groups.value = result.items
    } else {
      const seen = new Set(groups.value.map((g) => g.id))
      for (const g of result.items) {
        if (!seen.has(g.id)) groups.value.push(g)
      }
    }
    groupsOffset = offset + result.items.length
    groupsHasMore.value = result.hasMore
  } catch (e) {
    groupsError.value = e
    throw e
  } finally {
    groupsLoading.value = false
    groupsRefreshing.value = false
  }
}

/**
 * First-time loader: only fires if the cache is empty, otherwise
 * idempotent. Subsequent callers within the same tick share the
 * in-flight promise via the cache pointer.
 */
async function ensureUsersLoaded(): Promise<void> {
  if (users.value.length > 0) return
  if (usersPromise) return usersPromise
  usersPromise = loadUsersPage(0, false).finally(() => {
    usersPromise = null
  })
  return usersPromise
}

async function ensureGroupsLoaded(): Promise<void> {
  if (groups.value.length > 0) return
  if (groupsPromise) return groupsPromise
  groupsPromise = loadGroupsPage(0, false).finally(() => {
    groupsPromise = null
  })
  return groupsPromise
}

async function loadMoreUsers(): Promise<void> {
  if (!usersHasMore.value || usersLoading.value || usersRefreshing.value) return
  await loadUsersPage(usersOffset, false)
}

async function loadMoreGroups(): Promise<void> {
  if (!groupsHasMore.value || groupsLoading.value || groupsRefreshing.value) return
  await loadGroupsPage(groupsOffset, false)
}

/** Force reload from scratch — callers do this after destructive CRUD. */
async function refreshUsers(): Promise<void> {
  await loadUsersPage(0, true)
}

async function refreshGroups(): Promise<void> {
  await loadGroupsPage(0, true)
}

export function useManagerStats() {
  return {
    /* Reactive state */
    users,
    groups,
    usersLoading,
    groupsLoading,
    usersRefreshing,
    groupsRefreshing,
    usersHasMore,
    groupsHasMore,
    usersError,
    groupsError,

    /* Actions */
    ensureUsersLoaded,
    ensureGroupsLoaded,
    loadMoreUsers,
    loadMoreGroups,
    refreshUsers,
    refreshGroups,

    /* CRUD sync helpers */
    upsertUser(u: User): void {
      const idx = users.value.findIndex((x) => x.id === u.id)
      if (idx >= 0) users.value[idx] = u
      else users.value.push(u)
    },
    removeUser(id: string): void {
      const idx = users.value.findIndex((x) => x.id === id)
      if (idx >= 0) users.value.splice(idx, 1)
    },
    upsertGroup(g: UserGroup): void {
      const idx = groups.value.findIndex((x) => x.id === g.id)
      if (idx >= 0) groups.value[idx] = g
      else groups.value.push(g)
    },
    removeGroup(id: string): void {
      const idx = groups.value.findIndex((x) => x.id === id)
      if (idx >= 0) groups.value.splice(idx, 1)
    },

    /* Cache teardown */
    invalidate(): void {
      users.value = []
      groups.value = []
      usersLoading.value = false
      groupsLoading.value = false
      usersHasMore.value = false
      groupsHasMore.value = false
      usersOffset = 0
      groupsOffset = 0
      usersPromise = null
      groupsPromise = null
    },
  }
}
