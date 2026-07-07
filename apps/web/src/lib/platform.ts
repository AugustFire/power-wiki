/**
 * 平台检测 —— 决定快捷键 UI 显示 ⌘(Mac)还是 Ctrl(Win/Linux).
 *
 * 桌面端优先(CLAUDE.md 硬约束「不要移动端适配」),只需区分 Mac 与否。
 * `navigator.platform` 在新版浏览器被弃用但仍可用,userAgent 兜底覆盖
 * iPad / iPhone / iPod —— 避免 iPad 误判成 Windows。检测一次,用户不会
 * 在会话里切 OS —— 导出普通常量即可(不需要 ref)。
 */
export const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/Mac/.test(navigator.platform || '') ||
    /Macintosh|iPhone|iPad|iPod/.test(navigator.userAgent))

export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'
