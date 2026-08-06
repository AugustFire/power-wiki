/**
 * BroadcastChannelProvider —— 个人空间多 Tab 同步协议。
 *
 * 为什么需要(2026-08-05 Phase 3 落地):
 *   个人空间是单人工作区,不需要 server 协同:多个 Tab 同时打开同一页,
 *   用户的编辑要在 Tab 之间收敛,但不应该占用 server 端 page_yjs_state /
 *   不应该走 Hocuspocus WS。BroadcastChannel 是 browser 原生的同 origin
 *   跨 Tab 消息总线,正好覆盖这个场景。
 *
 * 跟 shared mode 的对比:
 *   - shared:`HocuspocusProvider` → server → other clients,持久化到
 *     `page_yjs_state`,跨设备 / 跨浏览器也能同步。
 *   - personal:`BroadcastChannelProvider` → 同 browser 同 origin 的
 *     other tabs,**不上 server**,刷新后内容从 pages.contentJson 取回
 *     (本地浏览器同 origin 内 closed tab 的 Y.Doc 也丢失,新 tab 走
 *      contentJson 冷启动,见 hydration.ts 的等价路径)。
 *
 * 协议(5 条消息):
 *   - sync_request:{ requesterId }
 *     新 Tab 启动后广播,问「谁有当前 state 给一份」,所有在场 Tab 必须响应。
 *   - sync_response:{ requesterId, state: Uint8Array }
 *     老 Tab 收到 sync_request 后回包,state = Y.encodeStateAsUpdate(self.ydoc)。
 *     requesterId 用来定向:只给新人送,避免新人误 apply 到自己(虽然 idempotent,
 *     但跨 tab 多次 apply 浪费 CPU)。
 *   - update:{ originTabId, update: Uint8Array }
 *     CRDT op 增量。origin 是 TabId 而不是 provider 实例,因为不同 Tab 共享同一
 *     document name,BroadcastChannel 跨进程;用 TabId 区分本地发出的 op。
 *   - awareness:{ originTabId, update: Uint8Array }
 *     awareness 增量,使用 y-protocols 的 encodeAwarenessUpdate 序列化。
 *     不发送完整 awareness state(大、频繁);只发变更的 clientID 列表对应的
 *     encodeAwarenessUpdate 字节。
 *
 * 锁(Phase 4 再加):本期只占位,协议里不携带 lock 消息,UI 端的 lock 镜像
 * 走 server route(参见 `apps/api/src/routes/pageLocks.ts` 占位)。
 *
 * 边界 case:
 *   - Tab A 打开、敲字「AAA」、再开 Tab B:Tab B 收到 sync_request,A 回复
 *     sync_response(state 含「AAA」),B apply → B 编辑器显示「AAA」。Yjs
 *     CRDT 自然 merge,B 后续敲字「BBB」会通过 update 消息传到 A。
 *   - Tab A 是唯一 tab,敲字后关闭:无 sync_request 来源,内容只留在 A 的
 *     Y.Doc 里。关闭瞬间 pages.contentJson 不会被写回(server 不参与)——
 *     这是 Phase 3 的限制,跟 Phase 2 不同(shared 走 server mirror 兜底)。
 *     后续在 server 上加一个 debounced REST「personal doc snapshot」是
 *     Phase 5 的收尾项,本期不做。
 *   - 不同 user 在不同 browser 同 origin 打开同 pageId:pageId 唯一(per space),
 *     channel name 用 pageId 后缀,理论上跨 user 也会串。**当前不防御**:
 *     personal space URL 路由层已经把 user 隔离,server 端 page 读也 403,
 *     BroadcastChannel 层跨用户串了也只是本地一致性 bug,不会越权。
 *
 * 关键约束:
 *   - 不引 Yjs / y-protocols 之外的依赖。
 *   - channel name 必须稳定(以 pageId 命名),否则同一页多 tab 收不到彼此。
 *   - destroy() 必须 close channel + destroy doc + destroy awareness,否则
 *     tab 关闭前留的 listener 会泄漏(虽然 GC 会兜,但同一页反复开关 tab
 *     会留垃圾 listener,debug 时诡异)。
 */
import * as Y from 'yjs'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'

const CHANNEL_PREFIX = 'power-wiki-collab'

/** BroadcastChannel 协议消息类型。 */
type BCMessage =
  | { type: 'sync_request'; tabId: string }
  | { type: 'sync_response'; requesterId: string; tabId: string; state: Uint8Array }
  | { type: 'update'; tabId: string; update: Uint8Array }
  | { type: 'awareness'; tabId: string; update: Uint8Array }

export interface BroadcastChannelProviderOptions {
  pageId: string
  user: { id: string; name: string; color: string; avatarKind?: string | null; avatarRef?: string | null }
}

export class BroadcastChannelProvider {
  readonly ydoc: Y.Doc
  readonly awareness: Awareness

  private readonly channel: BroadcastChannel
  private readonly tabId: string
  private destroyed = false
  /** Y.Doc 'update' handler 持有,用来在 destroy() 时 off()。 */
  private readonly docUpdateHandler: (update: Uint8Array, origin: unknown) => void
  private readonly awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void
  private readonly channelMessageHandler: (event: MessageEvent<BCMessage>) => void

