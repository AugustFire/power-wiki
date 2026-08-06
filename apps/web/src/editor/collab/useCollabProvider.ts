/**
 * useCollabProvider —— Hocuspocus WebSocket provider 的 Vue 封装。
 *
 * Phase 1(2026-08-05 落地):awareness-only 模式,ReadView mount 时建一个
 * provider,通过 server 广播 `{ user }` state,其他人订阅 awareness 渲染
 * presence 头像组。**不**绑定 Tiptap / Y.Doc 业务 —— Y.Doc 在 Phase 1
 * 只承载 awareness,body 内容 Phase 2 再走。
 *
 * Phase 2 扩:暴露 `ydoc` 给 caller —— Tiptap 通过 `@tiptap/extension-collaboration`
 * 的 `Collaboration.configure({ document: ydoc, field: 'prosemirror' })` 把
 * editor state 绑到这份 Y.Doc。provider 跟 ydoc 是 1:1 生命周期(pageId 切换
 * 时一起 destroy → 新建),caller 用一份 ref 即可,不必额外管理。
 *
 * 设计:
 *   - **生命周期**:onScopeDispose 自动 destroy(),页面切换 / 组件卸载
 *     不需要 caller 手动管。
 *   - **pageId 切换**:watch 重启 provider(旧 destroy → 新 connect),保证
 *     同 component 实例复用情况下不残留 stale 状态。**ydoc 跟随**:旧 provider
 *     destroy 时释放 Y.Doc 引用,新 pageId 触发新 new Y.Doc。
 *   - **awareness 状态**:`getStates()` 是 plain Map,Vue 不知道 reactive,
 *     包成 Ref 后用 awareness.on('change', ...) 触发 reload。每次 change
 *     全量复制 states 一次 —— 个人 / 共享 awareness 客户端数 < 10,
 *     不必做精细 diff,reactive 整体替换足够。
 *   - **filter self**:本地 clientID 的 state 自己渲染时不用再算头像,
 *     ReadView 显示「其他正在看的人」时跳过 self。是否暴露 self 由 caller
 *     决定,composable 不强行过滤。
 *
 * M13+ 协同删除 race 收口(2026-08-06):暴露 `onStateless`,caller 用来
 * 订阅 server 推的 `page_locked_during_delete` / `page_actually_deleted`
 * 等事件。Hocuspocus stateless 是纯 string 通道(协议层不解析),server
 * JSON.stringify 后发出,client `JSON.parse` 即可。BroadcastChannel
 * provider 不接 server,personal mode 的 admin-not-write 边界天然不进
 * 这个流程,这里也返回 no-op unsub。
 *
 * 关键约束:
 *   - 仅在登录态使用,未登录态返回 null refs (Caller 跳过渲染)。
 *   - mode='shared' 走 server 持久化(Phase 1 + 2);mode='personal' 走
 *     BroadcastChannel(Phase 3 才实现)。
 *   - 切页时 `ydoc` Ref 会换新对象 — 调用 `buildExtensions` 的 caller 必须
 *     把 editor 跟新 ydoc 重新绑(React/Vue 通常通过 watcher / :key 重挂
 *     编辑器),否则旧 ydoc 上的 transact 会写到陈旧的 document 上。
 */
