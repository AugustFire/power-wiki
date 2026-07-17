/**
 * useUserAvatarUpload — M11 自定义头像上传编排。
 *
 * 三步(同附件 uploads):
 *   1. pickAndProcess(file) 客户端 canvas resize → Blob(长边 ≤ 256,
 *      体积 ≤ AVATAR_TARGET_BYTES,空白底填白)
 *   2. upload(blob, mime, w, h) → 拿 presigned PUT → PUT 到 MinIO(字节不
 *      经过 API)→ finalize 写 user_avatars 行
 *   3. commit(avatarId) — 客户态机切到 { kind: 'custom', ref: avatarId }
 *
 * 错误分类(同 uploadAndInsert.ts 的 UploadError):
 *   - size_exceeded: 压图后仍 > AVATAR_UPLOAD_MAX_BYTES(5MB)
 *   - mime_not_allowed: 不在 AVATAR_ALLOWED_MIME 白名单
 *   - canvas_failed: 浏览器 canvas 不可用 / FileReader 拒绝
 *   - network_error: XHR onerror / ontimeout
 *   - server_unavailable: 5xx(MinIO 不可达)
 *   - upload_failed: 其它 4xx
 *   - size_mismatch / mime_mismatch: finalize 阶段服务端 HeadObject 与
 *     客户端 sizeBytes 不一致 → 通常是签名过期后用户重新上传
 *
 * 调用方只需:
 *   const u = useUserAvatarUpload()
 *   const id = await u.pickAndCommit(file)   // 一条龙
 *   // 或分开调用拿到 progress 中间状态
 *
 * pickAndCommit 是常用入口;upload / commit 单步暴露供 SettingsDrawer
 * 「重新上传」按钮 / 「撤回上传」控件复用。
 */
import { ref, type Ref } from 'vue'
import {
  AVATAR_ALLOWED_MIME,
  AVATAR_TARGET_BYTES,
  AVATAR_TARGET_DIM,
  AVATAR_UPLOAD_MAX_BYTES,
  type AvatarAllowedMime,
} from '@power-wiki/shared'
import { api } from '../lib/api'

export type UploadErrorKind =
  | 'size_exceeded'
  | 'mime_not_allowed'
  | 'canvas_failed'
  | 'network_error'
  | 'server_unavailable'
  | 'upload_failed'
  | 'size_mismatch'
  | 'mime_mismatch'
  | 'finalize_failed'

export class UserAvatarUploadError extends Error {
  constructor(
    readonly kind: UploadErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'UserAvatarUploadError'
  }
}
function mkErr(kind: UploadErrorKind, detail?: string): UserAvatarUploadError {
  return new UserAvatarUploadError(
    kind,
    `${kind}${detail ? `: ${detail}` : ''}`,
    detail,
  )
}

const ALLOWED_MIME_SET = new Set<string>(AVATAR_ALLOWED_MIME)

function isAllowedMime(mime: string): mime is AvatarAllowedMime {
  return ALLOWED_MIME_SET.has(mime)
}

export type ProgressState =
  | { phase: 'idle' }
  | { phase: 'compressing' }
  | { phase: 'uploading'; loaded: number; total: number }
  | { phase: 'finalizing' }

