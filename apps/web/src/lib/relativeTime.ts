/**
 * Format a unix-ms timestamp as a Chinese relative-time string.
 *
 * One canonical implementation — extracted from the six pre-existing
 * copies in ReadView / HomeView / SpacesView / TrashView / CommentItem /
 * NotificationBell. All call sites now share this single source so a
 * future wording change happens in one place.
 *
 * Format ladder:
 *   < 60s              → '刚刚'
 *   < 60min            → 'N 分钟前'
 *   < 24h              → 'N 小时前'
 *   < 30d              → 'N 天前'
 *   anything older     → locale date (zh-CN)
 *
 * Notes vs the originals:
 *   - `Math.max(0, ...)` defends against client clock skew (negative diffs).
 *   - `Math.round` on the minute/hour/day boundaries (so 1m59s reads as
 *     "2 分钟前", which matches user intuition better than floor).
 *   - 30-day cutoff matches CommentItem/NotificationBell; the older
 *     ReadView/HomeView/SpacesView/TrashView used 7 days. 30d is more
 *     useful for admin views where a row may be a few weeks old.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const sec = Math.round(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/**
 * Future-relative variant of `formatRelativeTime` — for timestamps that lie
 * ahead of `now` (e.g. share expiration `expiresAt`). Mirrors the same
 * ladder but emits "N {秒/分钟/小时/天}后" so the read direction matches the
 * event ("7 天后过期" 而不是 "刚刚",后者来自 `formatRelativeTime` 把 future
 * diff clamp 到 0 后的退化显示 —— ShareDialog 过期列就栽在这)。
 *
 * Past timestamps (ts ≤ now) likewise clamp to "刚刚" — for expired events
 * the status pill (`已过期` / `已撤销`) 已经给出明确状态,这里再冗余地显示
 * "刚刚" 也无意义;call site 如果需要分 past / future 应先判 `ts > now`。
 */
export function formatRelativeTimeFuture(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, ts - now)
  const sec = Math.round(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟后`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} 小时后`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day} 天后`
  return new Date(ts).toLocaleDateString('zh-CN')
}