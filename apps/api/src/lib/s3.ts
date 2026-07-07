/**
 * MinIO / S3 client wrapper — 页面附件对象存储。
 *
 * dev + prod 共用一套(MinIO,S3 兼容)。上传走 presigned PUT(浏览器直传,
 * API 不中转字节),下载走 API 流式代理(GetObject → Readable pipe)。
 *
 * 所有配置从 env 读(见 apps/api/.env.example 的 S3_* 段):
 *   - S3_ENDPOINT          容器内 API 用 http://minio:9000;主机 dev 用 127.0.0.1:9000
 *   - S3_REGION            SDK 必填,MinIO 不校验
 *   - S3_BUCKET            默认 power-wiki-attachments
 *   - S3_ACCESS_KEY/SECRET 凭证
 *   - S3_FORCE_PATH_STYLE  MinIO 必须 path-style(!== 'false' → true)
 *   - S3_PRESIGN_EXPIRES_SEC  presign TTL,默认 900s
 *
 * client 单例 memoized(首次调用惰性创建)。
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Readable } from 'node:stream'

let client: S3Client | null = null

export function getS3Client(): S3Client {
  if (client) return client
  client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
    },
  })
  return client
}

const bucket = () => process.env.S3_BUCKET ?? 'power-wiki-attachments'
const ttl = () => Number(process.env.S3_PRESIGN_EXPIRES_SEC ?? 900)

/** presigned PUT URL — 浏览器直接 PUT 文件字节到这个 URL。 */
export async function presignUpload(
  key: string,
  mime: string,
): Promise<{ url: string; expiresAt: number }> {
  const url = await getSignedUrl(
    getS3Client(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: mime }),
    { expiresIn: ttl() },
  )
  return { url, expiresAt: Date.now() + ttl() * 1000 }
}

/** GetObject → Readable body,供 API 流式代理下载。 */
export async function streamDownload(key: string): Promise<{
  body: Readable
  contentType?: string
  contentLength?: number
}> {
  const out = await getS3Client().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
  )
  return {
    body: out.Body as Readable,
    contentType: out.ContentType,
    contentLength:
      typeof out.ContentLength === 'number' ? out.ContentLength : undefined,
  }
}

/** HeadObject — finalize 时校验真实字节数(不信前端上报的 size)。 */
export async function headObject(
  key: string,
): Promise<{ size: number; contentType?: string }> {
  const out = await getS3Client().send(
    new HeadObjectCommand({ Bucket: bucket(), Key: key }),
  )
  return { size: Number(out.ContentLength ?? 0), contentType: out.ContentType }
}

/** 删对象 — page purge / DELETE 时 best-effort 调用。 */
export async function deleteObject(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
  )
}
