/**
 * usePageAttachments — page 级附件列表的数据层。
 *
 * 跟 `usePaginatedList` 同代风格,但不预分页(单页附件数 < 100 是常态,
 * 一次性拉完更简单,首版不做 "加载更多" 按钮)。
 *
 * 行为:
 * - `load()` 调 `api.attachments.listForPage(pageId)`,GET 缓存(30s TTL,
 *   finalize 后由 `api.attachments.finalize` 自带 invalidatePrefix)兜底。
 * - `refresh()` 先 `invalidatePath('GET', '/attachments?pageId=...')` 再
 *   `load()` —— 组件用它在「重试」按钮 / 显式重拉时绕过缓存。
 * - `remove(id)` 乐观更新:先把行从 items 拿掉(让 UI 立刻消失),调
 *   `api.attachments.remove(id)`,失败回滚。`api.attachments.remove` 内部
 *   自带 `invalidatePrefix('/attachments')` —— 后续 listForPage 拉到的
 *   也已经是删除后的视图,但乐观更新让用户看到的是 0 网络延迟。
 * - 监听 `pageId` 变化自动重拉(ReadView 路由切页、EditView id 切换均
 *   触发,不需要调用方手动 reset)。
 *
 * 调用方约定:
 * - `items.length === 0 && !loading` 时组件**不渲染**整个 section(零干扰,
 *   跟 CommentsSection 一样不强占位)。
 * - 不做"上传后即时刷新":finalize 已有 invalidatePrefix,下一次进入/切路由
 *   自然拉到最新;若用户在 EditView 多次上传,可在 UploadStatus 的"完成"后
 *   显式调 `refresh()` —— v1 不接,保持 composable 简单。
 */
import { ref, watch, type Ref } from 'vue'
import type { Attachment } from '@power-wiki/shared'
import { api, invalidatePath } from '@/lib/api'

export interface UsePageAttachmentsReturn {
  items: Ref<Attachment[]>
  loading: Ref<boolean>
  error: Ref<unknown>
  load: () => Promise<void>
  refresh: () => Promise<void>
  /** Optimistic remove:从 items 拿掉行 → 调 API;失败回滚原行。 */
  remove: (id: string) => Promise<void>
}

export function usePageAttachments(
  pageId: Ref<string | null> | (() => string | null),
): UsePageAttachmentsReturn {
  const items: Ref<Attachment[]> = ref([])
  const loading = ref(false)
  const error = ref<unknown>(null)

  function resolveId(): string | null {
    return typeof pageId === 'function' ? pageId() : pageId.value
  }

  async function load(): Promise<void> {
    const id = resolveId()
    if (!id) {
      items.value = []
      error.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      items.value = await api.attachments.listForPage(id)
    } catch (e) {
      error.value = e
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    const id = resolveId()
    if (id) invalidatePath('GET', `/attachments?pageId=${encodeURIComponent(id)}`)
    await load()
  }

  /**
   * Optimistic remove:不依赖 GET 缓存失效(在 30s TTL 内 listForPage 仍会
   * 看到旧数据),但 `api.attachments.remove` 内部调 invalidatePrefix 把
   * 这个 pageId 的缓存清了,下一次 load 自然拿不到。乐观更新让用户看到
   * 「立刻消失」,失败回滚保证一致性 —— 跟 CommentsSection.onDeleted
   * 是同一个模式。
   */
  async function remove(id: string): Promise<void> {
    const idx = items.value.findIndex((a) => a.id === id)
    if (idx < 0) return
    const snapshot = items.value[idx]!
    items.value = items.value.filter((a) => a.id !== id)
    try {
      await api.attachments.remove(id)
    } catch (e) {
      // rollback:在原位置插回(保持顺序)
      const next = items.value.slice()
      next.splice(Math.min(idx, next.length), 0, snapshot)
      items.value = next
      throw e
    }
  }

  watch(
    () => resolveId(),
    (next, prev) => {
      if (next !== prev) void load()
    },
    { immediate: true },
  )

  return { items, loading, error, load, refresh, remove }
}