import { onScopeDispose, ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { User } from '@power-wiki/shared'
import { BroadcastChannelProvider } from './broadcastChannelProvider'

export type CollabMode = 'shared' | 'personal'

/**
 * Awareness state 形态 — server 端的 hooks.onAuthenticate 注入 context.user,
 * 客户端 setLocalStateField('user', ...) 后被 y-protocols Awareness 广播。
 *
 * Phase 1 只放 user 元数据,Phase 2 会加 cursor / focusingTitle 等字段。
 *
 * mode 字段(2026-08-06 加):'view' = 当前在 ReadView / 其他,'edit' = 当前
 * 在 EditView。ReadView 渲染 PresenceAvatars 时,如果 awareness 里 mode='edit'
 * 会把「正在看」前缀升级为「正在编辑」。Phase 6 的常驻条也基于此判断。
 */
export type AwarenessMode = 'view' | 'edit'

export interface AwarenessUserState {
  user: {
    id: string
    name: string
    color: string
    avatarKind: User['avatarKind']
    avatarRef: string | null
    mode: AwarenessMode
  }
}

export interface UseCollabProviderOptions {
  pageId: Ref<string | null>
  /** 当前用户,登录态填;未登录态传 null,composable 直接 no-op。 */
  user: Ref<User | null>
  /**
   * 协同模式。函数式,让 caller 派生(EditView 按 page.spaceKind 切
   * shared / personal)。每次 pageId watch 触发 connect 时取一次最新值,
   * 避免 mode 跟 page 不一致(同 user 跨空间切页时 mode 可能翻转)。
   */
  mode?: () => CollabMode
  /**
   * 2026-08-06 加:awareness.user.mode 字段值。'view' = 读者,'edit' = 正在
   * 编辑。EditView 传 `() => 'edit'`,ReadView 传 `() => 'view'`,provider
   * 在 mode 变化 / awareness 建立后自动 setLocalStateField。
   *
   * 不传默认 'view'。注意 provider 会在 awareness 建立(onAuthenticated 或
   * BroadcastChannel 构造)和 mode 函数返回新值时各写一次,跨 page 切换时
   * 新 page 的 mode 会自动用 caller 提供的最新函数求值。
   */
  awarenessMode?: () => AwarenessMode
  /** Hocuspocus server URL,默认 '/api/collab'(vite proxy 到 8788)。 */
  url?: string
}

export interface UseCollabProviderReturn {
  /** 当前 awareness 状态 map(clientID → state)。Self 也包含,caller 自筛。 */
  awarenessStates: ShallowRef<Map<number, AwarenessUserState>>
  /** 本地 clientID —— 用来从 states 里过滤自己。 */
  clientId: Ref<number | null>
  /** WebSocket 是否连上。 */
  isConnected: Ref<boolean>
  /** Awareness 实例,Phase 2 绑 Tiptap cursor 时直接拿。 */
  awareness: ShallowRef<Awareness | null>
  /**
   * 当前 page 的 Y.Doc —— Phase 2 Tiptap 的 `Collaboration` 扩展绑这份 doc,
   * y-prosemirror 会把 editor state 编进 Yjs。**切 pageId 时引用会换**,
   * caller 必须把新 ydoc 喂回 editor(或者通过 :key 触发 editor 重挂)。
   */
  ydoc: ShallowRef<Y.Doc | null>
  /** Phase 1 only:注册一次远端 awareness change 回调(测试脚本用)。 */
  onAwarenessChange: (cb: () => void) => () => void
  /**
   * 订阅 server 推的 stateless 事件(M13+)。handler 收到 JSON-encoded
   * string payload。返回 unsub 函数。shared mode 真正连 server;personal
   * mode 返回 no-op unsub(personal 走 BroadcastChannel,没 server 推信号)。
   *
   * 典型用法:
   *   const unsub = onStateless((payloadStr) => {
   *     const msg = JSON.parse(payloadStr)
   *     if (msg.kind === 'page_locked_during_delete') { ... }
   *   })
   *   onScopeDispose(unsub)
   */
  onStateless: (handler: (payload: string) => void) => () => void
  /** 强制 destroy。onScopeDispose 自动调,手动场景(如切换 pageId)也用。 */
  destroy: () => void
}

export function useCollabProvider(opts: UseCollabProviderOptions): UseCollabProviderReturn {
  const { pageId, user, mode: modeGetter = () => 'shared', url = '/api/collab' } = opts

  const awarenessStates = shallowRef<Map<number, AwarenessUserState>>(new Map())
  const clientId = ref<number | null>(null)
  const isConnected = ref(false)
  const awareness = shallowRef<Awareness | null>(null)
  const ydoc = shallowRef<Y.Doc | null>(null)
  const changeCallbacks: Array<() => void> = []
  const statelessCallbacks: Array<(payload: string) => void> = []

  let provider: HocuspocusProvider | BroadcastChannelProvider | null = null

  function connect(targetPageId: string, u: User): void {
    // Y.Doc 在 Phase 1 跑 awareness,Phase 2 给 Tiptap 绑。这里 new 出来的
    // 单一持有者,pageId 切换时 destroy() 会 Y.Doc.destroy() 后再 new,
    // caller 通过 shallowRef 重新拿引用即可。
    const currentMode = modeGetter()
    if (currentMode === 'personal') {
      // Phase 3:个人空间走 BroadcastChannel,不上 server。BroadcastChannelProvider
      // 内部 new Y.Doc + new Awareness,我们直接挂到 refs,然后 broadcastChannelProvider
      // 也暴露自己的引用供 destroy 用。
      const bc = new BroadcastChannelProvider({
        pageId: targetPageId,
        user: {
          id: u.id,
          name: u.name,
          color: u.color,
          avatarKind: u.avatarKind ?? null,
          avatarRef: u.avatarRef ?? null,
        },
      })
      ydoc.value = bc.ydoc
      awareness.value = bc.awareness
      clientId.value = bc.ydoc.clientID
      isConnected.value = true // BroadcastChannel 无网络概念,直接 true
      provider = bc
      refreshStates()
      // listen awareness 'change' 触发对外 callback(同 Hocuspocus 路径行为)
      bc.awareness.on('change', () => {
        refreshStates()
        for (const cb of changeCallbacks) cb()
      })
      // personal mode 不连 server,server stateless 推到这里始终是无 —— 不订阅
      // 会留下「handler 永远不 fire」的语义陷阱,这里挂 no-op 让 caller 心智一致。
      // 同时把 caller 提供的 awarenessMode 应用到刚建好的 awareness 上。
      applyAwarenessMode()
      return
    }
    const doc = new Y.Doc()
    ydoc.value = doc
    const p = new HocuspocusProvider({
      url,
      name: targetPageId,
      document: doc,
      onAuthenticated: () => {
        // 鉴权通过后立刻 setLocalState,让其他 client 第一时间看到我们。
        p.setAwarenessField('user', {
          id: u.id,
          name: u.name,
          color: u.color,
          avatarKind: u.avatarKind ?? null,
          avatarRef: u.avatarRef ?? null,
          // mode 由 caller 通过 awarenessMode prop 提供,EditView 传 'edit',
          // ReadView 传 'view'。这里默认 'view',applyAwarenessMode 会立即
          // 用 caller 的最新值覆盖一次。
          mode: opts.awarenessMode?.() ?? 'view',
        })
        applyAwarenessMode()
      },
      onStatus: ({ status }) => {
        isConnected.value = status === 'connected'
      },
      onSynced: () => {
        awareness.value = p.awareness ?? null
        clientId.value = p.awareness?.clientID ?? null
        refreshStates()
      },
      onAwarenessChange: () => {
        refreshStates()
        for (const cb of changeCallbacks) cb()
      },
      onStateless: (data: { payload: string }) => {
        // Hocuspocus 协议 stateless 是 string 通道(passing JSON-encoded event),
        // onStatelessParameters 类型已固定 `{ payload: string }`。多 callback fan
        // out,caller 用 onStateless 注册多个,各自 parse 后判断 msg.kind。
        for (const cb of statelessCallbacks) cb(data.payload)
      },
      onDisconnect: () => {
        isConnected.value = false
      },
    })
    provider = p
  }

  function refreshStates(): void {
    const a = awareness.value
    if (!a) {
      awarenessStates.value = new Map()
      return
    }
    // y-protocols getStates 返回 Map<clientId, state> — shallowRef 整体替换
    // 触发 reactive 重渲。Phase 1 N ≤ 几个 client,无 diff 成本。
    const states = new Map<number, AwarenessUserState>()
    for (const [cid, st] of a.getStates()) {
      if (st && typeof st === 'object' && 'user' in st) {
        states.set(cid, st as AwarenessUserState)
      }
    }
    awarenessStates.value = states
  }

  /**
   * 把当前 awareness.user.mode 同步到 caller 提供的最新值。
   * 只在 awareness 已就绪时写,未就绪就 no-op(后续 onAuthenticated 会再写一次)。
   * user.id / name / color 等其他字段保留 — caller 只关心 mode 翻面。
   */
  function applyAwarenessMode(): void {
    const a = awareness.value
    if (!a || !opts.user.value) return
    const desired = opts.awarenessMode?.() ?? 'view'
    const local = a.getLocalState() as { user?: Record<string, unknown> } | null
    const user = local?.user
    if (!user || user['mode'] === desired) return
    a.setLocalStateField('user', { ...user, mode: desired })
  }

  function destroy(): void {
    if (provider) {
      provider.destroy()
      provider = null
    }
    if (ydoc.value) {
      // Y.Doc.destroy() 释放内部引用并触发 'destroy' 事件;合作扩展会收到
      // 这条事件,把 Tiptap editor 从 doc 上 解绑(否则编辑器继续在 disposed
      // doc 上 transact,导致静默丢字)。
      ydoc.value.destroy()
      ydoc.value = null
    }
    awarenessStates.value = new Map()
    clientId.value = null
    isConnected.value = false
    awareness.value = null
    // 不清 statelessCallbacks:订阅者用 unsub 函数管理生命周期;销毁时
    // 订阅者通常跟着页面 destroy,与 provider lifecycle 对齐。
  }

  // pageId 或 user 变化时重启 provider。Phase 1 + 2 走 shared mode(server),
  // Phase 3 起 personal mode 走 BroadcastChannel。connect() 内部按 mode
  // 分发(见 connect 实现)。
  watch(
    [pageId, user],
    ([pid, u], [prevPid, prevU]) => {
      if (provider) destroy()
      if (!pid || !u) return
      // user 切换(同浏览器换账号) → 旧 cookie 已失效,新 provider 会用新
      // cookie 重新鉴权,server onAuthenticate 短路 forbidden。
      void prevPid
      void prevU
      connect(pid, u)
    },
    { immediate: true },
  )

  /**
   * awarenessMode 变化时(EditView 切走 / ReadView 切回)→ 把当前 awareness.user.mode
   * 翻面。caller 传函数式 ref 的好处是不用 caller 写生命周期 hook,EditView
   * 跟 ReadView 各自传自己的 closure provider 自动同步。
   */
  if (opts.awarenessMode) {
    watch(opts.awarenessMode, () => {
      applyAwarenessMode()
    })
  }

  function onAwarenessChange(cb: () => void): () => void {
    changeCallbacks.push(cb)
    return () => {
      const i = changeCallbacks.indexOf(cb)
      if (i >= 0) changeCallbacks.splice(i, 1)
    }
  }

  function onStateless(handler: (payload: string) => void): () => void {
    statelessCallbacks.push(handler)
    // 在 PersonalMode 下,BroadcastChannel 没 server,callback 永远不 fire。
    // 仍然允许 caller 调用(返回 unsub 维持接口对称),但 emit 时机只跟 Hocuspocus
    // provider 绑定。provider 切换 / destroy 时新 connect 的 provider 会保留
    // 这份 callback 列表(模块级变量),事件 fan-out 自然继续。
    return () => {
      const i = statelessCallbacks.indexOf(handler)
      if (i >= 0) statelessCallbacks.splice(i, 1)
    }
  }

  onScopeDispose(destroy)

  return {
    awarenessStates,
    clientId,
    isConnected,
    awareness,
    ydoc,
    onAwarenessChange,
    onStateless,
    destroy,
  }
}
