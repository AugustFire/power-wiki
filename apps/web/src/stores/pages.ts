import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { newId } from '@/lib/id'
import {
  htmlToJson,
  isMigratedJSON,
  needsRemigrate,
  stampSchemaVersion,
} from '@/editor/htmlToJson'
import { emptyDoc, EMPTY_HTML, DEFAULT_TITLE, normalizeTitle } from '@/lib/constants'
import { api, ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import { useUiStore } from '@/stores/ui'
import { useSpacesStore } from '@/stores/spaces'
import type {
  CreatePageInput,
  ImportPageResult,
  PageNode,
  TreeNode,
} from '@power-wiki/shared'

/** Single source of truth — apps/api (Postgres) via the typed client. */
export const usePagesStore = defineStore('pages', () => {
  const pages = ref<PageNode[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  /** 初始化阶段(冷启动加载 / 重连)的失败信息;UI 用来决定显示加载占位还是错误页 */
  const loadError = ref<string | null>(null)
  /**
   * Stage 5: trash cache. The store doesn't auto-load this — the admin
   * TrashView pulls it via `loadTrash(spaceId)` on mount. Lives outside
   * `pages.value` because trash rows have `deletedAt != null` and would
   * otherwise leak into the tree builder.
   */
  const trashed = ref<PageNode[]>([])
  const trashLoaded = ref(false)

  /** Bumped on every successful watch/unwatch (or cache-less first toggle).
   * Sidebar 的「我的关注」section 和右 TOC 的「页面关注者」都 watch 这个
   * counter —— 单凭 page.watchedByMe / watchersCount 变化驱动不到跨组件
   * 列表拉取(它们各自维护独立的 local state),需要一个稳定的 trigger 让
   * 任何 watch 操作都触发两边重新 fetch。counter 比 timestamp 更可测,
   * 也比深度 watch pages 数组(高频)便宜。 */
  const watchVersion = ref(0)
  /** B.1: pagination state for trashed list. */
  const TRASH_PAGE_SIZE = 50
  const trashOffset = ref(0)
  const trashHasMore = ref(false)
  const trashLoadingMore = ref(false)
  /**
   * B.3: true while a full `loadTrash` round-trip is in flight (drives the
   * refresh button's disabled + spinning state and the top progress bar).
   * Distinct from `trashLoadingMore` which only tracks "load next page"
   * requests triggered by the load-more button.
   */
  const trashLoading = ref(false)

  /**
   * 懒加载缓存状态。`pages.value` 现在是稀疏缓存:每个空间的根节点按
   * `ensureRootsLoaded(spaceId)` 拉取,子节点按需通过 `ensureChildrenLoaded`
   * 拉取。Cache key 用 `${spaceId}:${parentId}` — 避免跨空间场景(管理员
   * 在空间 A 展开过某节点,然后切到空间 B 看到同名节点)互相污染。
   * 根节点的 key 是 `${spaceId}:root`(`parentId=null`),与子节点共享同一
   * 个 `childrenLoaded` Set,所以清空子节点缓存时也连带清空根缓存。
   */
  const childrenLoaded = reactive(new Set<string>())
  const loadingPromises = new Map<string, Promise<void>>()

  function parentKey(parentId: string | null, spaceId: string | null): string {
    return `${spaceId ?? '~'}:${parentId ?? 'root'}`
  }

  /** 是否已尝试加载过某 parent 的 children(无论成功与否)。 */
  function isChildrenLoaded(parentId: string | null, spaceId: string | null): boolean {
    return childrenLoaded.has(parentKey(parentId, spaceId))
  }

  /** 该空间的根节点是否已加载(对应 cache key `${spaceId}:root`)。 */
  function isRootsLoaded(spaceId: string | null): boolean {
    if (!spaceId) return false
    return childrenLoaded.has(parentKey(null, spaceId))
  }

  function ui() {
    return useUiStore()
  }

  /**
   * Stage 5d: drop ALL in-memory data so the next caller re-fetches.
   *
   * Called by auth.logout() / auth.login() to prevent the next user from
   * seeing the previous user's page tree, trashed list, or stale space
   * selection. Without this, switching accounts in the same browser tab
   * leaks data across sessions (and triggers 401s when the next user
   * tries to load trash for a space the previous user had selected).
   */
  function reset(): void {
    pages.value = []
    trashed.value = []
    loaded.value = false
    trashLoaded.value = false
    loading.value = false
    loadError.value = null
    childrenLoaded.clear()
    loadingPromises.clear()
  }

  /**
   * 把 `loaded` 翻成 true 但不触发任何 fetch。
   *
   * /manager/* 路由的 cold-boot 需要这个:ManagerLayout 不显示 page-tree
   * sidebar,不需要 /api/pages 的根缓存。但 App.vue 的 RouterView gate
   * 依赖 `loaded` 为 true 才渲染 —— 否则 manager 视图全黑屏。
   *
   * 这是 `init()` 的一个瘦身版:同样把 loaded 翻成 true,跳过
   * ensureRootsLoaded。`init()` 里的活跃空间拉根由 Sidebar 接管(它的
   * activeSpaceId watch 在 spaces init 后触发,按需 ensureRootsLoaded),
   * 不依赖 init()。
   */
  function markLoaded(): void {
    if (loaded.value || loading.value) return
    loaded.value = true
  }

  async function init(): Promise<void> {
    if (loaded.value || loading.value) return
    loading.value = true
    loadError.value = null
    try {
      // 按空间加载根节点(默认 activeSpaceId)—— 之前是无 space 过滤的
      // 跨空间拉取,登录时一次性把所有可见空间的根塞进 pages.value,
      // Admin 还会拉所有个人空间的根。改成按空间后,登录只拉 1 个空间
      // 的根(10-50 条),其它空间在 Sidebar 切空间时按需 ensureRootsLoaded。
      const sid = useSpacesStore().activeSpaceId.value
      if (sid) await ensureRootsLoaded(sid)
      // activeSpaceId 为 null(还没初始化 spaces 或用户无任何空间)时,
      // 标记 loaded 让 shell 渲染空状态;Sidebar 的 activeSpaceId watch
      // 会在 sid 设置后兜底拉根。
      loaded.value = true
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '未知错误'
      loadError.value = `无法连接到后端: ${msg}`
      ui().setError(loadError.value)
    } finally {
      loading.value = false
    }
  }

  /**
   * Re-fetch the page list without flipping `loaded`/`loading`, so the UI
   * doesn't flash back to the boot spinner. Used after admin operations
   * (space access change, group delete, etc.) that may have changed the
   * user's visible-space set.
   *
   * **Cross-space refresh** —— Manager views (GroupsView / SpaceEditView /
   * PeopleView / SpacesView) call this after admin operations and need to
   * resync EVERY visible space's roots, not just the active one. Space
   * switching uses `ensureRootsLoaded(newSpaceId)` instead, which is scoped.
   *
   * Assumes `init()` has already run. If it hasn't, the refresh call still
   * updates pages.value, but `loaded` stays false — that's the caller's bug.
   */
  async function refresh(): Promise<void> {
    try {
      // 跨空间刷新所有可见空间的根 —— 与 init() 不同,manager 操作可能改
      // 任何空间的可见性,需要重新拿一遍。已加载的子节点不重新拉(管理员
      // 的空间访问变更不会改子树,改了根用户重进会 init 走全量)。
      const { items } = await api.pages.list({ parentId: null })
      // 合并:用新的根覆盖现有根;保留 pages.value 中所有非根节点(它们
      // 是已加载的子树,这里不清)。
      const rootIds = new Set(items.map((p) => p.id))
      pages.value = [
        ...items,
        ...pages.value.filter((p) => !rootIds.has(p.id)),
      ]
      // Re-run migration in case any fetched pages are still missing JSON —
      // this is a no-op for already-migrated pages.
      migrateEmptyJson()
    } catch (e) {
      ui().setError(
        `刷新失败: ${e instanceof ApiError ? e.message : '未知错误'}`,
      )
    }
  }

  /**
   * 确保某空间的根节点(parentId IS NULL)已加载。
   *
   * 与 `ensureChildrenLoaded(null)` 的关系:`ensureChildrenLoaded(null)`
   * 会用 `activeSpaceId` 作 fallback 拿根,但不能指定「为空间 X 加载根」。
   * 本方法显式接 spaceId,服务于:
   *   - LoginView:登录后只加载 active space 的根(替代原全空间加载)
   *   - Sidebar watch:activeSpaceId 变化时按需加载新空间的根
   *   - SpaceSwitcher:切换空间时加载目标空间根
   *   - restorePage:只重建被恢复页所在空间的根缓存
   *
   * 复用 `childrenLoaded` Set + `loadingPromises` Map 的 `${spaceId}:root`
   * key —— 与 `ensureChildrenLoaded` 的子节点 cache 同结构,reset 时一并
   * 清空。
   */
  async function ensureRootsLoaded(spaceId: string): Promise<void> {
    if (!spaceId) return
    const key = parentKey(null, spaceId)
    if (childrenLoaded.has(key)) return
    const inflight = loadingPromises.get(key)
    if (inflight) return inflight

    const promise = (async () => {
      try {
        const { items } = await api.pages.list({ space: spaceId, parentId: null })
        // 按空间合并:把该空间的旧根清掉(如有),再加入新根;其它空间的页
        // 完全不动 —— 它们的子树或根不该被这次刷新影响。
        pages.value = [
          ...pages.value.filter((p) => p.spaceId !== spaceId),
          ...items,
        ]
        migrateEmptyJson()
        childrenLoaded.add(key)
      } finally {
        loadingPromises.delete(key)
      }
    })()
    loadingPromises.set(key, promise)
    return promise
  }

  /**
   * 确保某 parentId 的子节点已加载。未加载则发请求,加载中则复用 inflight
   * promise(去重并发),已加载则直接返回。PageTree 在展开折叠节点时调用。
   *
   * 失败策略:不静默吞错 — 让 PageTree 的 spinner 状态结束并向用户报错。
   * 缓存状态保留(失败不算"已加载"),下次展开会重试。
   */
  async function ensureChildrenLoaded(parentId: string | null): Promise<void> {
    const parent = parentId ? pages.value.find((p) => p.id === parentId) : null
    if (parentId && !parent) {
      // 父节点本身不在缓存里(理论上不会 — 调用方应该已经渲染过它),安全失败
      return
    }
    const spaceId = parent?.spaceId ?? useSpacesStore().activeSpaceId.value
    const key = parentKey(parentId, spaceId)
    if (childrenLoaded.has(key)) return
    const inflight = loadingPromises.get(key)
    if (inflight) return inflight

    const promise = (async () => {
      try {
        const { items } = await api.pages.list({ space: spaceId ?? undefined, parentId })
        // 把拉到的子节点 merge 进 pages.value:已有 id 替换,新 id 追加。
        // 不清掉 pages.value 中其它节点 — 它们可能是其它 parent 已加载的子树。
        const fetchedIds = new Set(items.map((p) => p.id))
        pages.value = [
          ...pages.value.filter((p) => !fetchedIds.has(p.id)),
          ...items,
        ]
        migrateEmptyJson()
        // 同步 parent.hasChildren 与本次拉到的真实数据(items.length 决定):
        //   - 拿到 ≥1 条 → 父节点有子(hasChildren=true)
        //   - 拿到 0 条  → 父节点就是 leaf(hasChildren=false,caret 应消失)
        // 之前 hasChildren 可能因为乐观插入或过时的服务端快照而失准,
        // 这里以本次拉取为准,纠正它,避免用户被"显示 caret 但展开是空的"
        // 误导。
        if (parentId) {
          const pIdx = pages.value.findIndex((p) => p.id === parentId)
          if (pIdx >= 0) {
            const expected = items.length > 0
            const actual = pages.value[pIdx]!.hasChildren === true
            if (expected !== actual) {
              pages.value[pIdx] = { ...pages.value[pIdx]!, hasChildren: expected }
            }
          }
        }
        childrenLoaded.add(key)
      } finally {
        loadingPromises.delete(key)
      }
    })()
    loadingPromises.set(key, promise)
    return promise
  }

  /**
   * 标记某 parent 的 children 缓存为失效。下次 ensureChildrenLoaded() 会重新
   * 拉。用于所有会影响某 parent 子列表的写入操作(create / delete / move /
   * duplicate 等),保证 UI 不会显示幽灵。
   *
   * `parentId === null` 表示根级(此时用 activeSpaceId 作 cache key 的一部分,
   * 避免把"团队空间 X 的根"失效到"团队空间 Y 的根")。
   */
  function invalidateChildren(parentId: string | null, spaceId?: string | null): void {
    const sid = spaceId ?? (parentId
      ? pages.value.find((p) => p.id === parentId)?.spaceId ?? null
      : useSpacesStore().activeSpaceId.value)
    const key = parentKey(parentId, sid)
    childrenLoaded.delete(key)
  }

  /**
   * 确保 `pageId` 及其整条祖先链都在 `pages.value` 里,返回 root→page 顺序
   * 的链(含 page 自身)。
   *
   * 懒加载模式下 `pages.value` 是稀疏缓存 —— `init()` 只拉根节点,子节点按需
   * 拉。用户从正文点一个子页面链接(或直接深链进一个深层页)时,目标页和它
   * 的祖先都可能不在缓存里。这里从目标向上 walk,缺失的节点逐个用
   * `api.pages.get` 补齐并 merge 进缓存。
   *
   * 用途:侧栏「打开子页 → 自动展开祖先并定位到当前页」。
   *
   * 失败策略:某个祖先拿不到(404 / 无权限)时提前收尾,返回已拿到的部分链,
   * 不抛错 —— 侧栏尽力展开到能到达的层级,绝不因补链失败打断用户导航。
   */
  async function ensureAncestorsLoaded(pageId: string): Promise<PageNode[]> {
    const chain: PageNode[] = []
    let cur = getPage(pageId)
    if (!cur) {
      try {
        cur = await api.pages.get(pageId)
        syncPageFromServer(cur)
      } catch {
        return []
      }
    }
    let guard = 0
    while (cur && guard++ < 64) {
      chain.unshift(cur)
      const pid = cur.parentId
      if (!pid) break
      let parent = getPage(pid)
      if (!parent) {
        try {
          parent = await api.pages.get(pid)
          syncPageFromServer(parent)
        } catch {
          break
        }
      }
      cur = parent
    }
    return chain
  }

  /**
   * 把 contentJSON 为空 {} 但 contentHTML 非空的页面回填成有效 JSON。
   * 种子页面从后端导入时没有 JSON,首次加载时一次性转换。
   * 纯本地迁移 — 不写回服务:admin 看得到他人 personal space 页,PATCH 会被
   * personalSpaceGuard 403 拦下且永远落不了库,反而每冷启动重跑 N 次。
   */
  function migrateEmptyJson(): void {
    for (const p of pages.value) {
      const html = (p.contentHTML ?? '').trim()
      if (!isMigratedJSON(p.contentJSON)) {
        if (!html || html === '<p></p>') {
          p.contentJSON = stampSchemaVersion({
            type: 'doc',
            content: [{ type: 'paragraph' }],
          })
          continue
        }
        try {
          p.contentJSON = stampSchemaVersion(htmlToJson(html))
        } catch (err) {
          console.warn(`[pages] migrate 失败 page=${p.id}`, err)
        }
        continue
      }
      if (needsRemigrate(p.contentJSON) && html && html !== '<p></p>') {
        try {
          p.contentJSON = stampSchemaVersion(htmlToJson(html))
        } catch (err) {
          console.warn(`[pages] re-migrate 失败 page=${p.id}`, err)
        }
      } else if (needsRemigrate(p.contentJSON)) {
        p.contentJSON = stampSchemaVersion(p.contentJSON as Record<string, unknown>)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  CRUD — 全部走乐观更新 + 失败回滚
  //  snapshot 模式:先快照本地状态 → 立即变更 UI → 调 API → 失败就还原 + banner
  // ─────────────────────────────────────────────────────────────────

  async function createPage(opts: Partial<CreatePageInput> = {}): Promise<PageNode> {
    const parentId = opts.parentId ?? null
    // Stage B.3: caller may pass a client-generated id (for instant URL
    // jump in EditView). Otherwise we mint one here as before.
    const id = opts.id ?? newId()
    const now = Date.now()
    const siblings = pages.value.filter((p) => p.parentId === parentId)
    // Stage 4: every page belongs to a space. New pages go into the active space.
    // Guard: if user is in the manager UI without an active space, refuse cleanly.
    const spaceId = opts.spaceId ?? useSpacesStore().activeSpaceId.value
    if (!spaceId) throw new Error('no active space — cannot create page')
    // Forward the caller's body fields into the optimistic placeholder so
    // the editor sees real content immediately on mount (instead of an
    // empty doc that "snaps" to the real content when the POST resolves).
    const optimistic: PageNode = {
      id,
      parentId,
      title: opts.title ?? DEFAULT_TITLE,
      contentJSON: opts.contentJSON ?? emptyDoc(),
      contentHTML: opts.contentHTML ?? EMPTY_HTML,
      icon: opts.icon ?? undefined,
      order: siblings.length,
      createdAt: now,
      updatedAt: now,
      authorId: 'me',
      // Optimistic placeholder — replaced by the server's response which
      // carries the real LEFT-JOIN'd authorName / authorColor.
      authorName: null,
      authorColor: null,
      // 新建页 updated_by 还没写入(null),UI 派生链(updatedByName → authorName)
      // 自然落到 authorName('我' via me sentinel);服务端 POST 响应回来后会被
      // 真实值覆盖。
      updatedBy: null,
      updatedByName: null,
      updatedByColor: null,
      spaceId,
      // 新建的页肯定没子。undefined 让 PageTree 走 leaf fallback,后续
      // ensureChildrenLoaded 拿到真实结果会纠正 (实际新建的页也确实没子,
      // 所以永远是 false)。
      hasChildren: false,
    }
    pages.value.push(optimistic)
    // 新建的页出现在 parentId 的 children 里 — 让该 parent 的缓存失效,
    // 下次展开时会重新拉(此时不会重复拉,因为 ensureChildrenLoaded 是
    // 用户主动展开才触发,新建后用户多半已经在操作菜单里,不会立刻再展开)。
    invalidateChildren(parentId, spaceId)
    // 若 parent 之前是 leaf (hasChildren=false),现在塞了一个新子 — 立刻
    // 翻转成 true,否则用户看 caret 不见就不知道有子。乐观更新假定服务端
    // 也会得到 hasChildren=true(server 自己会重算),conflict 时会被后续
    // refresh 自动纠正。parentId === null (根级新增) 不影响 — 根的 hasChildren
    // 不是树渲染需要的信号。
    if (parentId) {
      const pIdx = pages.value.findIndex((p) => p.id === parentId)
      if (pIdx >= 0 && pages.value[pIdx]!.hasChildren === false) {
        pages.value[pIdx] = { ...pages.value[pIdx]!, hasChildren: true }
      }
    }

    try {
      // Forward every field the caller passed — including content +
      // icon + optional explicit `order` (seed scripts use this) — so the
      // server-side row matches what the optimistic entry already shows.
      // title MUST always be sent (even when caller didn't supply one):
      // backend defaults `input.title ?? DEFAULT_TITLE`, but if we omit the
      // field entirely the default branch still runs and the response parse
      // passes. Sending it here is belt-and-braces for forward compat.
      const apiPayload: CreatePageInput = {
        id,
        parentId,
        spaceId,
        title: opts.title ?? DEFAULT_TITLE,
        ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
        ...(opts.contentJSON !== undefined
          ? { contentJSON: opts.contentJSON as CreatePageInput['contentJSON'] }
          : {}),
        ...(opts.contentHTML !== undefined
          ? { contentHTML: opts.contentHTML }
          : {}),
        ...(opts.order !== undefined ? { order: opts.order } : {}),
      }
      const real = await api.pages.create(apiPayload)
      // 用服务器响应替换本地乐观副本(timestamps / order 由 server 决定)
      const idx = pages.value.findIndex((p) => p.id === id)
      if (idx >= 0) pages.value[idx] = real
      return real
    } catch (e) {
      pages.value = pages.value.filter((p) => p.id !== id)
      ui().setError(`创建页面失败: ${errorMessage(e)}`)
      throw e
    }
  }

  function getPage(id: string): PageNode | undefined {
    return pages.value.find((p) => p.id === id)
  }

  /**
   * 更新内容字段(title / contentJSON / contentHTML / icon)。
   * 父级变更请走 `movePage`。订阅状态请走 watch/unwatch。
   */
  async function updatePage(id: string, patch: Partial<PageNode>): Promise<PageNode> {
    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`page not found: ${id}`)
    const snapshot = pages.value[idx]!
    const optimistic: PageNode = { ...snapshot, ...patch, updatedAt: Date.now() }
    pages.value[idx] = optimistic

    // 只把后端接受的字段发给 API,过滤掉 parentId / order / createdAt 等
    const apiPatch: Parameters<typeof api.pages.update>[1] = {}
    if (patch.title !== undefined) apiPatch.title = patch.title
    if (patch.contentJSON !== undefined) apiPatch.contentJSON = patch.contentJSON
    if (patch.contentHTML !== undefined) apiPatch.contentHTML = patch.contentHTML
    if (patch.icon !== undefined) apiPatch.icon = patch.icon

    try {
      const real = await api.pages.update(id, apiPatch)
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = real
      return real
    } catch (e) {
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = snapshot
      ui().setError(`保存失败: ${errorMessage(e)}`)
      throw e
    }
  }

  async function renamePage(id: string, title: string): Promise<PageNode> {
    return updatePage(id, { title: normalizeTitle(title) })
  }

  /**
   * Sync a single page in the local store from a server-known truth
   * (returned by an API call that already mutated the row). Used after
   * `POST /api/pages/:id/versions/:vid/restore` — the response IS the
   * post-restore PageNode, no need to re-PATCH.
   *
   * Replaces (not merges) the row: server is authoritative. If the page
   * is not in the local cache, append it (defensive — shouldn't happen
   * since restore is only called from a context that already has the
   * page in the store, but the append keeps the invariant).
   */
  function syncPageFromServer(updated: PageNode): void {
    const idx = pages.value.findIndex((p) => p.id === updated.id)
    if (idx >= 0) pages.value[idx] = updated
    else pages.value = [...pages.value, updated]
  }

  /**
   * Stage 5: 软删(回收站)。后端在有未删子节点时会返 409 has_children;
   * UI 应该在调用前就禁用删除按钮,但保留这条路径以防前端过滤与服务端不一致。
   *
   * 走乐观更新 — 从主树立刻移除,失败回滚并 banner。TrashView 自己 reload,
   * 这里的 `trashed` 数组只由 TrashView 维护。
   */
  async function softDeletePage(id: string): Promise<void> {
    const snapshot = pages.value.find((p) => p.id === id)
    if (!snapshot) throw new Error(`page not found: ${id}`)
    pages.value = pages.value.filter((p) => p.id !== id)
    // 让 parent 的 children 缓存失效(子节点列表变了)
    invalidateChildren(snapshot.parentId, snapshot.spaceId)

    try {
      await api.pages.delete(id)
    } catch (e) {
      // 还原 — 简单 push 回数组尾部,顺序在 getTree() 里会按 order 重排
      pages.value = [...pages.value, snapshot]
      const msg =
        e instanceof ApiError && e.code === 'has_children'
          ? '请先删除子页面'
          : `删除失败: ${errorMessage(e)}`
      ui().setError(msg)
      throw e
    }
  }

  /**
   * Stage 5: admin-only. Restores a single trashed page. The backend enforces
   * the parent-must-be-restored rule (409 parent_trashed). On success we
   * reload the page tree so the restored row appears in its original spot
   * (and the trash cache entry is dropped).
   */
  async function restorePage(id: string): Promise<void> {
    trashed.value = trashed.value.filter((p) => p.id !== id)
    try {
      await api.pages.restore(id)
      // Restore 可能恢复一整棵子树(后端在某种条件下会级联恢复),但我们
      // 只知道根 id。最安全做法:让所有已加载的 parent 缓存失效,下次展
      // 开时统一重新拉。同时刷新活动空间的根(被恢复的页可能直接是根)。
      // 只刷活动空间,不再做无 space 过滤的全空间拉取 —— Manager 的
      // 恢复操作只在自己管理的空间跑,活动空间就是目标空间。
      childrenLoaded.clear()
      const sid = useSpacesStore().activeSpaceId.value
      if (sid) await ensureRootsLoaded(sid)
    } catch (e) {
      // Re-fetch trash to resync the optimistic drop with truth.
      await loadTrashForCurrent()
      const msg =
        e instanceof ApiError && e.code === 'parent_trashed'
          ? '请先恢复父页面'
          : `恢复失败: ${errorMessage(e)}`
      ui().setError(msg)
      throw e
    }
  }

  /**
   * Stage 5: admin-only. Permanently deletes a trashed row. No optimistic
   * re-render — we just drop from `trashed` and refresh on failure.
   */
  async function purgePage(id: string): Promise<void> {
    const snapshot = trashed.value.find((p) => p.id === id)
    trashed.value = trashed.value.filter((p) => p.id !== id)
    try {
      await api.pages.purge(id)
    } catch (e) {
      if (snapshot) trashed.value = [...trashed.value, snapshot]
      ui().setError(`永久删除失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * 顶栏 👍 toggle。乐观更新:本地先 flip likedByMe + 调整 likesCount,
   * API 返回后用服务端权威值覆盖。失败回滚到 snapshot + banner。
   *
   * `page.likesCount ?? 0` 给没拿到 page(罕见)的场景兜底 ——
   * 这种情况就是没缓存,前端对数字的乐观翻转无意义,直接不渲染 UI 而已。
   *
   * 返回 server 的权威 { liked, likesCount },方便 caller 知道最终状态
   * (ReadView 已经按 optimistic 更新了,这里主要给未来「auto-redirect after
   * like」一类 caller 留 hook)。
   */
  async function togglePageLike(
    id: string,
  ): Promise<{ liked: boolean; likesCount: number }> {
    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) {
      // 缓存里没有该 page — 不能乐观翻转,直接 fire 一次 server 调用
      const r = await api.pages.toggleLike(id)
      return r
    }
    const snapshot = { ...pages.value[idx]! }
    const wasLiked = snapshot.likedByMe === true
    const beforeCount = snapshot.likesCount ?? 0
    // Optimistic flip
    pages.value[idx] = {
      ...snapshot,
      likedByMe: !wasLiked,
      likesCount: beforeCount + (wasLiked ? -1 : 1),
    }
    try {
      const r = await api.pages.toggleLike(id)
      // 用服务端权威值覆盖(server COUNT(*) 才是事实来源,不是乐观推算)
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) {
        pages.value[i] = {
          ...pages.value[i]!,
          likedByMe: r.liked,
          likesCount: r.likesCount,
        }
      }
      // trashed 也对齐(sidebar 偶尔 list / trash 共存场景)
      const ti = trashed.value.findIndex((p) => p.id === id)
      if (ti >= 0) {
        trashed.value[ti] = {
          ...trashed.value[ti]!,
          likedByMe: r.liked,
          likesCount: r.likesCount,
        }
      }
      return r
    } catch (e) {
      // 回滚
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = snapshot
      ui().setError(`操作失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * M13 👁 关注 toggle —— 与 togglePageLike 同构但 endpoints 拆分:
   *   - 已关注 → watch (POST) → 服务端 SELECT-then-INSERT(幂等)
   *   - 未关注 → unwatch (DELETE) → 服务端 DELETE
   * 不像 like 那样单端点 toggle,因为要遵循 SPEC 的 REST 风格(2026-07-10 锁定)。
   *
   * 乐观更新:本地先翻 watchedByMe + ±1 count;API 返回用 server 权威值覆盖。
   * 失败回滚到 snapshot + banner。cache 里没有该 page 时直接走 server,
   * 不乐观推算。返回 server 的 { watched, watchersCount } 给 caller。
   */
  async function togglePageWatch(
    id: string,
  ): Promise<{ watched: boolean; watchersCount: number }> {
    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) {
      // 没缓存 — 不知道当前状态,不能瞎走 watch 还是 unwatch。
      // 第一次 click 走到这条路径基本就是 deep link 直达页面的场景;
      // 先 getPage 拿一次真值,然后根据真值决定 call watch 还是 unwatch。
      try {
        const cur = await api.pages.get(id)
        const wasWatched = cur.watchedByMe === true
        const r = wasWatched
          ? await api.pages.unwatch(id)
          : await api.pages.watch(id)
        // 也把这条 page 加进缓存(后续再 click 不用再 get)
        syncPageFromServer({ ...cur, watchedByMe: r.watched, watchersCount: r.watchersCount })
        watchVersion.value++
        return r
      } catch (e) {
        ui().setError(`操作失败: ${errorMessage(e)}`)
        throw e
      }
    }
    const snapshot = { ...pages.value[idx]! }
    const wasWatched = snapshot.watchedByMe === true
    const beforeCount = snapshot.watchersCount ?? 0
    pages.value[idx] = {
      ...snapshot,
      watchedByMe: !wasWatched,
      watchersCount: beforeCount + (wasWatched ? -1 : 1),
    }
    try {
      const r = wasWatched
        ? await api.pages.unwatch(id)
        : await api.pages.watch(id)
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) {
        pages.value[i] = {
          ...pages.value[i]!,
          watchedByMe: r.watched,
          watchersCount: r.watchersCount,
        }
      }
      const ti = trashed.value.findIndex((p) => p.id === id)
      if (ti >= 0) {
        trashed.value[ti] = {
          ...trashed.value[ti]!,
          watchedByMe: r.watched,
          watchersCount: r.watchersCount,
        }
      }
      watchVersion.value++
      return r
    } catch (e) {
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = snapshot
      ui().setError(`操作失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * Stage 5 / B.1: load trashed pages for the active space. Called by
   * TrashView on mount + when switching spaces. Resets pagination state.
   * `loadMoreTrash(spaceId)` appends the next batch via the same API.
   */
  async function loadTrash(spaceId: string): Promise<void> {
    trashLoading.value = true
    trashOffset.value = 0
    trashHasMore.value = false
    try {
      const { items, hasMore } = await api.pages.trash.list(spaceId, { limit: TRASH_PAGE_SIZE, offset: 0 })
      trashed.value = items
      trashOffset.value = items.length
      trashHasMore.value = hasMore
      trashLoaded.value = true
    } catch (e) {
      ui().setError(`加载回收站失败: ${errorMessage(e)}`)
    } finally {
      trashLoading.value = false
    }
  }

  /**
   * B.1: append the next page of trashed pages to the existing list. No-op
   * while a previous load is in flight, or once the server reports no more.
   */
  async function loadMoreTrash(spaceId: string): Promise<void> {
    if (trashLoadingMore.value || !trashHasMore.value) return
    trashLoadingMore.value = true
    try {
      const { items, hasMore } = await api.pages.trash.list(spaceId, {
        limit: TRASH_PAGE_SIZE,
        offset: trashOffset.value,
      })
      trashed.value.push(...items)
      trashOffset.value += items.length
      trashHasMore.value = hasMore
    } catch (e) {
      ui().setError(`加载更多回收站失败: ${errorMessage(e)}`)
    } finally {
      trashLoadingMore.value = false
    }
  }

  /**
   * Stage 5: re-load trash for the active space without requiring the
   * caller to know which space is active. Used after restore/purge failure.
   */
  async function loadTrashForCurrent(): Promise<void> {
    const spaceId = useSpacesStore().activeSpaceId.value
    if (spaceId) await loadTrash(spaceId)
  }

  /**
   * 移动节点到新父级。`newOrder` 是 0-based 插入位置 — 把该页面插入到目标父级
   * 子列表(排除自身)的第 newOrder 个位置。省略则追加到末尾。
   * 循环保护本地也做一次(server 是权威,但本地拒绝可以省一次往返)。
   *
   * 本地先按目标顺序重排兄弟节点的 order,然后调 API;失败时整批还原快照。
   */
  async function movePage(
    id: string,
    newParentId: string | null,
    newOrder?: number,
  ): Promise<PageNode> {
    if (id === newParentId) throw new Error('cannot move into self')

    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`page not found: ${id}`)
    const snapshot = pages.value[idx]!
    // Snapshot the full pages array so we can roll back on failure.
    const pagesSnapshot = pages.value.slice()

    // Compute the new sort order for the moved page and its (former + new)
    // siblings in one pass. The server will rewrite the whole sibling list
    // atomically; we mirror it locally so the tree re-renders immediately.
    // Siblings 必须按 spaceId 过滤 —— pages.value 是全局(多 space),只看
    // parentId 会把跨 space 的根页混进来,findIndex 返全局索引,本地乐观
    // 更新给兄弟分配全局索引当 order,server clamp 后只覆盖移动页 → 移动
    // 页变最顶。源页的 spaceId 决定兄弟 scope(本路径同 space,跨 space 走
    // movePageToSpace)。`snapshot.spaceId` 在 idx 查找时已经读到了,直接用。
    const targetSiblings = pages.value
      .filter(
        (p) =>
          p.spaceId === snapshot.spaceId &&
          p.parentId === newParentId &&
          p.id !== id,
      )
      .sort((a, b) => a.order - b.order)
    const insertAt = Math.max(
      0,
      Math.min(newOrder ?? targetSiblings.length, targetSiblings.length),
    )
    const reordered: PageNode[] = [
      ...targetSiblings.slice(0, insertAt),
      { ...snapshot, parentId: newParentId, order: insertAt, updatedAt: Date.now() },
      ...targetSiblings.slice(insertAt),
    ]

    // Rewrite local order values + the moved page's parentId so the tree
    // rebuild reflects the new layout. Page records we didn't touch keep
    // their original snapshot identity.
    const reorderedIds = new Set(reordered.map((p) => p.id))
    pages.value = pages.value.map((p) => {
      if (p.id === id) {
        return { ...p, parentId: newParentId, order: insertAt, updatedAt: Date.now() }
      }
      if (reorderedIds.has(p.id)) {
        const newOrderVal = reordered.findIndex((r) => r.id === p.id)
        return newOrderVal >= 0 ? { ...p, order: newOrderVal } : p
      }
      return p
    })

    try {
      const real = await api.pages.move(id, { newParentId, newOrder })
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = real
      // 移动后旧 parent 和新 parent 的 children 列表都变了 — 让两边都失效
      invalidateChildren(snapshot.parentId, snapshot.spaceId)
      invalidateChildren(newParentId, real.spaceId)
      // 新 parent 现在有至少 1 个子(就是 dragged)→ hasChildren 必为 true。
      // 保守置 true 避免 caret 漏显示。old parent 不知道是否还有其他子,
      // 不动它 — 下次用户展开时 lazy-load 拿真实数据,hasChildren 自纠正。
      if (newParentId) {
        const npIdx = pages.value.findIndex((p) => p.id === newParentId)
        if (npIdx >= 0 && pages.value[npIdx]!.hasChildren !== true) {
          pages.value[npIdx] = { ...pages.value[npIdx]!, hasChildren: true }
        }
      }
      return real
    } catch (e) {
      pages.value = pagesSnapshot
      ui().setError(`移动失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * "发布到":在目标空间里**复制**一份源 personal-space 页面,原页保留不动。
   * 后端会加 "(来自 {userName} 的个人分享)" 后缀,所以这里只用插入
   * 新行(无需改原页)。失败回滚只是把刚 push 进去的 optimistic 项删掉。
   *
   * 这个方法**不**触碰源页 — 即使用户已经在前端把源页切到别处 / 改了标题,
   * 我们都用后端返回的真实副本做 store update。
   */
  async function publishPageToSpace(
    id: string,
    targetSpaceId: string,
    opts?: { includeChildren?: boolean; depth?: number },
  ): Promise<PageNode> {
    if (!pages.value.some((p) => p.id === id)) {
      throw new Error(`page not found: ${id}`)
    }

    // Optimistic:用同 sortOrder 占位,等真实数据回来再覆盖。
    // 暂时用 sortOrder=-1 标记"还没回填",id 已经确定(newId 是后端权威,
    // 但后端 201 才回,所以这里只能先推一个占位;如果 201 失败再删除)。
    const tempId = '__pending__' + Math.random().toString(36).slice(2, 8)
    const optimistic: PageNode = {
      id: tempId,
      parentId: null,
      spaceId: targetSpaceId,
      title: '',
      contentJSON: {},
      contentHTML: '',
      order: -1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      authorId: '',
      authorName: null,
      authorColor: null,
      // Optimistic placeholder;publish 成功后由真实响应覆盖,
      // updatedBy 系列都先填 null(本新建页尚未被 PATCH)。
      updatedBy: null,
      updatedByName: null,
      updatedByColor: null,
    }
    pages.value = [...pages.value, optimistic]

    try {
      const real = await api.pages.publish(id, {
        targetSpaceId,
        ...(opts?.includeChildren ? { includeChildren: true, depth: opts.depth ?? 1 } : {}),
      })
      // 替换占位
      const i = pages.value.findIndex((p) => p.id === tempId)
      if (i >= 0) {
        pages.value = pages.value.map((p, idx) => (idx === i ? real : p))
      } else {
        pages.value = [...pages.value, real]
      }
      // 发布到 → 目标空间根节点列表多了 1 条。不 invalidateChildren(null,
      // targetSpaceId) — 那样会删 `${targetSpaceId}:root` 缓存,让
      // isRootsLoaded(targetSpaceId) 翻 false → ReadView Skeleton gate
      // 永久挂起(详见 importPage / duplicatePage 同款注释)。新页已 push
      // 到 pages.value,tree builder 重算自动包含;后续 autoExpandAndLocate
      // 切到目标空间时 ensureRootsLoaded 会正常跑。
      return real
    } catch (e) {
      pages.value = pages.value.filter((p) => p.id !== tempId)
      ui().setError(`发布到团队空间失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * In-place sibling copy (POST /api/pages/:id/duplicate). Mirrors
   * `publishPageToSpace`'s optimistic-placeholder pattern, then on the
   * server response it:
   *
   * 1. swaps the placeholder for the real row (with the server-computed
   *    title prefix `复制自` and correct sortOrder),
   * 2. **renumbers every sibling** in source's parent group so the copy
   *    visibly lands immediately after the source — same trick `movePage`
   *    uses locally so the tree re-renders in the right position without
   *    a full reload.
   *
   * Local positions are approximated to the canonical 0..N sequence. The
   * server's authoritative order is observable when the next list refresh
   * lands; this avoids a tree "shuffle" in the meantime.
   *
   * `withChildren: true` 走整棵子树递归复制(Confluence "Duplicate with
   * subtree" 语义)。子树模式下,store 端只追加新源页(根)的占位 + 落地
   * 真实 row;子页依赖后端 INSERT,前端无源数据做乐观更新,落地后靠
   * 一次 `invalidateChildren` 让下次 `ensureChildrenLoaded` 拉真实子列表。
   */
  async function duplicatePage(
    id: string,
    opts: { withChildren?: boolean } = {},
  ): Promise<PageNode> {
    const source = pages.value.find((p) => p.id === id)
    if (!source) throw new Error(`page not found: ${id}`)

    const tempId = '__pending__' + Math.random().toString(36).slice(2, 8)
    const optimistic: PageNode = {
      id: tempId,
      parentId: source.parentId,
      spaceId: source.spaceId,
      title: `复制自${(source.title ?? '').trim() || '未命名'}`,
      // Carry content over optimistically — the editor (if the user
      // navigates straight into it) shouldn't render a blank doc.
      contentJSON: source.contentJSON,
      contentHTML: source.contentHTML,
      icon: source.icon,
      order: -1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      authorId: '',
      authorName: null,
      authorColor: null,
      // Optimistic duplicate placeholder —— duplicate 响应会带真实的
      // updatedBy;此处先填 null 让编辑器能挂载,UI 派生链回退到
      // '未知作者'(authorId 也空串)。
      updatedBy: null,
      updatedByName: null,
      updatedByColor: null,
    }
    pages.value = [...pages.value, optimistic]

    try {
      const real = await api.pages.duplicate(id, { withChildren: opts.withChildren })

      // 1. Drop the placeholder; ensure `real` is in the array.
      const withoutPlaceholder = pages.value.filter((p) => p.id !== tempId)
      const withReal = withoutPlaceholder.some((p) => p.id === real.id)
        ? withoutPlaceholder.map((p) => (p.id === real.id ? real : p))
        : [...withoutPlaceholder, real]

      // 2. Renumber source's sibling group so `real` lands at sourceIdx+1.
      const group = withReal
        .filter(
          (p) =>
            p.spaceId === source.spaceId && p.parentId === source.parentId,
        )
        .sort((a, b) => a.order - b.order)
      const sourceIdx = group.findIndex((p) => p.id === source.id)
      const insertAt = sourceIdx < 0 ? group.length : sourceIdx + 1
      const reordered = [
        ...group.slice(0, insertAt),
        real,
        ...group.slice(insertAt),
      ].map((p, i) => ({ ...p, order: i }))
      const reorderedMap = new Map(reordered.map((p) => [p.id, p]))

      pages.value = withReal.map((p) => reorderedMap.get(p.id) ?? p)
      // 复制后 source.parentId 的 children 列表变了(多了一个)。子树模式
      // 下,新源页下还多了一整棵子树 — 走 cache invalidation,下次展开时让
      // ensureChildrenLoaded 拉真实列表(子页的占位 row 没在 store 里,这
      // 里只保证新源页 root 行立即可见)。
      //
      // 只在 source 不是 root (parentId != null) 时 invalidate — root 路径
      // 会删 `${spaceId}:root` 缓存标记,让 isRootsLoaded() 翻成 false,
      // ReadView 的 Skeleton gate 命中后没人触发 reload,永久挂着(详见
      // importPage 同款注释)。root 复制时新页已经 push 进 pages.value,
      // tree builder 重算自动包含它,无需重 fetch 根。
      if (source.parentId != null) {
        invalidateChildren(source.parentId, source.spaceId)
      }
      if (opts.withChildren) {
        invalidateChildren(real.id, real.spaceId)
      }
      return real
    } catch (e) {
      pages.value = pages.value.filter((p) => p.id !== tempId)
      ui().setError(`复制失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * 从 Markdown 文本导入成新页(POST /api/pages/import)。后端走
   * prosemirror-markdown 解析 + image 清洗 + sibling 组末尾落点。
   *
   * 走**非乐观路径**:
   *  - 转换在后端(前端拿不到"实时 Tiptap JSON",乐观插一行 placeholder
   *    也只是猜测内容,意义不大)。
   *  - 大输入(2MB)解析 + DB 写入可能 100ms+,用骨架屏 + 「导入中...」按钮
   *    禁用处理足够。
   *
   * 成功:
   *  - created != null:push 到 pages[],invalidateChildren(parentId, spaceId),
   *    返回 created PageNode(让 modal 跳转)。
   *  - skipped != null:不抛错,modal 接住后弹 toast 让用户改名再试。
   *
   * 失败:`ui().setError(...)` + 重抛(modal 显示 banner)。
   */
  async function importPage(
    input: Parameters<typeof api.pages.import>[0],
  ): Promise<ImportPageResult> {
    try {
      const result = await api.pages.import(input)
      if (result.created) {
        const withReal = pages.value.some((p) => p.id === result.created!.id)
          ? pages.value.map((p) => (p.id === result.created!.id ? result.created! : p))
          : [...pages.value, result.created]
        pages.value = withReal
        // 只 invalidate parent 的 children 缓存(child import 路径)。root 导入
        // (parentId=null) 不要 invalidateChildren(null, spaceId) — 那会删掉
        // `${spaceId}:root` 这个 childrenLoaded Set 项,让 isRootsLoaded() 翻成
        // false。ReadView 用 !isRootsLoaded(activeSpaceId) gate 出 Skeleton,
        // 没有触发 reload 的路径,会一直挂着到用户手动 F5。新页已经 push 到
        // pages.value,tree builder 重算自动包含它,不需要重 fetch 根。
        if (input.parentId != null) {
          invalidateChildren(input.parentId, input.spaceId)
        }
      }
      return result
    } catch (e) {
      ui().setError(`导入失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * 边界 / idle boundary checkpoint —— POST /api/pages/:id/snapshots。
   *
   * EditView 在以下两种情况调用:
   *   1. 停笔 30s 后 scheduleIdleSnapshot 触发
   *   2. flushPendingSave(route leave / unmount)成功后,如果还有未
   *      snapshot 的改动,补一份 boundary 版本
   *
   * 不写本地缓存 —— usePageVersions 是按 (pageId) 懒加载的,下次打开
   * VersionPanel 时自己 refetch。invalidation 会拉所有打开的 page,
   * 反而刷掉别人正在看的东西。
   */
  async function snapshotPage(id: string, changeNote?: string): Promise<void> {
    await api.pageSnapshots.create(id, changeNote)
  }

  /**
   * Cross-space move: relocate a page (with its subtree) from its current
   * space into a different space as a root-level page. Used by the sidebar
   * "移动到..." menu to move a personal-space page into a team space.
   *
   * The backend enforces newParentId === null on cross-space moves (cannot
   * nest under an arbitrary page in another space, because that parent
   * might not exist where the page is moving). Locally we replicate the
   * rule so the optimistic update reflects it.
   */
  async function movePageToSpace(id: string, newSpaceId: string): Promise<PageNode> {
    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`page not found: ${id}`)
    const snapshot = pages.value[idx]!
    if (snapshot.spaceId === newSpaceId) {
      throw new Error('page is already in the target space')
    }
    const pagesSnapshot = pages.value.slice()

    // Sibling re-order in the destination's root level: this page goes to
    // the end of the destination's root list.
    const destSiblings = pages.value
      .filter((p) => p.spaceId === newSpaceId && p.parentId === null && p.id !== id)
      .sort((a, b) => a.order - b.order)
    const insertAt = destSiblings.length

    pages.value = pages.value.map((p) => {
      if (p.id === id) {
        return {
          ...p,
          spaceId: newSpaceId,
          parentId: null,
          order: insertAt,
          updatedAt: Date.now(),
        }
      }
      return p
    })

    try {
      const real = await api.pages.move(id, {
        newParentId: null,
        newOrder: insertAt,
        newSpaceId,
      })
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = real
      // 跨空间移动:旧空间根节点列表少 1 条,新空间根节点列表多 1 条
      invalidateChildren(null, snapshot.spaceId)
      invalidateChildren(null, newSpaceId)
      // 目标空间根列表被加入 — 拉根列表时会拿到真实 hasChildren=true(因为
      // 现在有至少这 1 个根)。但根本身的 hasChildren 状态其实不重要(根节点
      // 不在 PageTree 的 hasChildren 检查里);保险起见也置一下。
      return real
    } catch (e) {
      pages.value = pagesSnapshot
      ui().setError(`移动到团队空间失败: ${errorMessage(e)}`)
      throw e
    }
  }

  function getTree(): TreeNode[] {
    // Stage 5: never render trashed rows. The backend already filters, but
    // optimistic updates (softDeletePage) briefly hold trashed rows in
    // `pages.value` until the server confirms — drop them here so the
    // tree doesn't flicker a deleted-then-restored node.
    const live = pages.value.filter((p) => p.deletedAt == null)
    const map = new Map<string, TreeNode>()
    for (const p of live) {
      map.set(p.id, {
        id: p.id,
        title: p.title,
        parentId: p.parentId,
        order: p.order,
        liveDescendantCount: 0,
        children: [],
      })
    }
    const roots: TreeNode[] = []
    for (const p of live) {
      const node = map.get(p.id)!
      if (p.parentId && map.has(p.parentId)) {
        map.get(p.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    const sortRec = (arr: TreeNode[]) => {
      arr.sort((a, b) => a.order - b.order)
      arr.forEach((n) => sortRec(n.children))
    }
    sortRec(roots)
    // Post-order walk: every child's count rolls up to its parent so a
    // single O(N) pass fills the field used by PageTree's `:disabled`
    // and the delete-confirmation pre-check. Replaces the previous
    // per-render O(depth) BFS that ran N times on every reactive update.
    const fillCounts = (n: TreeNode): number => {
      let total = 0
      for (const c of n.children) total += 1 + fillCounts(c)
      n.liveDescendantCount = total
      return total
    }
    roots.forEach(fillCounts)
    return roots
  }

  /**
   * Tree scoped to a specific space. Returns the roots + nested children that
   * belong to that space. Cross-space children are pruned at the boundary so
   * the sidebar shows a clean per-space tree even though `pages.value` holds
   * every accessible page.
   *
   * Stage 4c: pages no longer cross spaces (move is same-space only), so this
   * filter is mostly a safety net. If a tree root sits outside the scope, it's
   * promoted as a root of the scoped tree.
   */
  function getTreeForSpace(spaceId: string | null): TreeNode[] {
    if (!spaceId) return getTree()
    // Stage 5: also filter trashed rows out of the scoped tree.
    const scoped = pages.value.filter((p) => p.spaceId === spaceId && p.deletedAt == null)
    const map = new Map<string, TreeNode>()
    for (const p of scoped) {
      map.set(p.id, {
        id: p.id,
        title: p.title,
        parentId: p.parentId,
        order: p.order,
        liveDescendantCount: 0,
        children: [],
      })
    }
    const roots: TreeNode[] = []
    for (const p of scoped) {
      const node = map.get(p.id)!
      if (p.parentId && map.has(p.parentId)) {
        map.get(p.parentId)!.children.push(node)
      } else {
        // Promote orphans to roots — this happens if the parent lives in
        // another space (shouldn't, but we don't crash) OR if the parent
        // was trashed (Stage 5): the orphan shows up as a root until the
        // admin restores the parent.
        roots.push(node)
      }
    }
    const sortRec = (arr: TreeNode[]) => {
      arr.sort((a, b) => a.order - b.order)
      arr.forEach((n) => sortRec(n.children))
    }
    sortRec(roots)
    // Same post-order count-fill as getTree() — keeps the field consistent
    // so the scoped tree's `:disabled` bindings don't regress.
    const fillCounts = (n: TreeNode): number => {
      let total = 0
      for (const c of n.children) total += 1 + fillCounts(c)
      n.liveDescendantCount = total
      return total
    }
    roots.forEach(fillCounts)
    return roots
  }

  function getChildren(parentId: string | null): PageNode[] {
    return pages.value
      .filter((p) => p.parentId === parentId && p.deletedAt == null)
      .sort((a, b) => a.order - b.order)
  }

  const tree = computed(() => getTree())

  return {
    pages,
    loaded,
    loading,
    loadError,
    trashed,
    trashLoaded,
    trashOffset,
    trashHasMore,
    trashLoadingMore,
    trashLoading,
    tree,
    init,
    refresh,
    reset,
    markLoaded,
    ensureChildrenLoaded,
    ensureAncestorsLoaded,
    ensureRootsLoaded,
    invalidateChildren,
    isChildrenLoaded,
    isRootsLoaded,
    createPage,
    getPage,
    getChildren,
    updatePage,
    softDeletePage,
    renamePage,
    syncPageFromServer,
    movePage,
    movePageToSpace,
    publishPageToSpace,
    duplicatePage,
    importPage,
    snapshotPage,
    getTree,
    getTreeForSpace,
    loadTrash,
    loadMoreTrash,
    restorePage,
    purgePage,
    togglePageLike,
    togglePageWatch,
    watchVersion,
  }
})

function errorMessage(e: unknown): string {
  return humanizeApiError(e)
}