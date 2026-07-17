/**
 * 标签颜色 —— 按标签名哈希到固定色板(tokens.css 的 --label-{n}-bg/fg,共 8 组)。
 *
 * 纯前端、无后端存储:同一个标签字符串在任何页面、任何视图都落到同一组颜色,
 * 无需迁移。哈希用 djb2 变体(*31 累加),对标签的规范化形式(trim+lowercase,
 * 与后端 normalizeLabel 一致)取值,保证大小写差异不会分裂颜色。
 */
const PALETTE_SIZE = 8

export function labelColorVars(label: string): { bg: string; fg: string } {
  const key = label.trim().toLowerCase()
  let h = 0
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0
  }
  const n = (h % PALETTE_SIZE) + 1
  return { bg: `var(--label-${n}-bg)`, fg: `var(--label-${n}-fg)` }
}
