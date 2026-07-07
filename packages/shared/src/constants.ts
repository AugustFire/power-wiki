/**
 * Frontend + backend 共享的运行时常量。
 *
 * 设计原则:能放 shared 的就放 shared,避免前端默认值跟后端默认值漂移(参见
 * 历史上 PageTitleSchema 校验空字符串的 regression — bug 来自后端默认
 * `''`、前端默认 `DEFAULT_TITLE`,同一字段两份定义必然不一致)。
 */

/** 新页 / 没 title 时的回退标题。后端在 INSERT 也用这个,所以任何新建路径
 *  (前端 createPage 乐观占位、服务端 POST /api/pages)都不会违反
 *  `PageTitleSchema.min(1)`。 */
export const DEFAULT_TITLE = '无标题页面'

/* ─────────────────────────────────────────────────────────────────
 *  页面附件(image/* + application/pdf)
 *  ─────────────────────────────────────────────────────────────────
 *  前后端共用的 MIME 白名单 + 扩展名映射 + 体积上限。
 *  这些值是单一事实来源:前端 file picker 过滤、后端 upload-url/finalize
 *  校验、Tiptap paste/drop handler 都从这里取,避免漂移。
 */

/** 允许上传的 MIME。前端 accept / 后端 safeParse 都用这个列表。
 *
 *  范围:image/* + 常见 Office + Markdown / 纯文本。
 *  - 缩略图 / 预览(转图、转 HTML)不做 —— 文件卡直接给下载按钮。
 *  - 全局媒体库留待 v2,这里只允许页面级附件。
 *  - 外部 URL 粘贴仍被 sanitize.ts 的 img src 白名单挡掉,本表只是上传入口。
 */
export const ALLOWED_MIME_TYPES = [
  // 图片
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // PDF
  'application/pdf',
  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // PowerPoint
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Markdown / 纯文本 / CSV —— 文本类文件统一做下载卡
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'text/csv',
  // 常见压缩包(便于发设计稿 / 资源)
  'application/zip',
  'application/x-zip-compressed',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

/** MIME → 决定编辑器渲染为 image 节点(图)还是 file 节点(下载卡)。
 *  image/* 走图;其它全部走 file 卡(无缩略图,直接给下载)。 */
export function mimeKind(mime: string): 'image' | 'file' | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'file'
  // 其它白名单 MIME 都是 file
  if ((ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) return 'file'
  return null
}

/** MIME → 固化扩展名。固化(而不是信任原文件名)是为了防止 .svg/.pdf 等
 *  落地后被改名伪装。S3 object key 末尾就贴这个扩展名。 */
export const MIME_TO_EXT: Record<AllowedMimeType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/markdown': '.md',
  'text/x-markdown': '.md',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
}

/** 单次上传字节上限。默认 20 MB;服务端可通过 MAX_UPLOAD_BYTES env 覆盖,
 *  但前端 FinalizeUploadInputSchema 也用它做 max() 边界 —— 客户端 sizeBytes
 *  不可信,这里是给前端友好提示,服务端 HeadObject 才是真实来源。 */
export const MAX_UPLOAD_BYTES_DEFAULT = 20 * 1024 * 1024