  constructor(opts: BroadcastChannelProviderOptions) {
    this.tabId = newTabId()
    this.ydoc = new Y.Doc()
    this.awareness = new Awareness(this.ydoc)

    const channelName = `${CHANNEL_PREFIX}:${opts.pageId}`
    this.channel = new BroadcastChannel(channelName)

    // Set local awareness。Phase 1+2 shared 模式由 HocuspocusProvider.onAuthenticated
    // 写,这里 Phase 3 没 server 鉴权,直接构造时写一份。
    this.awareness.setLocalStateField('user', {
      id: opts.user.id,
      name: opts.user.name,
      color: opts.user.color,
      avatarKind: opts.user.avatarKind ?? null,
      avatarRef: opts.user.avatarRef ?? null,
      mode: 'view',
    })

    // === 自身作为 origin 的标识 ===
    // 传给 Y.applyUpdate / awarenessProtocol.applyAwarenessUpdate,update 事件
    // 回调里通过 `origin === this` 判自己,这样不会把自己 apply 的 update 又
    // 广播回去(BroadcastChannel 是跨进程的,自己 postMessage 后自己 onmessage
    // 不会触发,但 Y.Doc 'update' 事件会在 apply 时触发,我们要拦)。
    const selfOrigin = this

    // Y.Doc 'update' → 广播增量
    this.docUpdateHandler = (update, origin) => {
      if (origin === selfOrigin) return
      if (this.destroyed) return
      this.postMessage({ type: 'update', tabId: this.tabId, update })
    }
    this.ydoc.on('update', this.docUpdateHandler)

    // Awareness 'update' → 广播增量
    this.awarenessUpdateHandler = (changes, origin) => {
      if (origin === selfOrigin) return
      if (this.destroyed) return
      const changed = [...changes.added, ...changes.updated, ...changes.removed]
      if (changed.length === 0) return
      const update = encodeAwarenessUpdate(this.awareness, changed)
      this.postMessage({ type: 'awareness', tabId: this.tabId, update })
    }
    this.awareness.on('update', this.awarenessUpdateHandler)

    // Channel 收消息
    this.channelMessageHandler = (event) => this.handleMessage(event.data)
    this.channel.onmessage = this.channelMessageHandler

    // 启动时问其他 Tab 要 state —— 即使是第一个 Tab 也发,sync_request 没
    // 响应等价于「我是第一个」。后续有 Tab 加入时,本 Tab 会收到 sync_request
    // 并回包,新人拿到 state。
    this.postMessage({ type: 'sync_request', tabId: this.tabId })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    // 把自己从 awareness 里摘掉,触发远端 awareness 'update' 收到 remove,
    // 它们的 byline 头像组 / cursor 装饰跟着消失。
    try {
      removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'destroy')
    } catch {
      /* awareness destroyed concurrently — ignore */
    }

    this.ydoc.off('update', this.docUpdateHandler)
    this.awareness.off('update', this.awarenessUpdateHandler)
    this.channel.onmessage = null
    this.channel.close()

    this.ydoc.destroy()
    this.awareness.destroy()
  }

  private postMessage(msg: BCMessage): void {
    if (this.destroyed) return
    try {
      this.channel.postMessage(msg)
    } catch (err) {
      // BroadcastChannel 在某些浏览器对 closed channel 会 throw,吃一下。
      // 真正想看就 uncomment: console.warn('[bc-collab] postMessage failed', err)
      void err
    }
  }

  private handleMessage(msg: BCMessage): void {
    if (this.destroyed) return
    if (msg.tabId === this.tabId) return // 自己的消息(理论上不会到,但防御)

    switch (msg.type) {
      case 'sync_request': {
        // 有人要 state —— 回包 sync_response(state),定向给请求方
        const state = Y.encodeStateAsUpdate(this.ydoc)
        this.postMessage({
          type: 'sync_response',
          requesterId: msg.tabId,
          tabId: this.tabId,
          state,
        })
        // 同时推自己的 awareness state,新人 apply 后能立刻看到 presence
        if (this.awareness.getStates().size > 0) {
          const allClients = Array.from(this.awareness.getStates().keys())
          const update = encodeAwarenessUpdate(this.awareness, allClients)
          this.postMessage({ type: 'awareness', tabId: this.tabId, update })
        }
        return
      }
      case 'sync_response': {
        // 我是新 Tab;老 Tab 回包 state。只 apply 定向给我的包(避免「所有人都 apply 一次」造成双重写入)。
        if (msg.requesterId !== this.tabId) return
        Y.applyUpdate(this.ydoc, msg.state, this)
        return
      }
      case 'update': {
        Y.applyUpdate(this.ydoc, msg.update, this)
        return
      }
      case 'awareness': {
        applyAwarenessUpdate(this.awareness, msg.update, this)
        return
      }
    }
  }
}

/**
 * TabId —— 不需要 nanoid 长串,8 字符够本地去重就行。即使同 origin 两个 Tab
 * 撞到,后果是两个 Tab 互相认对方消息为「自己的」(不再广播自己 apply 的
 * update,会导致 CRDT 收敛丢失),实际命中概率 ~31^8 ≈ 8.5e11 分之一,
 * 接受。
 */
function newTabId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return s
}