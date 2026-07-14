/**
 * useFocusTrap — vanilla focus trap composable for modals/drawers.
 *
 * 打开时:
 *   - 记住当前 activeElement 作为 returnFocus
 *   - 下一帧聚焦首 focusable(或 opts.initialFocus / [autofocus])
 *   - 监听 container 内的 Tab / Shift+Tab,边界处 wrap
 *
 * 关闭时:
 *   - 恢复 returnFocus.focus()
 *
 * 注意:
 *   - keydown listener 绑到 **container**(不是 document),避免跟
 *     Modal/Drawer 已有的 document-level Escape 监听冲突
 *   - 编程式 `.focus()` 浏览器 heuristic 不触发 :focus-visible —— 鼠标
 *     点开 dialog 时不会闪聚焦框,符合项目"仅键盘聚焦时显环"的硬约束
 *
 * 用法:
 *   const dialogRef = ref<HTMLElement | null>(null)
 *   useFocusTrap(dialogRef, () => props.open, {
 *     initialFocus: '[autofocus]',  // 可选:CSS 选择器
 *   })
 *
 *   <div ref="dialogRef" class="modal-dialog">…</div>
 */
import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface UseFocusTrapOptions {
  /**
   * 初始聚焦目标。可选:
   *   - CSS 选择器字符串 (e.g. '[autofocus]', 'input[name="title"]')
   *   - Ref<HTMLElement | null>
   *   - undefined:聚焦第一个 focusable 元素
   */
  initialFocus?: string | Ref<HTMLElement | null>
}

function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el === document.activeElement
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  )
  return nodes.filter(isVisible)
}

function resolveInitialFocus(
  container: HTMLElement,
  opts?: UseFocusTrapOptions,
): HTMLElement | null {
  if (opts?.initialFocus) {
    const target =
      typeof opts.initialFocus === 'string'
        ? container.querySelector<HTMLElement>(opts.initialFocus)
        : opts.initialFocus.value
    if (target) return target
  }
  // [autofocus] 兜底(ConfirmDialog 已有 autofocus 属性)
  const autofocus = container.querySelector<HTMLElement>('[autofocus]')
  if (autofocus) return autofocus
  return getFocusable(container)[0] ?? container
}

export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean> | (() => boolean),
  opts?: UseFocusTrapOptions,
): void {
  let returnFocusEl: HTMLElement | null = null
  let bound: HTMLElement | null = null

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !bound) return
    const focusable = getFocusable(bound)
    if (focusable.length === 0) {
      // container 内没有可聚焦元素,锁焦点在 container 自身
      e.preventDefault()
      bound.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement as HTMLElement | null
    if (e.shiftKey) {
      if (current === first || !bound.contains(current)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (current === last || !bound.contains(current)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  function bind(container: HTMLElement): void {
    unbind()
    bound = container
    returnFocusEl = (document.activeElement as HTMLElement | null) ?? null
    container.addEventListener('keydown', onKeydown)
    // 下一帧聚焦,等 v-if/transition 渲染完成
    void nextTick(() => {
      const target = resolveInitialFocus(container, opts)
      target?.focus({ preventScroll: false })
    })
  }

  function unbind(): void {
    if (bound) {
      bound.removeEventListener('keydown', onKeydown)
      bound = null
    }
    if (returnFocusEl && document.contains(returnFocusEl)) {
      returnFocusEl.focus({ preventScroll: true })
    }
    returnFocusEl = null
  }

  watch(
    () => (typeof active === 'function' ? active() : active.value),
    (isActive) => {
      const container = containerRef.value
      if (!container) return
      if (isActive) {
        bind(container)
      } else {
        unbind()
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    unbind()
  })
}