export function useUserAvatarUpload(): {
  progress: Ref<ProgressState>
  error: Ref<UserAvatarUploadError | null>
  abort: () => void
  /** 一条龙:压图 → PUT → finalize。返 user_avatars.id */
  pickAndCommit: (file: File) => Promise<string>
  /** 单步:上传已处理好的 Blob */
  upload: (
    blob: Blob,
    mime: AvatarAllowedMime,
    width: number,
    height: number,
  ) => Promise<{ avatarId: string; bucketKey: string }>
  /** 终止当前上传(XHR + 取消 controller) */
  reset: () => void
} {
  const progress = ref<ProgressState>({ phase: 'idle' })
  const error = ref<UserAvatarUploadError | null>(null)
  let xhr: XMLHttpRequest | null = null

  function reset(): void {
    if (xhr) {
      try {
        xhr.abort()
      } catch {
        /* XHR 已经 end 了 */
      }
      xhr = null
    }
    progress.value = { phase: 'idle' }
    error.value = null
  }

  function abort(): void {
    reset()
  }

  /** 全流程便捷入口。 */
  async function pickAndCommit(file: File): Promise<string> {
    reset()
    // MIME 白名单
    if (!file.type || !isAllowedMime(file.type)) {
      error.value = mkErr('mime_not_allowed', file.type || '未知类型')
      throw error.value
    }

    // 客户端先粗筛 > 5MB,免得跑完压图才发现不能上传
    // (5MB 是后端 hard limit;前端粗筛只拦截明显过大的图)
    if (file.size > AVATAR_UPLOAD_MAX_BYTES) {
      error.value = mkErr(
        'size_exceeded',
        `${file.size} > ${AVATAR_UPLOAD_MAX_BYTES}`,
      )
      throw error.value
    }

    // 1) 压图
    progress.value = { phase: 'compressing' }
    let processed: { blob: Blob; mime: AvatarAllowedMime; width: number; height: number }
    try {
      processed = await processImage(file)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      error.value = mkErr('canvas_failed', detail)
      throw error.value
    }
    if (processed.blob.size > AVATAR_UPLOAD_MAX_BYTES) {
      error.value = mkErr(
        'size_exceeded',
        `压缩后 ${processed.blob.size} > ${AVATAR_UPLOAD_MAX_BYTES}`,
      )
      throw error.value
    }

    // 2) 上传 + finalize
    const { avatarId } = await upload(
      processed.blob,
      processed.mime,
      processed.width,
      processed.height,
    )
    return avatarId
  }

  /**
   * 客户端 canvas 压图:长边 ≤ AVATAR_TARGET_DIM(256),保持 aspect,
   * PNG 默认无损,JPEG/WEBP quality 0.85,透明背景填白(同 Confluence 默认)。
   * 输出 MIME 自适配:PASS 1 输出原格式;若压缩后仍 > AVATAR_TARGET_BYTES
   * 且是 PNG,降级 JPEG 重试一次。
   */
  async function processImage(
    file: File,
  ): Promise<{ blob: Blob; mime: AvatarAllowedMime; width: number; height: number }> {
    const bitmap = await fileToBitmap(file)
    const maxDim = AVATAR_TARGET_DIM
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > maxDim ? maxDim / longest : 1
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context 不可用')
    // 透明 → 填白,避免 JPEG 序列化后变黑
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)

    // PASS 1: 保持原格式
    const primary: AvatarAllowedMime = (
      file.type === 'image/jpeg' || file.type === 'image/webp'
        ? file.type
        : 'image/png'
    ) as AvatarAllowedMime
    const quality = primary === 'image/png' ? undefined : 0.85
    const pass1 = await canvasToBlob(canvas, primary, quality)
    if (primary !== 'image/png' || pass1.size <= AVATAR_TARGET_BYTES) {
      return { blob: pass1, mime: primary, width: w, height: h }
    }

    // PASS 2 (仅 PNG 太大时):降级 JPEG
    const pass2 = await canvasToBlob(canvas, 'image/jpeg', 0.85)
    if (pass2.size <= AVATAR_TARGET_BYTES) {
      return { blob: pass2, mime: 'image/jpeg', width: w, height: h }
    }
    // 仍超 target —— 仍尝试硬传(后端 hard limit 是 5MB,不是 200KB;
    // AVATAR_TARGET_BYTES 是软目标,client 不应越界拒)
    return { blob: pass2, mime: 'image/jpeg', width: w, height: h }
  }

  function fileToBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
    return new Promise((resolve, reject) => {
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(file)
          .then((b) => resolve(b))
          .catch((e) => reject(new Error(`createImageBitmap failed: ${e}`)))
        return
      }
      // Fallback: <img> + FileReader
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('FileReader 失败'))
      reader.onload = () => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('Image 加载失败'))
        img.src = reader.result as string
      }
      reader.readAsDataURL(file)
    })
  }

  function canvasToBlob(
    canvas: HTMLCanvasElement,
    mime: AvatarAllowedMime,
    quality?: number,
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error(`canvas.toBlob(${mime}) 返回 null`))
            return
          }
          resolve(blob)
        },
        mime,
        quality,
      )
    })
  }

  /**
   * Upload + finalize。返 avatarId(给 SettingsDrawer 写 PATCH /me 用)。
   * 注意:不写 users.avatarKind——那是 /me 端点的事,这里只负责「对象已落 S3 + 行已建」。
   */
  async function upload(
    blob: Blob,
    mime: AvatarAllowedMime,
    width: number,
    height: number,
  ): Promise<{ avatarId: string; bucketKey: string }> {
    const sizeBytes = blob.size

    // 1. 拿 presigned PUT
    const { uploadUrl, bucketKey, avatarId } =
      await api.users.me.requestAvatarUpload({
        mime,
        sizeBytes,
      })

    // 2. PUT 到 MinIO(XHR 为了 progress)
    progress.value = { phase: 'uploading', loaded: 0, total: sizeBytes }
    await new Promise<void>((resolve, reject) => {
      const req = new XMLHttpRequest()
      xhr = req
      req.open('PUT', uploadUrl, true)
      req.setRequestHeader('Content-Type', mime)
      req.upload.onprogress = (e) => {
        const loaded = e.loaded
        const total = e.total || sizeBytes
        progress.value = { phase: 'uploading', loaded, total }
      }
      req.onerror = () => reject(mkErr('network_error', 'xhr.onerror'))
      req.ontimeout = () => reject(mkErr('network_error', 'timeout'))
      req.onload = () => {
        const status = req.status
        if (status >= 200 && status < 300) {
          progress.value = { phase: 'uploading', loaded: sizeBytes, total: sizeBytes }
          resolve()
          return
        }
        if (status === 502 || status === 503 || status === 504) {
          reject(mkErr('server_unavailable', String(status)))
        } else {
          reject(mkErr('upload_failed', String(status)))
        }
      }
      req.send(blob)
    })
    xhr = null

    // 3. finalize
    progress.value = { phase: 'finalizing' }
    let r: Awaited<ReturnType<typeof api.users.me.finalizeAvatar>>
    try {
      r = await api.users.me.finalizeAvatar({
        avatarId,
        bucketKey,
        mime,
        sizeBytes,
        width,
        height,
      })
    } catch (err) {
      // finalize 失败 headObject 找不到 / size mismatch / mime mismatch
      // 由 ApiError.code 透传,精确分类
      const apiErr = err as { code?: string; message?: string }
      const code = apiErr?.code
      if (code === 'size_mismatch') throw mkErr('size_mismatch', apiErr?.message)
      if (code === 'mime_mismatch') throw mkErr('mime_mismatch', apiErr?.message)
      if (code === 'upload_not_found') throw mkErr('finalize_failed', '对象未上传到 S3')
      throw mkErr('finalize_failed', apiErr?.message ?? '未知错误')
    }
    progress.value = { phase: 'idle' }
    return { avatarId: r.avatarId, bucketKey: r.bucketKey }
  }

  return {
    progress,
    error,
    abort,
    pickAndCommit,
    upload,
    reset,
  }
}
