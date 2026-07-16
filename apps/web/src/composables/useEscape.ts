/**
 * useEscape — 弹层打开时监听 Esc 关闭,关闭 / 卸载时摘掉监听。
 *
 * 抽出各弹层重复的「open 时 addEventListener('keydown') → 判 Escape →
 * 关闭时 removeEventListener」样板。只处理 Escape;需要额外键(Enter /
 * Cmd+Enter)的弹层自己再挂一个单键监听即可。
 *
 * handler 只在 active 为真且按下 Escape 时触发;preventDefault 已代为调用,
 * 调用方不必重复。
 *
 * 用法:
 *   useEscape(() => props.open, close)
 */
import { onBeforeUnmount, toValue, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

export function useEscape(
  active: MaybeRefOrGetter<boolean>,
  handler: () => void,
): void {
  function onKey(e: KeyboardEvent): void {
    if (!toValue(active)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      handler()
    }
  }

  let bound = false
  function bind(): void {
    if (bound) return
    document.addEventListener('keydown', onKey)
    bound = true
  }
  function unbind(): void {
    if (!bound) return
    document.removeEventListener('keydown', onKey)
    bound = false
  }

  watch(
    () => toValue(active),
    (open) => {
      if (open) bind()
      else unbind()
    },
    { immediate: true },
  )

  onBeforeUnmount(unbind)
}
