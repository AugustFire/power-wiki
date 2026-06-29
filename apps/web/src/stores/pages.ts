import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { newId } from '@/lib/id'
import {
  htmlToJson,
  isMigratedJSON,
  needsRemigrate,
  stampSchemaVersion,
} from '@/editor/htmlToJson'
import { emptyDoc, EMPTY_HTML, DEFAULT_TITLE, normalizeTitle } from '@/lib/constants'
import { api, ApiError } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import { useSpacesStore } from '@/stores/spaces'
import type { PageNode, TreeNode } from '@power-wiki/shared'

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
  }

  async function init(): Promise<void> {
    if (loaded.value || loading.value) return
    loading.value = true
    loadError.value = null
    try {
      const list = await api.pages.list()
      pages.value = list
      // 一次性回填存量页面的 contentJSON(种子页只有 HTML 没有 JSON,Editor 需要 JSON)
      migrateEmptyJson()
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
   * Assumes `init()` has already run. If it hasn't, the refresh call still
   * updates pages.value, but `loaded` stays false — that's the caller's bug.
   */
  async function refresh(): Promise<void> {
    try {
      const list = await api.pages.list()
      pages.value = list
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
   * 把 contentJSON 为空 {} 但 contentHTML 非空的页面回填成有效 JSON。
   * 种子页面从后端导入时没有 JSON,首次加载时一次性转换。
   */
  function migrateEmptyJson(): void {
    let changed = false
    for (const p of pages.value) {
      const html = (p.contentHTML ?? '').trim()
      if (!isMigratedJSON(p.contentJSON)) {
        if (!html || html === '<p></p>') {
          p.contentJSON = stampSchemaVersion({
            type: 'doc',
            content: [{ type: 'paragraph' }],
          })
          changed = true
          continue
        }
        try {
          p.contentJSON = stampSchemaVersion(htmlToJson(html))
          changed = true
        } catch (err) {
          console.warn(`[pages] migrate 失败 page=${p.id}`, err)
        }
        continue
      }
      if (needsRemigrate(p.contentJSON) && html && html !== '<p></p>') {
        try {
          p.contentJSON = stampSchemaVersion(htmlToJson(html))
          changed = true
        } catch (err) {
          console.warn(`[pages] re-migrate 失败 page=${p.id}`, err)
        }
      } else if (needsRemigrate(p.contentJSON)) {
        p.contentJSON = stampSchemaVersion(p.contentJSON as Record<string, unknown>)
        changed = true
      }
    }
    if (!changed) return
    // 迁移是本地计算(没改 server 端数据),不需要写回 API;但要让 server 的
    // contentJSON 与本地一致以便下次加载不需要再迁 — 批量写一次。
    void batchPersistJson()
  }

  /** 迁移完成后,把所有被改过 contentJSON 的页面 PATCH 回去。仅本地迁移后的批量回写。 */
  async function batchPersistJson(): Promise<void> {
    const dirty = pages.value.filter((p) => p.contentJSON && Object.keys(p.contentJSON).length > 0)
    await Promise.allSettled(
      dirty.map((p) =>
        api.pages
          .update(p.id, { contentJSON: p.contentJSON })
          .catch((err) => console.warn(`[pages] persist migrated JSON 失败 page=${p.id}`, err)),
      ),
    )
  }

  // ─────────────────────────────────────────────────────────────────
  //  CRUD — 全部走乐观更新 + 失败回滚
  //  snapshot 模式:先快照本地状态 → 立即变更 UI → 调 API → 失败就还原 + banner
  // ─────────────────────────────────────────────────────────────────

  async function createPage(opts: { parentId?: string | null; title?: string } = {}): Promise<PageNode> {
    const parentId = opts.parentId ?? null
    const id = newId()
    const now = Date.now()
    const siblings = pages.value.filter((p) => p.parentId === parentId)
    // Stage 4: every page belongs to a space. New pages go into the active space.
    // Guard: if user is in the manager UI without an active space, refuse cleanly.
    const spaceId = useSpacesStore().activeSpaceId.value
    if (!spaceId) throw new Error('no active space — cannot create page')
    const optimistic: PageNode = {
      id,
      parentId,
      title: opts.title ?? DEFAULT_TITLE,
      contentJSON: emptyDoc(),
      contentHTML: EMPTY_HTML,
      order: siblings.length,
      createdAt: now,
      updatedAt: now,
      authorId: 'me',
      // Optimistic placeholder — replaced by the server's response which
      // carries the real LEFT-JOIN'd authorName / authorColor.
      authorName: null,
      authorColor: null,
      spaceId,
    }
    pages.value.push(optimistic)

    try {
      const real = await api.pages.create({
        id,
        parentId,
        spaceId,
        title: opts.title ?? DEFAULT_TITLE,
      })
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
   * 更新内容字段(title / contentJSON / contentHTML / icon / starred)。
   * 父级变更请走 `movePage`。
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
    if (patch.starred !== undefined) apiPatch.starred = patch.starred

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
      // Restore may also restore other rows if the backend lifted a
      // subtree, but our spec is single-row restore. Refresh everything
      // to be safe — pages.list is cheap and not cached.
      const list = await api.pages.list()
      pages.value = list
      migrateEmptyJson()
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
   * Stage 5: load trashed pages for the active space. Called by TrashView
   * on mount; idempotent. Re-running it refetches and overwrites.
   */
  async function loadTrash(spaceId: string): Promise<void> {
    try {
      trashed.value = await api.pages.trash.list(spaceId)
      trashLoaded.value = true
    } catch (e) {
      ui().setError(`加载回收站失败: ${errorMessage(e)}`)
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
    if (newParentId) {
      const descendants = collectDescendantIds(id)
      if (descendants.has(newParentId)) throw new Error('cannot move into own descendant')
    }

    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`page not found: ${id}`)
    const snapshot = pages.value[idx]!
    // Snapshot the full pages array so we can roll back on failure.
    const pagesSnapshot = pages.value.slice()

    // Compute the new sort order for the moved page and its (former + new)
    // siblings in one pass. The server will rewrite the whole sibling list
    // atomically; we mirror it locally so the tree re-renders immediately.
    const targetSiblings = pages.value
      .filter((p) => p.parentId === newParentId && p.id !== id)
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
      return real
    } catch (e) {
      pages.value = pagesSnapshot
      ui().setError(`移动失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * Cross-space move: relocate a page (with its subtree) from its current
   * space into a different space as a root-level page. Used by the sidebar
   * "移动到..." menu to publish a personal-space draft into a team space.
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
      return real
    } catch (e) {
      pages.value = pagesSnapshot
      ui().setError(`移动到团队空间失败: ${errorMessage(e)}`)
      throw e
    }
  }

  function collectDescendantIds(id: string): Set<string> {
    const result = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const p of pages.value) {
        if (p.parentId && result.has(p.parentId) && !result.has(p.id)) {
          result.add(p.id)
          changed = true
        }
      }
    }
    return result
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
    tree,
    init,
    refresh,
    reset,
    createPage,
    getPage,
    getChildren,
    updatePage,
    softDeletePage,
    renamePage,
    movePage,
    movePageToSpace,
    getTree,
    getTreeForSpace,
    loadTrash,
    restorePage,
    purgePage,
  }
})

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}