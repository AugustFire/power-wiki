/**
 * Attachments API — 页面级附件(image/* + application/pdf),MinIO/S3 存储。
 *
 *   POST   /api/attachments/upload-url        body {pageId,originalFilename,mimeType,sizeBytes}
 *                                              → 200 {uploadUrl,attachmentId,storageKey,expiresAt}
 *   POST   /api/attachments/finalize          body {attachmentId,storageKey,sizeBytes,...}
 *                                              → 201 Attachment
 *   GET    /api/attachments?pageId=X          → 200 Attachment[]
 *   GET    /api/attachments/:id/raw           → 流式响应(inline image / attachment file)
 *   DELETE /api/attachments/:id               → 204
 *
 * 上传两步:
 *   1. upload-url:校验 + 生成 attachmentId/storageKey + presign PUT。**不写 DB**。
 *   2. 浏览器 PUT 到 presigned URL(字节不经过 API)。
 *   3. finalize:HeadObject 验证真实 size,匹配后才 INSERT 行。
 *
 * 权限模型(与 pages / labels 一致):
 *   - 写(upload-url / finalize / delete):canEditPage + admin 不写个人空间。
 *   - 读(list / raw):canReadPage;跨空间 404(不泄漏)。
 *
 * DB 是事实来源;S3 delete 是 best-effort(失败仅日志,容忍 orphan 对象)。
 */

import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { desc, eq } from 'drizzle-orm'
import {
  RequestUploadInputSchema,
  FinalizeUploadInputSchema,
  AttachmentSchema,
} from '@power-wiki/shared/schemas'
import { mimeKind, MIME_TO_EXT, MAX_UPLOAD_BYTES_DEFAULT } from '@power-wiki/shared'
import type { Attachment, AllowedMimeType } from '@power-wiki/shared'
import { db } from '../db/client'
import { attachments, pages, users } from '../db/schema'
import type { AttachmentRow } from '../db/schema'
import { canReadPage, canEditPage, principalFromUser } from '../lib/permissions'
import { assertAdminNotWritingPersonalSpace } from '../lib/personalSpaceGuard'
import { generateAttachmentId } from '../lib/ids'
import {
  presignUpload,
  streamDownload,
  headObject,
  deleteObject,
} from '../lib/s3'
import { type Variables } from '../auth/middleware'

export const attachmentsRouter = new Hono<{ Variables: Variables }>()

const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? MAX_UPLOAD_BYTES_DEFAULT,
)

/** row → 响应 DTO(补 src)。`uploaderName` 由 `getRowsForPage()` 显式
 *  LEFT JOIN users 拼上,rowToAttachment 接受可选 second arg;upload-url /
 *  finalize 路径不 JOIN(写入即时,无用户上下文外引),uploaderName = null。 */
function rowToAttachment(
  row: AttachmentRow,
  uploaderName?: string | null,
): Attachment {
  return {
    id: row.id,
    pageId: row.pageId,
    uploaderId: row.uploaderId,
    uploaderName: uploaderName ?? null,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    src: `/api/attachments/${row.id}/raw`,
    createdAt: row.createdAt,
  }
}

type PageMeta = { id: string; spaceId: string; deletedAt: number | null; authorId: string }

/**
 * 读该页的 spaceId / deletedAt。返回 null = 页不存在 / 无 spaceId / 已回收。
 * 用于读写路径统一判 404(不区分不存在 / 已删,防泄漏)。
 */
