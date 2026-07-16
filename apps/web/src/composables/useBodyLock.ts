/**
 * useBodyLock — 弹层打开时锁 body 滚动,关闭 / 卸载时精确还原。
 *
 * 抽出 Modal / Drawer / ConfirmDialog / CheatSheetModal / ImportMarkdownModal
 * 各自重复的「保存 prevOverflow → 设 hidden → 还原」样板。还原时写回打开前的
 * 值而不是空串,避免多个弹层叠开时前一个把后一个的锁解掉。
 *
 * 用法:
 *   useBodyLock(() => props.open)     // getter
 *   useBodyLock(open)                 // ref
 */
import { onBeforeUnmount, toValue, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

export function useBodyLock(active: MaybeRefOrGetter<boolean>): void {
  let prevOverflow = ''
  let locked = false

  function lock(): void {
    if (locked) return
    prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    locked = true
  }

  function unlock(): void {
    if (!locked) return
    document.body.style.overflow = prevOverflow
    locked = false
  }

  watch(
    () => toValue(active),
    (open) => {
      if (open) lock()
      else unlock()
    },
    { immediate: true },
  )

  onBeforeUnmount(unlock)
}
