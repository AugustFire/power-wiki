/**
 * DateInline 共享格式化
 *
 * 编辑器 NodeView 和阅读视图 JS 共用一份函数,保证两边文案一致。
 *
 * 规则:
 *   - mode='fixed'  → 始终显示 attr.iso 对应的绝对日期 YYYY/MM/DD
 *   - mode='now'    → "今天"(now 模式天然代表当下,不论 iso 何时)
 *
 * now 模式下 renderHTML 输出的静态文本只是兜底(阅读视图没 JS 时显示),
 * 实际显示由 JS 在阅读视图按当下时间重算。
 */
import type { DateMode } from '@/editor/dateInlineExtension'

export interface LiveDateAttrs {
  mode: DateMode
  iso: string
}

function formatYmd(d: Date): string {
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * 把 DateInline attrs 格式化成要展示给用户的字符串。
 * @param now 参考"当下"时间,默认 new Date();fixed 模式不使用,now 模式决定是否跨日
 */
export function formatLiveDate(attrs: LiveDateAttrs, now: Date = new Date()): string {
  if (attrs.mode === 'fixed') {
    if (!attrs.iso) return ''
    const target = new Date(attrs.iso)
    if (Number.isNaN(target.getTime())) return attrs.iso
    return formatYmd(target)
  }
  // mode === 'now': 始终是当下;"今天" 永远成立
  // 跨日时(now 已是明天)显示绝对日期,避免误导
  const today = new Date()
  const isStillToday =
    now.getFullYear() === today.getFullYear() &&
    now.getMonth() === today.getMonth() &&
    now.getDate() === today.getDate()
  return isStillToday ? '今天' : formatYmd(now)
}

/**
 * renderHTML 用的静态格式化(保存时刻确定文本)。now 模式输出绝对日期,
 * 阅读视图 JS 会按当下时间再覆盖一次;fixed 模式直接用 iso。
 */
export function formatLiveDateStatic(attrs: LiveDateAttrs): string {
  if (attrs.mode === 'fixed') {
    if (!attrs.iso) return ''
    const target = new Date(attrs.iso)
    if (Number.isNaN(target.getTime())) return attrs.iso
    return formatYmd(target)
  }
  return formatYmd(new Date())
}