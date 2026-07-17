/**
 * DateInline 格式化 —— 仅 ISO → YYYY/MM/DD。
 *
 * 历史背景:本文件原本区分 `mode='fixed'`(绝对日期)与 `mode='now'`(动态
 * "今天"),后者已删除。formatLiveDate / formatLiveDateStatic 也跟着合并
 * 成单一函数:输入 ISO,输出 zh-CN 格式化的绝对日期。renderHTML 静态
 * 渲染与 Vue NodeView 渲染共用同一个 formatYmd,两边文案一致。
 */

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/**
 * 把 ISO 字符串(或任意可被 Date 解析的字符串)格式化为 YYYY/MM/DD。
 * 非法输入返回原始 iso 字符串兜底,避免渲染崩溃。
 */
export function formatYmd(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`
}