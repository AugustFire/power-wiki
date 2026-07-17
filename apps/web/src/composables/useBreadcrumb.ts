/**
 * useBreadcrumb — 算出当前页的 root 链 + 折叠渲染分段。
 *
 * 复用 ReadView / EditView 两边的面包屑逻辑(原本 ReadView 内部 computed,
 * EditView 只看 parentPage —— 一个是 full chain,一个是单层,不一致)。
 * 现在两边都走同一份 composable,保证产品行为统一(5+ 层深页面两边都
 * 看到完整祖辈链;中间省略 + … 折叠策略两边一致)。
 *
 * 数据来源:`pagesStore.getPage(id)` 链式 walk parentId。如果某层 parent
 * 还没在 store 里(深层页首次打开,祖辈还没加载),`getPage` 返回
 * undefined,walk 提前终止 —— 链在已有数据范围内尽量往回走,不阻塞 UI。
 */
import { computed, type ComputedRef } from 'vue'
import { usePagesStore } from '@/stores/pages'
import type { PageNode } from '@power-wiki/shared'

export interface CrumbItem {
  id: string
  title: string
}

export interface VisibleBreadcrumb {
  /** 第一段 + 中间段(head 内部除最后一段外都应是链接) */
  head: CrumbItem[]
  /** 中间是否省略了若干段 */
  ellipsis: boolean
  /** 倒数两段(tail 内部除最后一段外都应是链接) */
  tail: CrumbItem[]
}

const COLLAPSE_THRESHOLD = 3
const TAIL_KEEP = 2

/**
 * Computes the full root → current chain for a given page id. Reactive —
 * subscribes to `pagesStore.pages`, so a page rename or a parent swap
 * automatically propagates to the breadcrumb.
 */
export function useBreadcrumb(
  pageIdGetter: () => string | null | undefined,
): {
  breadcrumb: ComputedRef<CrumbItem[]>
  visibleBreadcrumb: ComputedRef<VisibleBreadcrumb>
} {
  const pagesStore = usePagesStore()

  const breadcrumb = computed<CrumbItem[]>(() => {
    const id = pageIdGetter()
    if (!id) return []
    const chain: CrumbItem[] = []
    let cur: PageNode | undefined = pagesStore.getPage(id)
    let guard = 0
    while (cur && guard++ < 1000) {
      chain.unshift({ id: cur.id, title: cur.title })
      cur = cur.parentId ? pagesStore.getPage(cur.parentId) : undefined
    }
    return chain
  })

  /**
   * 折叠策略:≤ 3 段全显(头/尾无省略);> 3 段保留 head[0] + … + tail 最后 2 段。
   * 与之前 ReadView 的 `visibleBreadcrumb` 行为一致 —— 行为升级到
   * composable 级别后,EditView 也用同一套。
   */
  const visibleBreadcrumb = computed<VisibleBreadcrumb>(() => {
    const arr = breadcrumb.value
    if (arr.length <= COLLAPSE_THRESHOLD) {
      return { head: arr, ellipsis: false, tail: [] }
    }
    return {
      head: [arr[0]!],
      ellipsis: true,
      tail: arr.slice(-TAIL_KEEP),
    }
  })

  return { breadcrumb, visibleBreadcrumb }
}
