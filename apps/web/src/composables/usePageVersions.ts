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
 * page; we drop the cache + return the updated PageNode so the caller
 * can sync the page store immediately.
 */
async function restore(pageId: string, versionId: string): Promise<PageNode> {
  const updated = await api.pageVersions.restore(pageId, versionId)
  byPage.delete(pageId)
  return updated
}

async function refresh(pageId: string): Promise<void> {
  // 用户每次打开版本历史面板都强制重拉 —— 边界快照在 EditView idle / route
  // leave 时打,别的标签页 / 同事都可能在写当前 page,缓存会过时。
  byPage.delete(pageId)
  return ensureLoaded(pageId)
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