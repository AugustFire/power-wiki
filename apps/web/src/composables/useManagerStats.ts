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
 * M17: server-side filter — `userFilters` (q/status/role) is a reactive
 * object watched with 300ms debounce. On change → reset offset → refetch.
 * `users.value` 现在是「当前 filter + paginated」结果(不再是全量第一页)。
 * `systemStats` 是 server 聚合的 system-wide 概览,独立于 filter,
 * 给 PeopleContextPanel 用 —— filter 不污染 dashboard。
 *
 * Page size caps at 200, matching the existing `?limit=` ceiling.
 * For teams above 200, loadMore() extends the list.
 */
import { reactive, ref, watch } from 'vue'
import { debounce } from '@/lib/debounce'
import { api } from '@/lib/api'
import type {
  AdminUsersListQuery,
  AdminUsersListResponse,
  User,
  UserGroup,
  UserSystemStats,
} from '@power-wiki/shared'

const users = ref<User[]>([])
const groups = ref<UserGroup[]>([])

const usersLoading = ref(false)
const usersRefreshing = ref(false)
const usersError = ref<unknown>(null)
let usersPromise: Promise<void> | null = null
let usersOffset = 0
const usersHasMore = ref(false)
/** 匹配当前 filter 的总行数;无 filter = 全表总行数。来自 server 响应。 */
const usersTotal = ref(0)
/** System-wide 概览 —— 不受 filter 影响,PeopleContextPanel 用。 */
const usersSystemStats = ref<UserSystemStats | null>(null)

const groupsLoading = ref(false)
const groupsRefreshing = ref(false)
const groupsError = ref<unknown>(null)
let groupsPromise: Promise<void> | null = null
let groupsOffset = 0
const groupsHasMore = ref(false)

const PAGE_SIZE = 200
const FILTER_DEBOUNCE_MS = 300

/**
 * M17 filter state。reactive 而不是 ref:filter 多了之后一组值用 reactive
 * 比一组独立 ref 更顺手(set 是原子的,不会中间态触发 watch)。空字符串 /
 * undefined 都视为「不过滤」,server 端 `q: '' / undefined` 等价。
 */
const userFilters = reactive<{
  q: string
  status: AdminUsersListQuery['status']
  role: AdminUsersListQuery['role']
}>({
  q: '',
  status: undefined,
  role: undefined,
})

/** Compose the current filter + offset into a query the server understands. */
function currentUsersQuery(offset: number): AdminUsersListQuery {
  return {
    limit: PAGE_SIZE,
    offset,
    q: userFilters.q || undefined,
    status: userFilters.status,
    role: userFilters.role,
  }
}

async function loadUsersPage(offset: number, refresh: boolean): Promise<void> {
  if (refresh) usersRefreshing.value = true
  else usersLoading.value = true
  usersError.value = null
  try {
    const result: AdminUsersListResponse = await api.admin.users.list(
      currentUsersQuery(offset),
    )
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
    usersTotal.value = result.total
    usersSystemStats.value = result.systemStats
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
  if (users.value.length > 0 && !hasActiveFilter()) return
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

/**
 * M17: filter watcher + helpers.filter 改动 → 300ms debounce → 重新拉第一页。
 * `usersOffset` 必须在 refetch 前 reset,否则 server 会按旧 offset 算分页,
 * 漏掉新 filter 的前几行。
 */
const debouncedRefetch = debounce(() => {
  usersOffset = 0
  void refreshUsers()
}, FILTER_DEBOUNCE_MS)

function hasActiveFilter(): boolean {
  return userFilters.q !== '' || userFilters.status !== undefined || userFilters.role !== undefined
}

watch(
  () => [userFilters.q, userFilters.status, userFilters.role],
  () => {
    // Always refetch on filter change. `loadUsersPage(0, …)` 跑
    // `SELECT COUNT(*) FILTER + items` + systemStats 三个并发 query,
    // 单次 RTT,300ms debounce 后才发 —— 打字过程中不会每按一个键都
    // 触发一次 round-trip。
    debouncedRefetch()
  },
)

/**
 * Reset all filters to the empty state. Used by the toolbar's
 * 「清空筛选」 button. Does NOT auto-refetch — caller can chain
 * refreshUsers() if needed, but the watcher on filter change will
 * also fire (filters changed).
 */
function clearUserFilters(): void {
  userFilters.q = ''
  userFilters.status = undefined
  userFilters.role = undefined
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
    usersTotal,
    usersSystemStats,

    /* M17 filter state */
    userFilters,
    hasActiveFilter,
    clearUserFilters,

    /* Actions */
    ensureUsersLoaded,
    ensureGroupsLoaded,
    loadMoreUsers,
    loadMoreGroups,
    refreshUsers,
    refreshGroups,

    /* CRUD sync helpers */
    upsertUser(u: User): void {
      // M17: server-side filter 之后,upsert 进来的 user 未必在当前 filter 视图里。
      // 简单的策略:无脑 push 到 users.value + usersTotal++。filter 不匹配时
      // 这一行会被下一次 refetch 冲掉,但中间的 optimistic 渲染正确。
      // For now, append-if-missing; subsequent refetch will reconcile.
      const idx = users.value.findIndex((x) => x.id === u.id)
      if (idx >= 0) users.value[idx] = u
      else {
        users.value.push(u)
        usersTotal.value += 1
      }
    },
    removeUser(id: string): void {
      const idx = users.value.findIndex((x) => x.id === id)
      if (idx >= 0) {
        users.value.splice(idx, 1)
        usersTotal.value = Math.max(0, usersTotal.value - 1)
      }
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
      usersTotal.value = 0
      usersSystemStats.value = null
      usersOffset = 0
      groupsOffset = 0
      usersPromise = null
      groupsPromise = null
      // Also reset filters — stale filter from previous user shouldn't
      // bleed into a fresh login.
      clearUserFilters()
    },
  }
}
