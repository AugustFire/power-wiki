/**
 * 上传编排:request → PUT → finalize → 插入节点。
 *
 * 三步:
 *   1. api.attachments.requestUpload  → presigned PUT URL + attachmentId + storageKey
 *   2. XMLHttpRequest PUT(uploadUrl) → 浏览器直传 MinIO(不经过 API);
 *      走 XHR 而非 fetch 是因为 fetch 不暴露上传进度,XHR 的 upload.onprogress
 *      才能让 UI 画进度条(模块 6 P0-1)。
 *   3. api.attachments.finalize        → 服务端 HeadObject 校验后写行,返回 DTO
 * 拿到 DTO 后用编辑器命令插入 imageAttachment 节点(有 pos 就定点插)。
 *
 * 错误分类(模块 6 P0-2):size_exceeded / network_error / server_unavailable /
 * upload_failed / mime_not_allowed。message 用 `kind: detail` 形式,Richer / 调用方
 * 据此给用户精确文案。
 *
 * 任一步失败即 throw;调用方负责 catch + 反馈。节点只有 finalize 成功后才插入,
 * 不会出现「上传失败但编辑器里已有半截节点」。
 */
import type { Editor } from '@tiptap/core'
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES_DEFAULT } from '@power-wiki/shared'
import type { AllowedMimeType } from '@power-wiki/shared'
import { api } from '../lib/api'

export type UploadErrorKind =
  | 'size_exceeded'
  | 'mime_not_allowed'
  | 'network_error'
  | 'server_unavailable'
  | 'upload_failed'

/** 上传进度回调。loaded / total 单位 byte;total 在 XHR 上有时拿不到(total<=0 时按已加载量显示)。 */
export type UploadProgress = (loaded: number, total: number) => void

export function isAllowedFile(file: File): boolean {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)
}

/** 客户端上传上限,与后端同一份常量;先于网络请求拦超限文件。 */
function maxBytes(): number {
  return MAX_UPLOAD_BYTES_DEFAULT
}

export async function uploadAndInsert(
  file: File,
  editor: Editor,
  pageId: string,
  pos?: number,
  onProgress?: UploadProgress,
): Promise<void> {
  if (!isAllowedFile(file)) {
    throw mkUploadError('mime_not_allowed', file.type || '未知类型')
  }
  if (file.size > maxBytes()) {
    // 客户端先拦截,免得跑了 requestUpload 拿到 presigned URL 又被 MinIO 拒,
    // 浪费一次往返 + 让用户看到的失败原因更接近真实(不是「服务不可达」)。
    throw mkUploadError('size_exceeded', `${file.size} > ${maxBytes()}`)
  }

  const { uploadUrl, attachmentId, storageKey } =
    await api.attachments.requestUpload({
      pageId,
      originalFilename: file.name,
      mimeType: file.type as AllowedMimeType,
      sizeBytes: file.size,
    })

  await putWithProgress(uploadUrl, file, onProgress)

  const dto = await api.attachments.finalize({
    attachmentId,
    storageKey,
    sizeBytes: file.size,
    originalFilename: file.name,
    mimeType: file.type,
  })

  const arg = {
    id: dto.id,
    kind: dto.kind,
    mimeType: dto.mimeType,
    originalFilename: dto.originalFilename,
    sizeBytes: dto.sizeBytes,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = (editor as any).chain().focus()
  if (typeof pos === 'number') {
    chain.insertAttachmentAt(arg, pos).run()
  } else {
    chain.insertAttachment(arg).run()
  }
}

/**
 * 把 fetch PUT 换成 XHR(为了 onprogress),并按错误源抛不同 kind:
 *   - xhr.onerror / ontimeout + 没收到 status → network_error(本地 / 链路断)
 *   - 5xx(502 / 503 / 504)→ server_unreachable(MinIO 不可达 / S3 异常)
 *   - 其它 4xx → upload_failed(签名过期、Content-Type 不符、CORS 等)
 * 注意 abort() 由调用方控制(XHR 没有自动 abort,失败就让它走完 onloadend)。
 */
function putWithProgress(
  uploadUrl: string,
  file: File,
  onProgress?: UploadProgress,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl, true)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (onProgress) onProgress(e.loaded, e.total || file.size)
    }
    xhr.onerror = () => reject(mkUploadError('network_error', 'xhr.onerror'))
    xhr.ontimeout = () => reject(mkUploadError('network_error', 'timeout'))
    xhr.onload = () => {
      const status = xhr.status
      if (status >= 200 && status < 300) {
        if (onProgress) onProgress(file.size, file.size)
        resolve()
        return
      }
      if (status === 502 || status === 503 || status === 504) {
        reject(mkUploadError('server_unavailable', String(status)))
      } else {
        reject(mkUploadError('upload_failed', String(status)))
      }
    }
    xhr.send(file)
  })
}

