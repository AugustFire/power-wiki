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
import { reactive, ref, computed, watch } from 'vue'
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
/* P1-13 · 翻页游标 —— **必须是 ref**。下方 5 个派生 computed
 * (usersCurrentPage / usersPageStart / usersPageEnd / usersHasPrevPage /
 * usersHasNextPage)都直接读这个值做依赖追踪。早期版本写的是
 * `let usersPage = 0`,普通变量 → Vue 不会建立响应式依赖 →
 * loadUsersPage 写回新值后 computed 永远不重算,UI 上「第 1 / 3 页」
 * 在点下一页后纹丝不动。改成 ref(0) 后,所有派生 computed 自动
 * 跟着更新。ref 内部值在 0..totalPages-1 之间,UI 上 +1 转 1-based。*/
const usersPage = ref(0)
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

/* P1-13 · 页大小从 200 → 50 —— 之前 PAGE_SIZE=200 让 admin 一次性
 * 拉所有用户,「分页」UI 没出现。M17 时服务端分页已支持,M18 这里把
 * PAGE_SIZE 收回 50,让分页 footer 真正进入用户视野。200 行的「快加载」
 * 体感并不比 50 行的「快很多」,但 50 行让「翻页」成为 admin 用户
 * 日常动作(尤其在 200+ 行团队下)。50 也呼应 Atlassian 的标准
 * user-management pageSize。
 * P1-16a · admin 偏好 PAGE_SIZE 50 → 20:更紧凑的列表在小团队(<
 * 200 人)场景下让分页直接进视野(20 人以下不分页、20-40 一页就
 * 翻页),符合管理员「看一眼就翻」的工作节奏。更大团队(200+)
 * 之后想调,改这个常量即可,前端派生 computed + 后端 LIMIT 都
 * 跟着走。*/
const PAGE_SIZE = 20
const FILTER_DEBOUNCE_MS = 300

/* P1-13 · 派生分页状态 —— page = 当前页 (1-based);
 * totalPages = 总页数(向上取整,total<1 时也至少 1 页以便 UI 不退化为空);
 * pageStart = 当前页第一条的 1-based 序号(0 行视作「—」);
 * pageEnd = 当前页最后一条的 1-based 序号(0 行 = 0)。
 * `usersPageSize` 直接复用 const,保持单一事实来源。*/
const usersPageSize = PAGE_SIZE
const usersTotalPages = computed(() => Math.max(1, Math.ceil(usersTotal.value / usersPageSize)))
const usersPageStart = computed(() =>
  usersTotal.value === 0 ? 0 : usersPage.value * usersPageSize + 1,
)
const usersPageEnd = computed(() => {
  if (usersTotal.value === 0) return 0
  return Math.min((usersPage.value + 1) * usersPageSize, usersTotal.value)
})
/* 上一 / 下一页可用性 —— 边界检查放在 computed 里,
 * UI 直接消费,无需重复比较。*/
const usersHasPrevPage = computed(() => usersPage.value > 0)
const usersHasNextPage = computed(() => usersPage.value + 1 < usersTotalPages.value)

/** 用户当前所在页(1-based),给 UI 「第 N 页 / 共 M 页」用 */
const usersCurrentPage = computed(() => usersPage.value + 1)

/** M17 filter state。reactive 而不是 ref:filter 多了之后一组值用 reactive
 * 比一组独立 ref 更顺手(set 是原子的,不会中间态触发 watch)。空字符串 /
 * undefined 都视为「不过滤」,server 端 `q: '' / undefined` 等价。
 * P1-16 · includeAnonymized 默认 false — 默认排除已注销用户(灰名
 * 单不进首屏)。勾上才放出来。*/
const userFilters = reactive<{
  q: string
  status: AdminUsersListQuery['status']
  role: AdminUsersListQuery['role']
  includeAnonymized: boolean
}>({
  q: '',
  status: undefined,
  role: undefined,
  includeAnonymized: false,
})

/** Compose the current filter + offset into a query the server understands. */
function currentUsersQuery(offset: number): AdminUsersListQuery {
  return {
    limit: PAGE_SIZE,
    offset,
    q: userFilters.q || undefined,
    status: userFilters.status,
    role: userFilters.role,
    // 显式只把 true 发出去;false 让 server schema 走 undefined 默认
    // 路径(等价「排除 anonymized」),行为跟用户预期一致。
    includeAnonymized: userFilters.includeAnonymized || undefined,
  }
}

