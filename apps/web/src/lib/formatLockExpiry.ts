/**
 * LockBanner 倒计时格式化 —— 把 expiresAt 毫秒到 now 的差值
 * 格式化成 `m:ss`。
 *
 * 设计:
 *   - 过期值(差 ≤ 0)返回 `0:00`,banner 不显示负数。
 *   - 上限 4:59(5min 总长,差值一定 ≤ 5min)。前端每秒重渲一次,所以
 *     倒计时数字会自然走秒级。
 *   - 不引 dayjs / date-fns 之类的依赖,纯粹算差值 + padStart。
 */
export function formatLockRemaining(expiresAt: number, now: number = Date.now()): string {
  const remainingMs = Math.max(0, expiresAt - now)
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}