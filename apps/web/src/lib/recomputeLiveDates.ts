/**
 * 阅读视图 live date 重算
 *
 * 找出 root 下所有 <time data-date-mode="now" data-date="..."> 节点,
 * 按当下时间重写它们的文本(now 模式下文本天然代表当下,所以一直显示
 * "今天" 或跨日的绝对日期)。
 *
 * ReadView 在 v-html 之后 + 每 60s 调用一次。
 */
import { formatLiveDate } from './dateFormat'

const SELECTOR = 'time.date-inline[data-date-mode="now"]'

export function recomputeLiveDates(root: HTMLElement): void {
  const nodes = root.querySelectorAll<HTMLElement>(SELECTOR)
  const now = new Date()
  nodes.forEach((el) => {
    const iso = el.getAttribute('data-date') || ''
    const text = formatLiveDate({ mode: 'now', iso }, now)
    // 只替换第一个文本子节点,保留其它子节点(目前 .di-pill 是 Vue 加的,
    // v-html 后没有,所以可以安全地清空重写)
    el.textContent = text
  })
}

/**
 * 启动一个 60s 定时器,周期性重算所有 now date 节点。
 * 返回 stop 函数,在 unmount 时调用。
 */
export function startLiveDateInterval(root: HTMLElement): () => void {
  const tick = () => recomputeLiveDates(root)
  const id = window.setInterval(tick, 60_000)
  return () => window.clearInterval(id)
}