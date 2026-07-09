/**
 * useRecentActivity — P1-3 workspace-wide 活动流的 view-scoped 数据拉取。
 *
 * 没用模块级 singleton + poll(不像 useNotifications 那样后台轮询):
 * 活动流是用户主动打开的视图(/activity 路由),打开时拉一次 + manual 刷新
 * 足够。每次进路由都重新拉,反映「刚才有人改了 X」的近实时。
 *
 * 分页(2026-07):后端按 limit/offset 返 20/页,hasMore=true 时前端调
 * loadMore() append。view 卸载时不必显式清理(ref 在组件 scope 里自动 GC)。
 *
 * 不持久化(per docs/product-analysis.md §P1-3)— 关页面就丢,下次打开再拉。
 */
import { reactive } from 'vue'
import { api } from '@/lib/api'
import type { ActivityEvent } from '@power-wiki/shared'

const PAGE_SIZE = 20

interface ActivityState {
  items: ActivityEvent[]
  loading: boolean
  /** 加载更多中的独立 flag,避免覆盖整列的 skeleton。 */
  loadingMore: boolean
  /** 'all' = 不过滤,其他值 = spaceId */
  spaceId: string | null
  offset: number
  hasMore: boolean
  error: string | null
}

export function useRecentActivity() {
  const state = reactive<ActivityState>({
    items: [],
    loading: false,
    loadingMore: false,
    spaceId: null,
    offset: 0,
    hasMore: false,
    error: null,
  })

  /** 重置到第一页(进路由 / filter 切换 / 点刷新)。替换 items。 */
  async function load(spaceId: string | null = state.spaceId): Promise<void> {
    state.loading = true
    state.error = null
    state.spaceId = spaceId
    state.offset = 0
    try {
      const res = await api.pages.activity(spaceId, PAGE_SIZE, 0)
      state.items = res.items
      state.hasMore = res.hasMore
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载失败'
      state.error = msg
      state.items = []
      state.hasMore = false
    } finally {
      state.loading = false
    }
  }

  /**
   * 加载下一页 — offset += PAGE_SIZE,append 到现有 items。hasMore=false
   * 时静默 no-op(按钮 disabled,但代码路径仍走)。state.spaceId 必须跟当前
   * 一致(view 自己保证,不会跨 filter 翻页)。
   */
  async function loadMore(): Promise<void> {
    if (state.loading || state.loadingMore || !state.hasMore) return
    state.loadingMore = true
    state.error = null
    const nextOffset = state.offset + PAGE_SIZE
    try {
      const res = await api.pages.activity(state.spaceId, PAGE_SIZE, nextOffset)
      state.items = state.items.concat(res.items)
      state.offset = nextOffset
      state.hasMore = res.hasMore
    } catch (e) {
      state.error = e instanceof Error ? e.message : '加载更多失败'
    } finally {
      state.loadingMore = false
    }
  }

  return { state, load, loadMore }
}
