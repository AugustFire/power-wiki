/**
 * 调色板统一来源
 *
 * Atlassian Design System 的多套调色板,集中在这里:
 *   - TEXT_COLOR_PALETTE:文字前景色(8 色 + null 默认),用于 inline text color
 *   - BG_COLOR_PALETTE:浅背景色(8 色 + null 透明),同时供文字高亮和表格单元格使用
 *   - SPACE_COLOR_PALETTE:空间身份色(Atlassian 标准 8 色),用于 SpacesView /
 *     SpaceEditView 的色板选择器,以及 SpaceAvatar 的 space.color 取值
 *
 * 历史上有 3 套独立调色板(ColorPopover 文字 / ColorPopover 高亮 /
 * EditorToolbar 单元格色),字面 hex 各自维护,容易漂移。
 * 现在统一:文字色独立一套,背景色(高亮 + 单元格)共用 BG_COLOR_PALETTE。
 * 空间身份色另算一套(语义跟编辑器内的文字 / 背景色不一样),但同样在
 * 之前是 SpacesView + SpaceEditView 各写一份,2026-07-16 收回本文件。
 *
 * 改色直接改这里,所有 popover / 空间色板自动同步。
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

/**
 * 空间身份色 — Atlassian 标准 8 色(Confluence 空间图标调色板):
 *   Blue / Teal / Green / Yellow / Orange / Red / Purple / Gray。
 * 专给 SpacesView / SpaceEditView 的色板选择器和 SpaceAvatar 的
 * `space.color` 取值用。语义跟 TEXT / BG 区分开:
 *   - 颜色值会原样写入 `spaces.color` 列(后端不限定具体色值,只是
 *     客户端 swatch 限定了这 8 色供选择)
 *   - SpaceAvatar 直接读 `space.color` 渲染背景,不查这份调色板
 *   - 已存在但落在旧色板(#00875A / #0065FF / #403294 等)的空间保留
 *     原色,不会因 palette 升级被改写。SpaceEditView 打开时无 swatch
 *     处于 active 态属已知行为 —— 用户可主动点新色覆盖。
 * 集中在此,避免 SpacesView / SpaceEditView 各写一份出现字面量漂移。
 */
export const SPACE_COLOR_PALETTE: PaletteColor[] = [
  { name: '蓝色', value: '#0052CC', swatch: '#0052CC' },
  { name: '青色', value: '#00B8D9', swatch: '#00B8D9' },
  { name: '绿色', value: '#36B37E', swatch: '#36B37E' },
  { name: '黄色', value: '#FFAB00', swatch: '#FFAB00' },
  { name: '橙色', value: '#FF8B00', swatch: '#FF8B00' },
  { name: '红色', value: '#FF5630', swatch: '#FF5630' },
  { name: '紫色', value: '#6554C0', swatch: '#6554C0' },
  { name: '灰色', value: '#6B778C', swatch: '#6B778C' },
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