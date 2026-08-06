/**
 * Hocuspocus server 启动 + 销毁。
 *
 * Phase 1:独立端口 8788,与 Hono 主服务(8787)同进程运行。两端口通过 vite
 * proxy 分别转发 —— `/api` → 8787(HTTP)、`/api/collab` → 8788(WS)。
 *
 * 为什么不上 in-process upgrade(把 Hocuspocus.handleConnection 挂到同一个
 * HTTP server 的 upgrade 事件):
 *   - Hono 的 @hono/node-server 暴露的 serve() 跟 Hocuspocus 各自的 ws 库
 *     版本要求不一定对齐;拆端口后两边各自管 lifecycle,出问题时日志清晰。
 *   - Vite proxy 的 ws:true 配置一行就解决跨端口转发,跟 dev / prod 一致。
 *   - cookie 鉴权 / CORS / 升级头都不用手动 set,WS 协议层透明。
 *
 * 启动时序(在 apps/api/src/index.ts main() 里):
 *   1. migrate (Drizzle 应用 0035_collab.sql)
 *   2. runBootstrap
 *   3. 启动 Hono serve(8787)
 *   4. await startCollabServer() —— 独立端口 8788
 *
 * destroy() 给 graceful shutdown 用(SIGTERM / Ctrl+C);Phase 1 测试脚本不
 * 触发,但保证 prod 部署不漏 conn close。
 */
import { Server } from '@hocuspocus/server'
import type { Hocuspocus } from '@hocuspocus/server'
import {
  onAuthenticate,
  onAwarenessUpdate,
  onBeforeUnloadDocument,
  onDisconnect,
  onLoadDocument,
  onStoreDocument,
} from './hooks'

const DEFAULT_COLLAB_PORT = 8788

/**
 * 全局 Hocuspocus 单例引用 —— 给 server.ts 之外的路由层共享用(Phase 4:
 * pageLocks.takeover 通过 stateless broadcast 通知原 holder)。
 *
 * 设计上 `Server` 是 Hocuspocus 的包装层,真正持有 documents / debouncer /
 * connectionManager 的是 `server.hocuspocus`。为了让 pageLocks.route 这种
 * HTTP 路由层能调用 `broadcastStateless`,把 hocuspocus 实例缓存成 module-level
 * singleton —— startCollabServer() 启动时写入,destroy() 时清空。
 *
 * 进程内单例够用:同进程只会有一个 Hocuspocus 实例(见 server.ts 注释「同进程
 * 挂在 Hono」)。多 worker 部署时会变成 per-worker 独立 singleton —— 接受这
 * 个限制,后续如果拆 sibling 进程再换成 IPC。
 */
let hocuspocusInstance: Hocuspocus | null = null

/** Route 层读 Hocuspocus 实例(给 pageLocks / 未来 watcher 等用)。 */
export function getCollabHocuspocus(): Hocuspocus | null {
  return hocuspocusInstance
}

export interface CollabServerHandle {
  port: number
  url: string
  destroy: () => Promise<void>
}

export async function startCollabServer(
  port: number = Number(process.env['COLLAB_PORT'] ?? DEFAULT_COLLAB_PORT),
): Promise<CollabServerHandle> {
  const server = new Server({
    port,
    address: '127.0.0.1',
    quiet: true,
    // Phase 5:debounce 2500ms 合并 burst,前 2s 内多 op 合并成一次
    // onStoreDocument,降低 page_yjs_state 写频;maxDebounce 10s 兜底
    // 防止极低频 edit 一直拖不写。timeout 30s 用 Hocuspocus 默认。
    //
    // 为什么不是更激进的值(比如 5s / 10s):Tiptap 每 keystroke 都
    // 触发 Y.Doc transact,burst 写时(server 端在同一时间窗内收到 N 个
    // op)Hocuspocus 会按 debounce 合并 —— 2500ms 是 burst-merge 的
    // 甜点:既覆盖正常 typing burst(几十 ms 几个 op),又不让 idle
    // page 拖太久不写。maxDebounce 10s 兜底长 burst。
    debounce: 2500,
    maxDebounce: 10000,
    onAuthenticate,
    onLoadDocument,
    onStoreDocument,
    // Phase 5.1 (2026-08-06):最后一个 client 断开时强制 flush,绕过
    // 2.5s debounce,避免共享空间 user 敲完字立刻关闭 EditView 后
    // ReadView 拉到旧 pages.contentJson。Active session 内 burst 写
    // 仍走 debounce 2.5s 合并不变 —— 只在 unload 边界 bypass。
    beforeUnloadDocument: onBeforeUnloadDocument,
    onAwarenessUpdate,
    onDisconnect,
  })

  await server.listen()
  hocuspocusInstance = server.hocuspocus
  const url = server.webSocketURL
  console.log(`[collab] listening on ${url}`)
  return {
    port,
    url,
    destroy: async () => {
      hocuspocusInstance = null
      await server.destroy()
    },
  }
}
