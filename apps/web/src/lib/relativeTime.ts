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