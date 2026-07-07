/**
 * 文件附件的图标 + 颜色映射。
 *
 * EditView(NodeView,ImageAttachmentView)和 ReadView(renderHTML 生成的最终
 * HTML)共用同一份事实来源,避免两边表现漂移(用户报过 PDF 红色图标只在
 * EditView 出现、ReadView 退化为默认蓝色)。
 *
 * 颜色用 inline `style="color: ..."` 输出 —— `sanitize.ts` 的 style 清洗
 * 接受 #hex / rgb / 命名色,不通过 url() / expression() 等,够安全。
 * 走 inline style 而非 class,是让单条规则覆盖默认 `.attachment-file-icon`
 * 的 `color: var(--accent)`,无需为每种 MIME 写一条 CSS。
 */
export interface FileIcon {
  /** material-symbols-outlined 字体里的图标名。 */
  icon: string
  /** 前景色,只接受 sanitizeStyle 允许的颜色字面量。 */
  color: string
}

const ICON_MAP: Record<string, FileIcon> = {
  'application/pdf': { icon: 'picture_as_pdf', color: '#E74C3C' },
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    icon: 'description', color: '#2B579A',
  },
  'application/msword': { icon: 'description', color: '#2B579A' },
  // Excel
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    icon: 'table_chart', color: '#1D6F42',
  },
  'application/vnd.ms-excel': { icon: 'table_chart', color: '#1D6F42' },
  // PowerPoint
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    icon: 'co_present', color: '#D24726',
  },
  'application/vnd.ms-powerpoint': { icon: 'co_present', color: '#D24726' },
  // 压缩包
  'application/zip': { icon: 'folder_zip', color: '#F1C40F' },
  'application/x-zip-compressed': { icon: 'folder_zip', color: '#F1C40F' },
  // 文本类 —— 用 description 灰,mark 配色稍亮区分
  'text/markdown': { icon: 'description', color: '#5C6BC0' },
  'text/x-markdown': { icon: 'description', color: '#5C6BC0' },
  'text/plain': { icon: 'article', color: '#607D8B' },
  'text/csv': { icon: 'table_view', color: '#1D6F42' },
}

const FALLBACK_ICON: FileIcon = { icon: 'description', color: 'var(--text-3)' }

/** 根据 MIME 拿到文件卡要显示的图标 + 颜色。
 *  image/* 不该走到这里(走图片节点,不上文件卡)。 */
export function fileIconFor(mime: string): FileIcon {
  return ICON_MAP[mime] || FALLBACK_ICON
}
