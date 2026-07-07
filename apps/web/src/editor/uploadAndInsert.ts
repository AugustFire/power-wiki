/**
 * 上传编排:request → PUT → finalize → 插入节点。
 *
 * 三步:
 *   1. api.attachments.requestUpload  → presigned PUT URL + attachmentId + storageKey
 *   2. fetch(uploadUrl, PUT, body=file) → 浏览器直传 MinIO(不经过 API)
 *   3. api.attachments.finalize        → 服务端 HeadObject 校验后写行,返回 DTO
 * 拿到 DTO 后用编辑器命令插入 imageAttachment 节点(有 pos 就定点插)。
 *
 * 任一步失败即 throw;调用方负责 catch + 反馈。节点只有 finalize 成功后才插入,
 * 不会出现「上传失败但编辑器里已有半截节点」。
 */
import type { Editor } from '@tiptap/core'
import { ALLOWED_MIME_TYPES } from '@power-wiki/shared'
import type { AllowedMimeType } from '@power-wiki/shared'
import { api } from '../lib/api'

export function isAllowedFile(file: File): boolean {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)
}

export async function uploadAndInsert(
  file: File,
  editor: Editor,
  pageId: string,
  pos?: number,
): Promise<void> {
  if (!isAllowedFile(file)) {
    throw new Error(`mime_not_allowed: ${file.type || '未知类型'}`)
  }

  const { uploadUrl, attachmentId, storageKey } =
    await api.attachments.requestUpload({
      pageId,
      originalFilename: file.name,
      mimeType: file.type as AllowedMimeType,
      sizeBytes: file.size,
    })

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  })
  if (!put.ok) throw new Error(`upload_failed: ${put.status}`)

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
 * 上传编排(替换版本):用于 EditView hover 工具栏的 Replace 按钮。
 *
 * 与 uploadAndInsert 共用前 3 步,差异:
 *   - 不 insert 新节点,而是 update 旧节点 attrs(保留 alt/caption/align)
 *   - 旧 attachment 走 best-effort 清理(api.attachments.remove);若失败仅日志
 *   - 新 attachment 替换失败(节点已被用户删 / undo)→ 回滚,删新 attachment
 *
 * 抛出 mime_not_allowed / upload_failed / replace_failed 三类错误,
 * 调用方 alert + console,跟 Toolbar / SlashMenu / paste / drop 一致。
 */
export async function uploadAndReplace(
  file: File,
  editor: Editor,
  oldId: string,
  pageId: string,
): Promise<void> {
  if (!isAllowedFile(file)) {
    throw new Error(`mime_not_allowed: ${file.type || '未知类型'}`)
  }

  const { uploadUrl, attachmentId, storageKey } =
    await api.attachments.requestUpload({
      pageId,
      originalFilename: file.name,
      mimeType: file.type as AllowedMimeType,
      sizeBytes: file.size,
    })

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  })
  if (!put.ok) throw new Error(`upload_failed: ${put.status}`)

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
