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

  function ui() {
    return useUiStore()
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

  /** Re-fetch the full page list — used after admin operations, space switch, etc. */
  async function refresh(): Promise<void> {
    loaded.value = false
    await init()
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
   * 级联删除 — 后端 ON DELETE CASCADE 一次往返搞定后代;
   * 前端用 collectDescendantIds 拿到全部待删 id 做快照,失败时整批还原。
   */
  async function deletePage(id: string): Promise<void> {
    const ids = collectDescendantIds(id)
    const snapshot = pages.value.filter((p) => ids.has(p.id))
    pages.value = pages.value.filter((p) => !ids.has(p.id))

    try {
      await api.pages.delete(id)
    } catch (e) {
      // 还原(保持原顺序 — 简单 push 回数组尾部即可,顺序在 getTree() 里会按 order 重排)
      pages.value = [...pages.value, ...snapshot]
      ui().setError(`删除失败: ${errorMessage(e)}`)
      throw e
    }
  }

  /**
   * 移动节点到新父级。循环保护本地也做一次(server 是权威,但本地拒绝可以省一次往返)。
   */
  async function movePage(id: string, newParentId: string | null): Promise<PageNode> {
    if (id === newParentId) throw new Error('cannot move into self')
    if (newParentId) {
      const descendants = collectDescendantIds(id)
      if (descendants.has(newParentId)) throw new Error('cannot move into own descendant')
    }

    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`page not found: ${id}`)
    const snapshot = pages.value[idx]!
    pages.value[idx] = { ...snapshot, parentId: newParentId }

    try {
      const real = await api.pages.move(id, { newParentId })
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = real
      return real
    } catch (e) {
      const i = pages.value.findIndex((p) => p.id === id)
      if (i >= 0) pages.value[i] = snapshot
      ui().setError(`移动失败: ${errorMessage(e)}`)
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
    const map = new Map<string, TreeNode>()
    for (const p of pages.value) {
      map.set(p.id, {
        id: p.id,
        title: p.title,
        parentId: p.parentId,
        order: p.order,
        children: [],
      })
    }
    const roots: TreeNode[] = []
    for (const p of pages.value) {
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
    const scoped = pages.value.filter((p) => p.spaceId === spaceId)
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
        // another space (shouldn't, but we don't crash).
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
      .filter((p) => p.parentId === parentId)
      .sort((a, b) => a.order - b.order)
  }

  const tree = computed(() => getTree())

  return {
    pages,
    loaded,
    loading,
    loadError,
    tree,
    init,
    refresh,
    createPage,
    getPage,
    getChildren,
    updatePage,
    deletePage,
    renamePage,
    movePage,
    getTree,
    getTreeForSpace,
  }
})

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}