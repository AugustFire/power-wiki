/**
 * Tiny debounce helper.
 *
 * Same pattern as apps/web/src/composables/useMentionCandidates.ts:45 — moved
 * to a shared lib now that two callers (mention + TopSearch) need it.
 *
 * Returns a function that delays calling `fn` until `ms` milliseconds have
 * passed since the last invocation. Each call resets the timer.
 *
 * No leading-edge / no max-wait — both callers want pure trailing behavior.
 */
export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }) as T
}
