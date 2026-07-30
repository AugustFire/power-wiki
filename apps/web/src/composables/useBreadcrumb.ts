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
 *
 * P2 收口:`usePageBreadcrumbSegments` 把 visibleBreadcrumb 适配到统一
 * <Breadcrumb> 组件的 segments[] API,所有 page-chain 场景(Read/Edit/
 * History)只喂数组,组件渲染走同一份 DOM/class 树。
 */
import { computed, type ComputedRef } from 'vue'
import { usePagesStore } from '@/stores/pages'
import type { PageNode } from '@power-wiki/shared'
import type { BreadcrumbItem } from '@/components/ui/Breadcrumb.vue'

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

/**
 * 把 useBreadcrumb 的 visibleBreadcrumb 适配到 <Breadcrumb> 组件的
 * BreadcrumbItem[] 形状,page-chain 场景的视图(Read/Edit/History)只
 * 喂数组、组件渲染走同一份 DOM/class 树,不再各自拼 ellipsis 模板。
 *
 * 末段(`current`)永远是 .current(不挂链接),祖先段全挂 `/p/:id` 链接。
 * `currentLabel` 用来覆盖末段显示文案(EditView 的「未命名」),不传则用
 * store 里的页面标题。
 * `trailingLabel` 则是在整条页面链之后再追加一段(HistoryView 的
 * 「版本历史」)—— 此时页面本身那段也变成链接,兼作「返回页面」通道。
 *
 * 空 chain(新建未存页 + 没 parentId,或 store 还没回包)只在 caller 显式
 * 传 currentLabel / trailingLabel 时返回单段;否则返回 [],组件不会渲染
 * 任何东西。
 */
export function usePageBreadcrumbSegments(
  pageIdGetter: () => string | null | undefined,
  options?: {
    currentLabel?: () => string | undefined
    trailingLabel?: () => string | undefined
  },
): ComputedRef<BreadcrumbItem[]> {
  const { visibleBreadcrumb } = useBreadcrumb(pageIdGetter)
  return computed<BreadcrumbItem[]>(() => {
    const { head, ellipsis, tail } = visibleBreadcrumb.value
    const trailing = options?.trailingLabel?.()
    const chain: Array<CrumbItem | null> = [...head]
    if (ellipsis) chain.push(null, ...tail)

    const items: BreadcrumbItem[] = []
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]
      if (!c) {
        items.push({ ellipsis: true })
        continue
      }
      // 链尾那段:没有 trailing 时是 .current(可被 currentLabel 覆盖文案),
      // 有 trailing 时降级成链接,把 .current 让给 trailing 段。
      if (i === chain.length - 1 && trailing == null) {
        items.push({ label: options?.currentLabel?.() ?? c.title })
      } else {
        items.push({ label: c.title, to: `/p/${c.id}` })
      }
    }
    if (trailing != null) items.push({ label: trailing })

    if (items.length === 0) {
      const label = options?.currentLabel?.() ?? trailing
      return label ? [{ label }] : []
    }
    return items
  })
}
