/**
 * 跨页复制附件 + 改写内容里的附件引用 —— publish(跨空间发布)复用。
 *
 * 背景:publish / duplicate 都是把源页的 contentJson / contentHtml **逐字**
 * 拷到新页。内容里的图片 / 文件节点引用的是 `/api/attachments/{id}/raw`,
 * 而 attachment 行是挂在**源页** pageId 下的。跨空间发布时:
 *   - 团队成员读不到源页所在的个人空间 → raw 端点 canAccessSpace 404 → 裂图;
 *   - 源草稿被删 → 附件行随源页 purge → 已发布页永久裂图。
 * 所以发布必须给新页复制一份**独立**的附件(S3 对象 + DB 行),并把内容里的
 * 旧 attachment id 改写成新 id。
 *
 * 用法(在事务内):
 *   const idMap = await copyPageAttachments(tx, srcPageId, newPageId, uploaderId, now)
 *   const { contentJson, contentHtml } = rewriteAttachmentRefs(src.contentJson, src.contentHtml, idMap)
 *   // 用改写后的 content 建新页
 *
 * S3 复制失败会 throw —— 让调用方回滚事务并回 502,不建裂图页。已复制成功的
 * S3 对象会成为孤儿对象(DB 是事实来源,容忍孤儿,与 attachments 现有约定一致)。
 */
import { eq } from 'drizzle-orm'
import type { TiptapJSON } from '@power-wiki/shared'
import { db } from '../db/client'
import { attachments } from '../db/schema'
import { generateAttachmentId } from './ids'
import { copyObject } from './s3'

/** 事务执行器类型 —— db.transaction 回调拿到的 tx。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** 旧 attachment id → 新 attachment id。 */
export type AttachmentIdMap = Map<string, string>

/**
 * storageKey 形如 `{pageId}/{attId}{ext}`。从 key 尾段(文件名)里剥出扩展名
 * (含前导点,如 `.png`);拿不到就返回空串。用旧 key 的 ext 而不是 mime 反查,
 * 保证与原对象一致。
 */
function extFromStorageKey(storageKey: string, attId: string): string {
  const file = storageKey.split('/').pop() ?? ''
  return file.startsWith(attId) ? file.slice(attId.length) : ''
}

/**
 * 复制 `sourcePageId` 的所有附件到 `newPageId`:服务端 S3 拷贝 + 插新行。
 * 返回 旧id→新id 映射,供 rewriteAttachmentRefs 改写内容引用。附件为空时返回空 Map。
 */
export async function copyPageAttachments(
  tx: Tx,
  sourcePageId: string,
  newPageId: string,
  uploaderId: string,
  now: number,
): Promise<AttachmentIdMap> {
  const rows = await tx
    .select()
    .from(attachments)
    .where(eq(attachments.pageId, sourcePageId))

  const idMap: AttachmentIdMap = new Map()
  for (const row of rows) {
    const newAttId = generateAttachmentId()
    const ext = extFromStorageKey(row.storageKey, row.id)
    const newKey = `${newPageId}/${newAttId}${ext}`
    await copyObject(row.storageKey, newKey)
    await tx.insert(attachments).values({
      id: newAttId,
      pageId: newPageId,
      uploaderId,
      originalFilename: row.originalFilename,
      storageKey: newKey,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind,
      createdAt: now,
    })
    idMap.set(row.id, newAttId)
  }
  return idMap
}

/** 深克隆 + 改写:imageAttachment 节点的 attrs.id 命中 map 就换成新 id。 */
function remapJsonNode(value: unknown, idMap: AttachmentIdMap): unknown {
  if (Array.isArray(value)) return value.map((v) => remapJsonNode(v, idMap))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = remapJsonNode(v, idMap)
    }
    if (out.type === 'imageAttachment' && out.attrs && typeof out.attrs === 'object') {
      const attrs = out.attrs as Record<string, unknown>
      if (typeof attrs.id === 'string' && idMap.has(attrs.id)) {
        attrs.id = idMap.get(attrs.id)
      }
    }
    return out
  }
  return value
}

/**
 * 把 content(Tiptap JSON + HTML)里对旧附件的引用改写成新附件 id。
 *   - JSON:imageAttachment 节点的 attrs.id
 *   - HTML:`data-attachment-id="{old}"` 和 `/api/attachments/{old}/raw`
 * idMap 为空时原样返回(零改动)。
 */
export function rewriteAttachmentRefs(
  contentJson: TiptapJSON,
  contentHtml: string,
  idMap: AttachmentIdMap,
): { contentJson: TiptapJSON; contentHtml: string } {
  if (idMap.size === 0) return { contentJson, contentHtml }

  const json = remapJsonNode(contentJson, idMap) as TiptapJSON

  let html = contentHtml
  for (const [oldId, newId] of idMap) {
    html = html
      .split(`data-attachment-id="${oldId}"`)
      .join(`data-attachment-id="${newId}"`)
      .split(`/api/attachments/${oldId}/raw`)
      .join(`/api/attachments/${newId}/raw`)
  }

  return { contentJson: json, contentHtml: html }
}