async function loadLivePage(pageId: string): Promise<PageMeta | null> {
  const [row] = await db
    .select({ id: pages.id, spaceId: pages.spaceId, deletedAt: pages.deletedAt, authorId: pages.authorId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!row || row.spaceId === null || row.deletedAt !== null) return null
  return { id: row.id, spaceId: row.spaceId, deletedAt: row.deletedAt, authorId: row.authorId }
}

/* ─── POST /api/attachments/upload-url ────────────────────────────────
 *  校验 body + mime 白名单 + 写权限,生成 presigned PUT URL。不写 DB。
 */
attachmentsRouter.post('/upload-url', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = RequestUploadInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { pageId, mimeType } = parsed.data

  const kind = mimeKind(mimeType)
  if (kind === null || !(mimeType in MIME_TO_EXT)) {
    return c.json({ error: 'invalid_input', message: '不支持的文件类型' }, 400)
  }

  const page = await loadLivePage(pageId)
  if (!page) return c.json({ error: 'not_found' }, 404)
  if (!(await canEditPage(principalFromUser(me), page.id, page.spaceId, page.authorId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  const blocked = await assertAdminNotWritingPersonalSpace(c, me, page.spaceId)
  if (blocked) return blocked

  const attachmentId = generateAttachmentId()
  const ext = MIME_TO_EXT[mimeType as AllowedMimeType]
  const storageKey = `${pageId}/${attachmentId}${ext}`
  const { url, expiresAt } = await presignUpload(storageKey, mimeType)

  return c.json({ uploadUrl: url, attachmentId, storageKey, expiresAt }, 200)
})

/* ─── POST /api/attachments/finalize ──────────────────────────────────
 *  HeadObject 验证真实 size 后 INSERT。size 不符 → 409 size_mismatch。
 */
attachmentsRouter.post('/finalize', async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const parsed = FinalizeUploadInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400)
  }
  const { attachmentId, storageKey, sizeBytes, originalFilename, mimeType } =
    parsed.data

  // storageKey 必须形如 {pageId}/{attachmentId}{ext},且第二段以 attachmentId 开头。
  const [keyPageId, keyFile] = storageKey.split('/')
  if (
    !keyPageId ||
    !keyFile ||
    (keyFile !== attachmentId && !keyFile.startsWith(`${attachmentId}.`))
  ) {
    return c.json({ error: 'invalid_input', message: 'storageKey 与 attachmentId 不匹配' }, 400)
  }

  const kind = mimeKind(mimeType)
  if (kind === null) {
    return c.json({ error: 'invalid_input', message: '不支持的文件类型' }, 400)
  }

  const page = await loadLivePage(keyPageId)
  if (!page) return c.json({ error: 'not_found' }, 404)
  if (!(await canEditPage(principalFromUser(me), page.id, page.spaceId, page.authorId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  const blocked = await assertAdminNotWritingPersonalSpace(c, me, page.spaceId)
  if (blocked) return blocked

  // 验证对象真实存在 + size 一致(不信前端上报的 size)。
  let head: { size: number }
  try {
    head = await headObject(storageKey)
  } catch (err) {
    console.warn('[finalize] headObject failed', storageKey, err)
    return c.json({ error: 'upload_not_found', message: '未找到已上传对象' }, 409)
  }
  if (head.size !== sizeBytes) {
    return c.json(
      { error: 'size_mismatch', expected: sizeBytes, actual: head.size },
      409,
    )
  }

  const [row] = await db
    .insert(attachments)
    .values({
      id: attachmentId,
      pageId: keyPageId,
      uploaderId: me.id,
      originalFilename,
      storageKey,
      mimeType,
      sizeBytes: head.size,
      kind,
      createdAt: Date.now(),
    })
    .returning()
  if (!row) return c.json({ error: 'internal', message: '写入失败' }, 500)

  return c.json(AttachmentSchema.parse(rowToAttachment(row)), 201)
})

/* ─── GET /api/attachments?pageId=X ───────────────────────────────────
 *  某页所有附件,按上传时间倒序。读权限。
 */
attachmentsRouter.get('/', async (c) => {
  const me = c.get('user')
  const pageId = c.req.query('pageId')
  if (!pageId) return c.json({ error: 'invalid_input', message: '缺少 pageId' }, 400)

  const page = await loadLivePage(pageId)
  if (!page) return c.json({ error: 'not_found' }, 404)
  if (!(await canReadPage(principalFromUser(me), page.id, page.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  const rows = await db
    .select({
      id: attachments.id,
      pageId: attachments.pageId,
      uploaderId: attachments.uploaderId,
      originalFilename: attachments.originalFilename,
      storageKey: attachments.storageKey,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      kind: attachments.kind,
      createdAt: attachments.createdAt,
      uploaderName: users.name,
    })
    .from(attachments)
    .leftJoin(users, eq(attachments.uploaderId, users.id))
    .where(eq(attachments.pageId, pageId))
    .orderBy(desc(attachments.createdAt))

  return c.json(
    rows.map((r) =>
      rowToAttachment(
        {
          id: r.id,
          pageId: r.pageId,
          uploaderId: r.uploaderId,
          originalFilename: r.originalFilename,
          storageKey: r.storageKey,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
          kind: r.kind,
          createdAt: r.createdAt,
        },
        r.uploaderName,
      ),
    ),
  )
})

/* ─── GET /api/attachments/:id/raw ────────────────────────────────────
 *  流式代理下载。image → inline;file → attachment;disposition + cache 头。
 *  S3 错误 → 502 storage_unavailable(不 500)。
 */
attachmentsRouter.get('/:id/raw', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)

  const page = await loadLivePage(row.pageId)
  if (!page) return c.json({ error: 'not_found' }, 404)
  if (!(await canReadPage(principalFromUser(me), page.id, page.spaceId))) {
    return c.json({ error: 'not_found' }, 404)
  }

  let download: Awaited<ReturnType<typeof streamDownload>>
  try {
    download = await streamDownload(row.storageKey)
  } catch (err) {
    console.warn('[raw] streamDownload failed', row.storageKey, err)
    return c.json({ error: 'storage_unavailable' }, 502)
  }

  c.header('Content-Type', row.mimeType)
  c.header('Content-Length', String(row.sizeBytes))
  c.header('Cache-Control', 'private, max-age=300')
  const disposition =
    row.kind === 'image'
      ? 'inline'
      : `attachment; filename="${encodeURIComponent(row.originalFilename)}"`
  c.header('Content-Disposition', disposition)

  return c.body(Readable.toWeb(download.body) as ReadableStream)
})

/* ─── DELETE /api/attachments/:id ─────────────────────────────────────
 *  写权限。best-effort 删 S3 对象 + 删行。204。
 */
attachmentsRouter.delete('/:id', async (c) => {
  const me = c.get('user')
  const id = c.req.param('id')

  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)

  const page = await loadLivePage(row.pageId)
  if (!page) return c.json({ error: 'not_found' }, 404)
  if (!(await canEditPage(principalFromUser(me), page.id, page.spaceId, page.authorId))) {
    return c.json({ error: 'not_found' }, 404)
  }
  const blocked = await assertAdminNotWritingPersonalSpace(c, me, page.spaceId)
  if (blocked) return blocked

  try {
    await deleteObject(row.storageKey)
  } catch (err) {
    console.warn('[delete] failed to delete object', row.storageKey, err)
  }
  await db.delete(attachments).where(eq(attachments.id, id))

  return c.body(null, 204)
})