/**
 * 上传编排(替换版本):用于 EditView hover 工具栏的 Replace 按钮。
 *
 * 与 uploadAndInsert 共用前 3 步,差异:
 *   - 不 insert 新节点,而是 update 旧节点 attrs(保留 alt/caption/align)
 *   - 旧 attachment 走 best-effort 清理(api.attachments.remove);若失败仅日志
 *   - 新 attachment 替换失败(节点已被用户删 / undo)→ 回滚,删新 attachment
 *
 * 抛出 size_exceeded / upload_failed / replace_failed / network_error /
 * server_unavailable 等错误。Replace 流程比较短(MB 几 MB 替代图)且
 * 发生在用户已聚焦 hover 工具栏的瞬间,不显示进度条;但错误分类
 * 跟 uploadAndInsert 对齐,让 catch 端可以共用 humanize。
 */
export async function uploadAndReplace(
  file: File,
  editor: Editor,
  oldId: string,
  pageId: string,
): Promise<void> {
  if (!isAllowedFile(file)) {
    throw mkUploadError('mime_not_allowed', file.type || '未知类型')
  }
  if (file.size > maxBytes()) {
    throw mkUploadError('size_exceeded', `${file.size} > ${maxBytes()}`)
  }

  const { uploadUrl, attachmentId, storageKey } =
    await api.attachments.requestUpload({
      pageId,
      originalFilename: file.name,
      mimeType: file.type as AllowedMimeType,
      sizeBytes: file.size,
    })

  await putWithProgress(uploadUrl, file)

  const dto = await api.attachments.finalize({
    attachmentId,
    storageKey,
    sizeBytes: file.size,
    originalFilename: file.name,
    mimeType: file.type,
  })

  const newArg = {
    id: dto.id,
    kind: dto.kind,
    mimeType: dto.mimeType,
    originalFilename: dto.originalFilename,
    sizeBytes: dto.sizeBytes,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ok = (editor as any)
    .chain()
    .focus()
    .replaceAttachment(oldId, newArg)
    .run()

  if (!ok) {
    // 旧节点已不在 doc 里(用户可能 undo / 删了) → 不留孤儿,删新 attachment
    api.attachments.remove(dto.id).catch((err) => {
      console.warn('[uploadAndReplace] rollback remove failed', dto.id, err)
    })
    throw new Error('replace_failed: node_not_found')
  }

  // best-effort:清理旧 attachment(S3 对象 + DB 行)。失败留 orphan,日志即可
  api.attachments.remove(oldId).catch((err) => {
    console.warn('[uploadAndReplace] remove old attachment failed', oldId, err)
  })
}

/** 把上传错误统一包装成 `Error` + 携带 `kind` 字段,供 catch 端 humanize。 */
export class UploadError extends Error {
  kind: UploadErrorKind
  detail?: string
  constructor(kind: UploadErrorKind, message: string, detail?: string) {
    super(message)
    this.name = 'UploadError'
    this.kind = kind
    this.detail = detail
  }
}
function mkUploadError(kind: UploadErrorKind, detail?: string): UploadError {
  return new UploadError(kind, `${kind}${detail ? `: ${detail}` : ''}`, detail)
}
