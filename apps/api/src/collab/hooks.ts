/**
 * Hocuspocus 钩子 —— 鉴权 + Y.Doc 加载/持久化 + awareness 上下文。
 *
 * Phase 1 范围(read-only awareness):
 *   - onAuthenticate:解析 pw_session cookie → users.id,注入 context.user。
 *     Phase 2 会在此处加 canEditPage 二次校验(只读 viewer 不能上 Y.Doc),
 *     Phase 1 awareness-only 暂不卡(canRead 即可连)。
 *   - onLoadDocument:从 page_yjs_state 拉 bytea → Y.applyUpdate。无 state
 *     行 = 新页 / 旧 pages 落过 page_versions 但没走 Yjs 路径,
 *     Phase 1 留空 Y.Doc,Phase 2 再做 pages.contentJson → prosemirror
 *     JSON → Y.Doc 冷启动 hydration。
 *   - onStoreDocument:Hocuspocus 自带 2.5s debounce(见 server.ts 配置)
 *     合并 burst,本钩子只需把 Y.encodeStateAsUpdate(doc) UPSERT 进
 *     page_yjs_state + mirror Y.Doc → pages.contentJson/contentHtml。
 *   - onDisconnect / onAwarenessUpdate:仅日志,Phase 2 / 4 加业务埋点。
 *
 * 关键约束(沿用项目硬约束):
 *   - Drizzle schema 不许外键 — pages DELETE 时由 route 显式 sweep 本表。
 *   - 鉴权 cookie 失效 / disabled 用户一律 onAuthenticate throw 401。
 *   - 错误不抛 HTTP status,Hocuspocus 自己 emit close code(reject)。
 */