async function loadUsersPage(page: number, refresh: boolean): Promise<void> {
  if (refresh) usersRefreshing.value = true
  else usersLoading.value = true
  usersError.value = null
  /* P1-13 · 用 page (0-based) 而非 offset 表达位置 —— UI 思考方式
   * 是「第几页」,offset 是 server contract。两者同义 page * PAGE_SIZE,
   * 但让 store 内部统一记 page,UI/内部判断都免了 floor 转换。*/
  const offset = page * PAGE_SIZE
  try {
    const result: AdminUsersListResponse = await api.admin.users.list(
      currentUsersQuery(offset),
    )
    /* P1-13 · page-based refetch 整体替换而非 append —— 翻页时
     * 之前页的内容不再在视口里(v-if table-v-model 也接管了 pagination),
     * 保留旧 items 会占用内存 + 让 upsertUser 的 findIndex 误命中。
     * append-only 语义只对「加载更多」一档有意义;回到 page 0 时
     * 也直接走 refresh 路径(line 222)。*/
    if (refresh || page === 0) {
      users.value = result.items
    } else {
      const seen = new Set(users.value.map((u) => u.id))
      for (const u of result.items) {
        if (!seen.has(u.id)) users.value.push(u)
      }
    }
    usersPage.value = page
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
 *
 * P1-13 · page-based 版本 — 强制刷新「当前 usersPage」(不回 0 页)。
 * 之前是回到 0 页;现在 ensureUsersLoaded 是个 idempotent no-op if
 * cache 满,只有 cache 真空时才取第一页。filter 改动 由 debounced
 * refetch 统一回到 page 0(参见下方的 `debouncedRefetch`)。
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

/* P1-13 · 翻页对外接口 —— UI 直接调 next/prev/goTo,内部统一拉
 * 那一页。如果在翻页途中 filter 又改了,debouncedRefetch 会回
 * page 0 重拉 —— 这里不再做并发保护(Vue 的 reactivity 让前后
 * 请求顺序明确,但响应覆盖按 server 时序,放心)。*/
async function nextPageUsers(): Promise<void> {
  if (!usersHasNextPage.value || usersLoading.value || usersRefreshing.value) return
  await loadUsersPage(usersPage.value + 1, false)
}

async function prevPageUsers(): Promise<void> {
  if (!usersHasPrevPage.value || usersLoading.value || usersRefreshing.value) return
  await loadUsersPage(usersPage.value - 1, false)
}

async function goToPageUsers(page: number): Promise<void> {
  if (usersLoading.value || usersRefreshing.value) return
  const target = Math.max(0, Math.min(page - 1, usersTotalPages.value - 1))
  if (target === usersPage.value) return
  await loadUsersPage(target, false)
}

async function loadMoreUsers(): Promise<void> {
  /* 兼容旧入口 —— 行为是「append 下一页」,PeopleView 的 Load-more
   * 按钮还在用。语义上跟 nextPageUsers 的「翻页并 replace」不同,
   * 单独实现一份。这里不复用 nextPageUsers 是因为后者会清空
   * users.value,而 loadMore 想保留当前 items + push 新 page 的 items。
   * hasMore 仍是 result.hasMore(LIMIT N+1 探测);触发条件:
   *   - hasMore = true
   *   - 不在 loading / refreshing 中
   * 跟之前不同:之前 offset 累计,现在 page 累计。append 完后
   * 继续保留同一 page 值,直到翻页动作才改。*/
  if (!usersHasMore.value || usersLoading.value || usersRefreshing.value) return
  const nextPage = usersPage.value + 1
  await loadUsersPage(nextPage, false)
  /* loadUsersPage 内部会把 page 写回,所以这里不需要手动同步。
   * hasMore/total 同步更新。*/
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
 * P1-13:filter 改动重置 usersPage=0,跟此前 reset offset 等效 —— 把
 * filter 适配放到 page 0 是 admin 在筛选时的默认预期(「搜张三」后应该
 * 从第一页开始看,而不是停在第 5 页)。
 */
const debouncedRefetch = debounce(() => {
  usersPage.value = 0
  void refreshUsers()
}, FILTER_DEBOUNCE_MS)

function hasActiveFilter(): boolean {
  return (
    userFilters.q !== '' ||
    userFilters.status !== undefined ||
    userFilters.role !== undefined ||
    userFilters.includeAnonymized === true
  )
}

watch(
  () => [userFilters.q, userFilters.status, userFilters.role, userFilters.includeAnonymized],
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
 *
 * P1-16 · includeAnonymized 也回 false(默认「不显示灰名单」)。把
 * 全部 filter 一次性 reset 到出厂态,符合「清空筛选」字面语义。
 */
function clearUserFilters(): void {
  userFilters.q = ''
  userFilters.status = undefined
  userFilters.role = undefined
  userFilters.includeAnonymized = false
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

    /* P1-13 · 派生分页状态 */
    usersCurrentPage,
    usersTotalPages,
    usersPageSize,
    usersPageStart,
    usersPageEnd,
    usersHasPrevPage,
    usersHasNextPage,

    /* M17 filter state */
    userFilters,
    hasActiveFilter,
    clearUserFilters,

    /* Actions */
    ensureUsersLoaded,
    ensureGroupsLoaded,
    /* P1-13 · 翻页接口 — UI 优先用 next/prev/goTo,loadMoreUsers 保留
     * 作「append 下一页」别名(语义等价,因为现在翻页就是下一页)。*/
    nextPageUsers,
    prevPageUsers,
    goToPageUsers,
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
      usersPage.value = 0
      groupsOffset = 0
      usersPromise = null
      groupsPromise = null
      // Also reset filters — stale filter from previous user shouldn't
      // bleed into a fresh login.
      clearUserFilters()
    },
  }
}
