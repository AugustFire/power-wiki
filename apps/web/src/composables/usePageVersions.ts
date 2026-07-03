/**
 * usePageVersions — module-scoped singleton for per-page version history.
 *
 * Why module-scoped (not Pinia store): versions are scoped to a single
 * page id and only matter while that page is open. The list is loaded
 * on demand by VersionPanel and shared across mounts (e.g. close + reopen
 * the panel — no re-fetch). Mutations invalidate the cache for that page
 * id only.
 *
 * Promise cache (matches useManagerStats pattern): concurrent callers
 * within the same tick share one in-flight request.
 *
 * Retention is 30 versions per page on the server; the panel paginates
 * via `loadMore` so users on long-running pages don't pay for everything
 * upfront.
 */
import { reactive } from 'vue'
import { api } from '@/lib/api'
import type { PageNode, PageVersion, Paginated } from '@power-wiki/shared'

interface PageState {
  versions: PageVersion[]
  loading: boolean
  hasMore: boolean
  offset: number
  /** Promise shared by concurrent ensureLoaded() callers. */
  inflight: Promise<void> | null
}

const PAGE_SIZE = 20
const byPage = new Map<string, PageState>()

function get(pageId: string): PageState {
  let s = byPage.get(pageId)
  if (!s) {
    s = reactive({
      versions: [],
      loading: false,
      hasMore: false,
      offset: 0,
      inflight: null,
    }) as PageState
    byPage.set(pageId, s)
  }
  return s
}

async function loadPage(pageId: string, offset: number): Promise<void> {
  const state = get(pageId)
  state.loading = true
  try {
    const result: Paginated<PageVersion> = await api.pageVersions.list(pageId, {
      limit: PAGE_SIZE,
      offset,
    })
    if (offset === 0) state.versions = result.items
    else {
      // Dedup by id (defensive — server should be stable).
      const seen = new Set(state.versions.map((v) => v.id))
      for (const v of result.items) if (!seen.has(v.id)) state.versions.push(v)
    }
    state.offset = offset + result.items.length
    state.hasMore = result.hasMore
  } finally {
    state.loading = false
  }
}

async function ensureLoaded(pageId: string): Promise<void> {
  const state = get(pageId)
  if (state.versions.length > 0 || state.loading) return
  if (state.inflight) return state.inflight
  state.inflight = loadPage(pageId, 0).finally(() => {
    state.inflight = null
  })
  return state.inflight
}

async function loadMore(pageId: string): Promise<void> {
  const state = get(pageId)
  if (!state.hasMore || state.loading) return
  await loadPage(pageId, state.offset)
}

/**
 * Restore a version. Backend inserts a new version row + updates the
 * page; we return the updated PageNode so the caller can sync the
 * page store + refresh the version list itself.
 *
 * 注意:这里**不**调 byPage.delete(pageId)。`refresh` 改用 loadPage(0)
 * 全量覆盖到同一个 reactive 上,保留引用稳定,避免响应式断链 —— 详见
 * `refresh` 注释。调用方在拿到 updated PageNode 后应该:
 *   1. 把 updated 写回 pagesStore(让 read view 看到新内容)
 *   2. 调 `refresh(pageId)` 重拉 version 列表(让用户看到新的"restored from vN"行)
 */
async function restore(pageId: string, versionId: string): Promise<PageNode> {
  return api.pageVersions.restore(pageId, versionId)
}

async function refresh(pageId: string): Promise<void> {
  // 用户每次打开版本历史面板都强制重拉 —— 边界快照在 EditView idle / route
  // leave 时打,别的标签页 / 同事都可能在写当前 page,缓存会过时。
  //
  // 注意:这里**不**调 byPage.delete(pageId)。如果删了,后续 loadPage 的
  // get(pageId) 会创建一个**新** reactive,父组件已经收集了**旧** reactive
  // 的版本数组 dep,新 reactive 写入数据时不会通知旧 dep —— sortedVersions
  // computed / watch 永远收不到更新,history 页就空白。
  // loadPage(0) 已经会把 offset===0 的全量覆盖到同一个 reactive 上,语义
  // 等同于"清缓存 + 拉新",但保留了 reactive 引用,响应式不破。
  const state = get(pageId)
  state.offset = 0
  state.hasMore = false
  return loadPage(pageId, 0)
}

/** Called from auth.resetSessionState on login/logout. */
function invalidate(): void {
  byPage.clear()
}

export function usePageVersions() {
  return {
    ensureLoaded,
    refresh,
    loadMore,
    restore,
    invalidate,
    /** Reactive state accessor for a single page. */
    state: (pageId: string): PageState => get(pageId),
  }
}