import type {
  onAuthenticatePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
  onAwarenessUpdatePayload,
  onDisconnectPayload,
  beforeUnloadDocumentPayload,
} from '@hocuspocus/server'
import { eq, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import type { User } from '@power-wiki/shared'
import { db } from '../db/client'
import { pageYjsState, pages } from '../db/schema'
import { resolveSessionFromCookieHeader, type AuthenticatedUser } from '../auth/session'
import { canReadPage, principalFromUser } from '../lib/permissions'

/**
 * Hocuspocus 的 connection-level context。
 *
 *   - user   : 解析 cookie 拿到的当前用户(全字段,UI awareness 用得到
 *              name / color / avatarKind / avatarRef)。
 *   - canWrite : Phase 2 接 Yjs body 后用,Phase 1 全 true(awareness only)。
 *   - pageId  : Y.Doc 名 = pageId,onLoadDocument / onStoreDocument 里从
 *              payload.documentName 拿。
 */
export interface CollabContext {
  user: User
  canWrite: boolean
  pageId: string
}

function authenticatedUserToUser(auth: AuthenticatedUser): User {
  return {
    id: auth.id,
    email: auth.email,
    name: auth.name,
    role: auth.role,
    status: auth.status,
    color: auth.color,
    avatarKind: auth.avatarKind,
    avatarRef: auth.avatarRef,
    createdAt: auth.createdAt,
    updatedAt: auth.updatedAt,
    lastLoginAt: auth.lastLoginAt,
  }
}

/**
 * Hocuspocus `name`(即 documentName)必须是 pageId(nanoid 10),否则拒。
 *
 * 把校验提前到 onAuthenticate —— 防有人乱连 `/api/collab?document=<anything>`
 * 消耗 server 资源。nanoid 字母表共 31 字符,正则严格匹配。
 */
const PAGE_ID_RE = /^[0-9a-z]{10}$/

export async function onAuthenticate(payload: onAuthenticatePayload): Promise<CollabContext> {
  const pageId = payload.documentName
  if (!PAGE_ID_RE.test(pageId)) {
    throw new Error('invalid_document_name')
  }

  const cookieHeader = payload.requestHeaders.get('cookie')
  const auth = await resolveSessionFromCookieHeader(cookieHeader)
  if (!auth) {
    throw new Error('unauthorized')
  }

  const me = principalFromUser(auth)

  // 拿 page 拿 spaceId —— trashed page / 软删页 / 不存在页 一律 404 关连接。
  const row = await db
    .select({ spaceId: pages.spaceId, deletedAt: pages.deletedAt })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  const page = row[0]
  if (!page || page.deletedAt !== null || !page.spaceId) {
    throw new Error('page_not_found')
  }

  const ok = await canReadPage(me, pageId, page.spaceId)
  if (!ok) {
    throw new Error('forbidden')
  }

  return {
    user: authenticatedUserToUser(auth),
    canWrite: true, // Phase 1 不卡,Phase 2 改成 effectivePageEditAccess
    pageId,
  }
}

/**
 * 加载 Y.Doc 状态:从 page_yjs_state 拉 bytea → Y.applyUpdate。
 *
 * 三段优先级:
 *   1. page_yjs_state 有 row → 直接反序列化(Hocuspocus 自动 apply)
 *   2. page_yjs_state 无 row + pages.contentJson 非空 → 冷启动 hydration:
 *      用 prosemirrorJSONToYDoc 把 Tiptap JSON 灌进 payload.document
 *      (走 mutate 路径,跳过 Hocuspocus 默认 apply,让 y-prosemirror 写 CRDT)
 *   3. 都没有 → Y.Doc 留空(全新 page / 还没 hydrate 的边界)
 *
 * 冷启动不立刻回写 page_yjs_state —— Hocuspocus 自带的 2.5s debounce 在
 * client 首次编辑后触发 onStoreDocument 自然落库,本路径只读不写,
 * 避免 idle page 凭空多一条 bytea 行。
 *
 * 注:onLoadDocument 返回值 = Uint8Array state —— Hocuspocus 会自动 apply
 * 到 Y.Doc 再 invoke 后续 hooks;也可直接 mutate payload.document 跳过 apply。
 * 这里走 mutate 路径,跟 Hocuspocus 默认行为 1:1,且允许 Phase 2 注入 fallback。
 */
export async function onLoadDocument(payload: onLoadDocumentPayload): Promise<Uint8Array | undefined> {
  const { documentName, document } = payload
  const rows = await db
    .select({ state: pageYjsState.state })
    .from(pageYjsState)
    .where(eq(pageYjsState.pageId, documentName))
    .limit(1)
  const row = rows[0]
  if (row) return row.state

  // 冷启动 hydration:从 pages.contentJson 把 Tiptap JSON 重建到 Y.Doc
  const pageRows = await db
    .select({ contentJson: pages.contentJson })
    .from(pages)
    .where(eq(pages.id, documentName))
    .limit(1)
  const pageRow = pageRows[0]
  if (!pageRow?.contentJson) return undefined

  try {
    // dynamic import 避免 cycle + 让 linkedom 缺依赖时不阻塞 hydration 路径
    const { hydrateYDocFromContentJson } = await import('./hydration')
    hydrateYDocFromContentJson(document, pageRow.contentJson)
    if (process.env['LOG_COLLAB'] === '1') {
      console.log(`[collab] hydrated ${documentName} from pages.contentJson`)
    }
  } catch (err) {
    // hydration 失败 → Y.Doc 留空,client 第一次编辑走空 doc 路径,
    // 由后续 server store 自动补回 state。Phase 1 awareness-only 阶段
    // 这里不跑;Phase 2 schema drift 临时降级,日志可观察。
    console.warn(`[collab] hydrate failed for ${documentName}:`, err)
  }
  return undefined
}

/**
 * 持久化 Y.Doc 字节 + mirror contentJson —— 抽出来给 onStoreDocument
 * (debounce 2.5s 路径) 和 onBeforeUnloadDocument(立即 flush 路径) 共用。
 *
 * 两件事:
 *   1. UPSERT 进 page_yjs_state(Y.Doc 字节)
 *   2. mirror Y.Doc → pages.contentJson + contentHtml(双源事实切分)
 *
 * M13+: page 已被软删 / 硬删时(pages.deletedAt IS NOT NULL 或 page
 * 物理行不存在),client 端仍可能因为 onAuthenticate 时 page 还活着、
 * onStoreDocument fire 时 page 已死 (B 调 DELETE 中间件夹住)。这里
 * 跳过全部持久化 + 主动 destroy server 端持有的 Y.Doc,让 Hocuspocus
 * 自然 GC。否则会留下「client 在写已删页面」的悬挂 page_yjs_state 行
 * + server Y.Doc 内存长时间持有。
 *
 * 事务:
 *   - 不强制包事务 —— Hocuspocus 串行触发(一个 page 一个 connection),
 *     真要 paranoid 用 db.transaction 包即可。
 *   - mirror 失败不能让 caller throw(Hocuspocus 会 close 客户端连接
 *     反复 reconnect)。失败时 log + 跳过 UPDATE contentJson 字段,
 *     page_yjs_state 仍正常持久化(Yjs 协同主流程不受影响)。
 *
 * 字节大小冗余写 byte_size 方便运维 grep 大文档告警;不上 CHECK 允许 0。
 */
async function persistYDoc(documentName: string, document: Y.Doc): Promise<void> {
  // Zombie 守卫 —— 已删 page 的 persist 一律跳过 + destroy server Y.Doc
  // 让 Hocuspocus 自然 GC。lock 闸门保证一般不会进到这里(锁存在时
  // DELETE 直接 409),但中间件缝隙 + page_locks 5min TTL 自然过期后
  // 重试 DELETE + client 仍连着 Hocuspocus 的窗口仍存在。
  const pageRows = await db
    .select({ deletedAt: pages.deletedAt })
    .from(pages)
    .where(eq(pages.id, documentName))
    .limit(1)
  const pageRow = pageRows[0]
  if (!pageRow || pageRow.deletedAt !== null) {
    if (process.env['LOG_COLLAB'] === '1') {
      console.log(`[collab] persist skip ${documentName}: page deleted or gone`)
    }
    try {
      const { getCollabHocuspocus } = await import('./server')
      const hp = getCollabHocuspocus()
      hp?.documents.get(documentName)?.destroy()
    } catch {
      // evict 失败只是占内存,不影响 caller
    }
    return
  }

  const state = Y.encodeStateAsUpdate(document)
  const byteSize = state.byteLength
  const now = Date.now()

  await db.execute(sql`
    INSERT INTO page_yjs_state (page_id, state, byte_size, updated_at)
    VALUES (${documentName}, ${state}, ${byteSize}, ${now})
    ON CONFLICT (page_id) DO UPDATE
      SET state = EXCLUDED.state,
          byte_size = EXCLUDED.byte_size,
          updated_at = EXCLUDED.updated_at
  `)

  try {
    const { mirrorYDocToPageContent } = await import('./prosemirrorHtml')
    const mirrored = await mirrorYDocToPageContent(document)
    // mirror 出的 JSON 跟 pages.contentJson($type<TiptapJSON>)在 schema 层面等价;
    // 类型上 Drizzle pgTable.jsonb() 的 $type 是软断言 —— 直接 cast 跨过去。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db
      .update(pages)
      .set({
        contentJson: mirrored.contentJSON as any,
        contentHtml: mirrored.contentHTML,
        updatedAt: now,
      })
      .where(eq(pages.id, documentName))
  } catch (err) {
    console.warn(`[collab] mirror failed for ${documentName}:`, err)
  }
}

/**
 * Hocuspocus 自带 2.5s debounce 触发的 store —— 见 server.ts 配置。
 * 合并 burst 写,降低 page_yjs_state 写频。
 */
export async function onStoreDocument(payload: onStoreDocumentPayload): Promise<void> {
  await persistYDoc(payload.documentName, payload.document)
}

/**
 * 最后一次 client 断开时立即 flush —— 绕过 2.5s debounce。
 *
 * 为什么需要:
 *   shared 模式下 body 完全走 Yjs,client 端没有 PATCH 备份。如果 user
 *   敲完字立刻关 EditView(在 2.5s debounce 窗口内),Hocuspocus 默认行
 *   为是 schedule 一个 timer 然后 unload — 但 timer fire 时 ReadView 已
 *   经 fetch 过了,看到的是旧 pages.contentJson。修法是在 unload 之前
 *   同步走一遍 persistYDoc,保证 pages.contentJson 在 client 断开之前
 *   就被更新,ReadView 后续路由跳到同页时拿得到。
 *
 * 触发时机:
 *   - 用户关闭 EditView → client WS 断开 → Hocuspocus 检测到 document
 *     连接数归零 → 触发 beforeUnloadDocument → 同步 persist。
 *   - 用户没断但页面静默 → 走 onStoreDocument (debounce 2.5s),不变。
 *
 * 不在 personal mode 触发(personal 不连 Hocuspocus,走 BroadcastChannel)。
 */
export async function onBeforeUnloadDocument(
  payload: beforeUnloadDocumentPayload,
): Promise<void> {
  await persistYDoc(payload.documentName, payload.document)
}

/**
 * Awareness 状态更新 —— Phase 1 只打日志,Phase 2 接进埋点/分析。
 *
 * 避免高频日志(awareness 每 ~30s 心跳),production 应关掉。
 */
export async function onAwarenessUpdate(payload: onAwarenessUpdatePayload): Promise<void> {
  if (process.env['LOG_COLLAB'] === '1') {
    console.log(
      `[collab] awareness update document=${payload.documentName} ` +
        `states=${payload.states.length}`,
    )
  }
}

/** 客户端断开 —— Phase 1 只打日志,Phase 4 lock 接管要在这里 fire stateless。 */
export async function onDisconnect(payload: onDisconnectPayload): Promise<void> {
  if (process.env['LOG_COLLAB'] === '1') {
    console.log(
      `[collab] disconnect document=${payload.documentName} ` +
        `context=${payload.context ? 'authed' : 'anon'}`,
    )
  }
}
