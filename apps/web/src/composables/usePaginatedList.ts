/**
 * 通用 "加载更多" 列表 composable(Stage B.1, refined B.3).
 *
 * 用法:
 *   const { items, hasMore, loading, refreshing, error, loadMore, reset } =
 *     usePaginatedList((q) => api.admin.users.list(q), { pageSize: 50 })
 *   onMounted(() => void reset())
 *   // 模板底部:
 *   //   <button v-if="hasMore" :disabled="loading" @click="loadMore">加载更多</button>
 *   //   <div v-else-if="items.length">— 已加载全部 —</div>
 *   // 顶部:
 *   //   <div v-if="refreshing" class="refreshing-bar" />
 *
 * 设计:
 * - 每次 `loadMore()` 把 `?limit=pageSize&offset=<已加载数>` 发出去;后端
 *   返 N 行 + hasMore 标志(N+1 探测法)。
 * - `reset()` 不再清空 items!直接重置 offset/hasMore 并发请求,fetch
 *   成功后整体替换 items.value。模板用 `refreshing` 状态显示一条顶部
 *   进度条,旧数据继续渲染,避免闪空白(Stage B.3 UX 修复)。
 * - `loadMore()` 在 hasMore=false 或已经在 loading 时是 no-op,防止
 *   并发点击拉多次。
 * - `refreshing` 与 `loading` 是两个独立信号:loading 只在追加下一页时
 *   为 true(驱动"加载更多"按钮的 disable);refreshing 只在 reset()
 *   期间为 true(驱动顶部细进度条)。
 */
import { ref, type Ref } from 'vue'
import type { Paginated, PaginatedQuery } from '@power-wiki/shared'

export interface UsePaginatedListOptions {
  /** 每次加载的行数(传给后端 ?limit=);默认 50。 */
  pageSize?: number
}

export interface UsePaginatedListReturn<T> {
  items: Ref<T[]>
  hasMore: Ref<boolean>
  loading: Ref<boolean>
  /** True while a `reset()` round-trip is in flight. The view can show
   *  a top progress bar (`.refreshing-bar`) without flashing a blank
   *  table — old `items` stay visible until the new batch arrives. */
  refreshing: Ref<boolean>
  error: Ref<unknown>
  offset: Ref<number>
  /** 拉下一批;hasMore=false 或已在 loading 时是 no-op。 */
  loadMore: () => Promise<void>
  /** 保留旧 items 重新拉第一页;CRUD 后用于重新同步。 */
  reset: () => Promise<void>
}

export function usePaginatedList<T>(
  method: (q: PaginatedQuery) => Promise<Paginated<T>>,
  options?: UsePaginatedListOptions,
): UsePaginatedListReturn<T> {
  const pageSize = options?.pageSize ?? 50
  const items: Ref<T[]> = ref([])
  const hasMore = ref(false)
  const loading = ref(false)
  const refreshing = ref(false)
  const error = ref<unknown>(null)
  const offset = ref(0)

  async function loadMore(): Promise<void> {
    // Guard: 已在 loading 时忽略并发点击;已加载全部时也忽略(但允许首次
    // reset 后第一次调用,此时 items 为空且 hasMore 为 false — offset=0
    // 仍然需要拉,后端会返完整第一页)。
    if (loading.value) return
    if (!hasMore.value && items.value.length > 0) return
    loading.value = true
    error.value = null
    try {
      const result = await method({ limit: pageSize, offset: offset.value })
      items.value.push(...result.items)
      offset.value += result.items.length
      hasMore.value = result.hasMore
      // Defense:server reports hasMore=true 但返了 0 items —— 这种矛盾
      // 应该不会出现(N+1 LIMIT 逻辑保证 rows.length > limit ↔ 有更多),
      // 但万一出现兜一下,免得 button 永远在转圈。Items 数增长 0 +
      // hasMore=false 即「这次真的没东西」,后续 guard 直接挡住重试。
      if (result.items.length === 0 && result.hasMore) {
        hasMore.value = false
      }
    } catch (e) {
      error.value = e
    } finally {
      loading.value = false
    }
  }

  async function reset(): Promise<void> {
    // B.3: keep stale items visible — the view renders them as the
    // background while a top "refreshing" bar runs. Replace the whole
    // list atomically when the new batch arrives.
    refreshing.value = true
    offset.value = 0
    hasMore.value = false
    error.value = null
    try {
      const result = await method({ limit: pageSize, offset: 0 })
      items.value = result.items
      offset.value = result.items.length
      hasMore.value = result.hasMore
    } catch (e) {
      error.value = e
    } finally {
      refreshing.value = false
    }
  }

  return { items, hasMore, loading, refreshing, error, offset, loadMore, reset }
}