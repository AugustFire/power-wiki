/**
 * 调色板统一来源
 *
 * Atlassian Design System 的两套 8 色调色板,集中在这里:
 *   - TEXT_COLOR_PALETTE:文字前景色(8 色 + null 默认)
 *   - BG_COLOR_PALETTE:浅背景色(8 色 + null 透明),同时供文字高亮和表格单元格使用
 *
 * 历史上有 3 套独立调色板(ColorPopover 文字 / ColorPopover 高亮 /
 * EditorToolbar 单元格色),字面 hex 各自维护,容易漂移。
 * 现在统一:文字色独立一套,背景色(高亮 + 单元格)共用 BG_COLOR_PALETTE。
 *
 * 改色直接改这里,所有 popover 自动同步。
 */

export interface PaletteColor {
  name: string
  /** 实际写入 Tiptap attr 的值(text color 是 hex、highlight 是 hex) */
  value: string | null
  /** swatch 显示用的颜色,可能跟 value 不同(如默认 null 时显示深色作为视觉锚点) */
  swatch: string
  /** 是否画描边用于"默认 / 透明"无色状态 */
  ring?: boolean
}

/** 文字前景色 — 8 色饱和版,用于 inline text color */
export const TEXT_COLOR_PALETTE: PaletteColor[] = [
  { name: '默认', value: null, swatch: '#172B4D', ring: true },
  { name: '灰色', value: '#6B778C', swatch: '#6B778C' },
  { name: '红色', value: '#FF5630', swatch: '#FF5630' },
  { name: '橙色', value: '#FF8B00', swatch: '#FF8B00' },
  { name: '黄色', value: '#FFAB00', swatch: '#FFAB00' },
  { name: '绿色', value: '#36B37E', swatch: '#36B37E' },
  { name: '蓝色', value: '#0052CC', swatch: '#0052CC' },
  { name: '紫色', value: '#403294', swatch: '#403294' },
]

/** 浅背景色 — 8 色 pastel 版,用于文字 highlight + 表格单元格背景 */
export const BG_COLOR_PALETTE: PaletteColor[] = [
  { name: '无', value: null, swatch: 'transparent', ring: true },
  { name: '灰', value: '#DFE1E6', swatch: '#DFE1E6' },
  { name: '红', value: '#FFBDAD', swatch: '#FFBDAD' },
  { name: '橙', value: '#FFC400', swatch: '#FFC400' },
  { name: '黄', value: '#FFE380', swatch: '#FFE380' },
  { name: '绿', value: '#ABF5D1', swatch: '#ABF5D1' },
  { name: '蓝', value: '#79E2F2', swatch: '#79E2F2' },
  { name: '紫', value: '#B3ACF5', swatch: '#B3ACF5' },
]