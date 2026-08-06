/**
 * usePageLock —— 页面编辑锁的 Vue 封装。
 *
 * Phase 4 (2026-08-05):「Alice 大改时 Bob 不要乱入」的 UI 信号。
 *
 * 用法(EditView 顶层):
 *   const collabCtl = useCollabProvider({ pageId, user })
 *   const lockCtl = usePageLock({
 *     pageId: localId,        // Ref<string | null>
 *     currentUser,            // Ref<User | null>
 *     isAdmin: authStore.isAdmin,
 *     collabMode,             // shared / personal / off —— personal mode 不拿锁
 *     awarenessStates,        // for resolving holder name from awareness
 *     clientId,
 *     onStateless: collabCtl.onStateless,  // M13+:订阅 server 推的
 *                                            // page_locked_during_delete
 *   })
 *   <LockBanner :lock="lockCtl.lock.value" :is-admin="isAdmin"
 *               :current-user-id="currentUser.id"
 *               :holder-name="lockCtl.holderName.value"
 *               @takeover="lockCtl.onTakeoverResult"
 *               @released="lockCtl.clear" />
 *
 * 关键设计:
 *   - **只在 shared mode 拿锁** —— personal space 是单用户多 Tab,Bob 不可能
 *     看见(URL 路由层隔离),锁没意义;off 模式(新页还没 save)不拿锁。
 *   - **mount → acquire**:进入 EditView 时拿锁,unmount → release。Component
 *     scope 跟锁生命周期对齐;多次 mount/unmount 会产生多次短锁(<= 5min TTL)。
 *   - **每秒轮询 /api/pages/:id/lock** —— 别人可能 acquire 走 expire 覆盖,
 *     或者 admin takeover,server 主动推送 lock_takeover 也能更新本地。
 *   - **Hocuspocus stateless 监听 lock_takeover**:holder 收到 server 的
 *     takeover 推送,弹 lock_taken toast,UI 切回 ReadView(用户的编辑照常
 *     走 Yjs CRDT merge,锁只影响 UI 提示不影响数据)。
 *   - **page_locked_during_delete (M13+)**:admin 试图软删 / 硬删当前 page 时,
 *     server 在写入 deletedAt 之前给所有持锁者推这条;holder 端 banner 提示
 *     「删除会拒绝,直到你离开编辑器」,让出后 B 才能继续删。**不要**立即
 *     redirect —— A 还在编辑中,只是 banner 提示。这是 Phase 5 收口 race
 *     4 个缺口的入口。
 *   - **holder 解析**:awareness 在线时从 awarenessStates 取 user.name /
 *     color / avatar;离线时 fallback 到 userId(未知展示名),UI 仍可显示
 *     「X 正在编辑」(avatar 走 fallback initial)。
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { api, ApiError, type PageLock } from '@/lib/api'
import { useUiStore } from '@/stores/ui'
import type { User } from '@power-wiki/shared'
import type { AwarenessUserState } from '@/editor/collab/useCollabProvider'
import { useRouter } from 'vue-router'

export type PageLockCollabMode = 'off' | 'shared' | 'personal'

/**
 * M13+ 协同删除 race 收口的 stateless payload。结构跟 server 端
 * pages.ts → stateless.ts 推的 JSON 保持一致。
 *
 * - page_locked_during_delete:server 在写 deletedAt 之前拒删,通知所有 holder。
 *   holder 端 usePageLock 收到后挂 pageDeletingRef,caller 渲染 PageDeletingBanner。
 * - page_actually_deleted:server 在 commit 后兜底推一条(防 holder 网络异常没收到
 *   page_locked_during_delete 时仍能被强制离开)。
 */
export interface PageDeleting {
  actorId: string
  at: number
}

export interface UsePageLockOptions {
  pageId: Ref<string | null>
  currentUser: Ref<User | null>
  isAdmin: Ref<boolean>
  collabMode: Ref<PageLockCollabMode>
  /** shared mode 下由 useCollabProvider 传入,给 holder 名字解析用。 */
  awarenessStates: Ref<Map<number, AwarenessUserState>>
  /** 本地 clientID,过滤 self awareness。 */
  clientId: Ref<number | null>
  /**
   * Hocuspocus 连接状态 —— 决定 polling 节奏:
   *   - 已连接:WS push 优先,polling 降到 5s 兜底
   *   - 断开(网络抖 / 服务器 restart):polling 回到 1s
   * EditView 在 useCollabProvider 后调,直接传 `collab.isConnected` 即可。
   * 不传视为永远「已连接」(默认 5s 节奏)。
   */
  isCollabConnected?: Ref<boolean>
  /**
   * Phase 5:lock acquire 成功后调。Phase 4 之前由 usePageAutoSave 的
   * 30s idle 定时器触发的「session 内 checkpoint」现在统一改在 lock
   * 边界打 —— 进入编辑视图 = session 开始,锁释放 = session 结束。
   * EditView 在这里调 pagesStore.snapshotPage(pageId, 'lock-boundary')。
   *
   * 失败静默 —— snapshot 是 advisory,失败不让 acquire 状态回滚。
   */
  onAcquire?: (pageId: string) => void | Promise<void>
  /**
   * Phase 5:lock release 前调。snapshot 完再调 DELETE /api/pages/:id/lock。
   * 同样失败静默 —— release 优先于 snapshot。
   */
  onRelease?: (pageId: string) => void | Promise<void>
  /**
   * M13+:订阅 server 推的 stateless 事件。usePageLock 内部只识别
   * `page_locked_during_delete`(挂 pageDeletingRef)+ `page_actually_deleted`
   * (通知 + redirect)两种 kind,其他 kind 一律忽略 —— hocuspocus takeover 的
   * `lock_takeover` 由 useCollabProvider onAwarenessChange / 自身轮询兜底,
   * 不走这条路径。
   *
   * caller 通常传 `useCollabProvider().onStateless` 即可。subscriber 生命周期
   * 跟 usePageLock 同步(scope 销毁时 unsub)。
   */
  onStateless?: (handler: (payload: string) => void) => () => void
}

export interface UsePageLockReturn {
  lock: Ref<PageLock | null>
  /** 当前 lock holder 的展示名(从 awareness 解析,fallback null)。 */
  holderName: Ref<string | null>
  /** holder 头像色(从 awareness 解析)。 */
  holderColor: Ref<string | null>
  /**
   * M13+:当前 page 正在被人尝试删除 —— 非 null 时 caller 渲染
   * PageDeletingBanner 告知用户让出锁才能让删除继续。B 超时未让出时锁
   * 5min TTL 自然过期后也能继续。
   */
  pageDeleting: Ref<PageDeleting | null>
  /**
   * M13+:deleter(B) 的展示名 —— 优先从 awarenessStates 解析,B 不在
   * awareness 时返 null(banner 内部 fallback 到 actorId 直接展示)。
   */
  pageDeletingActorName: Ref<string | null>
  /** M13+:deleter 的头像色 —— 同 pageDeletingActorName 优先级,fallback null。 */
  pageDeletingActorColor: Ref<string | null>
  /** 强夺回来后 caller 调一次,刷新 lock ref。 */
  setLock: (lock: PageLock | null) => void
  /** 释放后 caller 调一次,清掉本地 ref。 */
  clear: () => void
}

const POLL_INTERVAL_CONNECTED_MS = 5_000
const POLL_INTERVAL_DISCONNECTED_MS = 1_000
const POLL_INTERVAL_HIDDEN_MS = 30_000

/**
 * M13+:每条 server 推的 stateless payload 都按这个 schema parse,
 * 未知 kind 扔 warn 但不抛 —— handler 容错是 hard 约束,parse 失败
 * 不能污染其他正常事件路径。
 */
interface PageDeletingPayload {
  kind: 'page_locked_during_delete'
  actorId: string
  pageId: string
}
interface PageActuallyDeletedPayload {
  kind: 'page_actually_deleted'
  pageId: string
}
/**
 * WS push-based lock 感知(2026-08-06):server 推 lock_changed 时直接带最新
 * PageLock DTO,client 端 lock.value = msg.lock 即可,不必走 GET /lock。
 * lock_cleared 是 TTL sweep 触发的轻量通知(锁已经空了,无需 lock=null 字段)。
 */
interface LockChangedPayload {
  kind: 'lock_changed'
  pageId: string
  lock: PageLock | null
}
interface LockClearedPayload {
  kind: 'lock_cleared'
  pageId: string
  at: number
}
type StatelessPayload =
  | PageDeletingPayload
  | PageActuallyDeletedPayload
  | LockChangedPayload
  | LockClearedPayload
  | { kind: string; [k: string]: unknown }

export function usePageLock(opts: UsePageLockOptions): UsePageLockReturn {
  const { pageId, currentUser, isAdmin, collabMode, awarenessStates, clientId } = opts
  const uiStore = useUiStore()
  const router = useRouter()

  const lock = ref<PageLock | null>(null)
  const pageDeleting = ref<PageDeleting | null>(null)
  let pollHandle: number | null = null
  /**
   * 已 release 的 pageId 集合。release() 一次后该 pageId 永久记入「已让出」,
   * 防止 unmount + watch [pageId] + 路由 leave 三处并发触发重复 DELETE。
   * **关键**:作用域是 pageId 而不是全局布尔,这样 shared→personal→shared
   * 切回 / 切到新 page 后再切回老 page,acquire 仍会发请求(pre-Phase 5
   * 全局 released=true 守卫会让这种重新进入永远 silent,锁闸门失效)。
   */
  const releasedPageIds = new Set<string>()
  let statelessUnsub: (() => void) | null = null

  /** 拿锁(只在 shared mode)。非 shared 模式不拿锁,holder name 永远是 null。 */
  async function acquire(): Promise<void> {
    if (!pageId.value || !currentUser.value) return
    if (collabMode.value !== 'shared') return
    if (releasedPageIds.has(pageId.value)) return
    try {
      const r = await api.pageLock.acquire(pageId.value)
      lock.value = r.lock
      // Phase 5:锁 boundary snapshot。EditView 在 onAcquire 里调
      // snapshotPage —— session 开始打一个 checkpoint,后面 release 时再打
      // 一个,中间编辑的所有 PATCH 都是 silent。失败静默(snapshot 是 advisory)。
      if (opts.onAcquire) {
        try {
          await opts.onAcquire(pageId.value)
        } catch (err) {
          console.warn('[usePageLock] onAcquire callback failed', err)
        }
      }
    } catch (e) {
      // 409 page_locked = 别人正在编辑,本视图只是「想拿锁」的人。这里不弹
      // 错误(toast 会让用户困惑),改成展示 banner —— usePageLock 的 lock
      // ref 会在下次 poll 拉 server 真值时落地。
      if (e instanceof ApiError && e.code === 'page_locked') {
        await refresh()
        return
      }
      // 其他错误(404/403/network)走 banner / 静默,不阻塞 editor。
      console.warn('[usePageLock] acquire failed', e)
    }
  }

  /** 释放锁(离开 editor)。 */
  async function release(): Promise<void> {
    if (!pageId.value) return
    if (releasedPageIds.has(pageId.value)) return
    releasedPageIds.add(pageId.value)
    // Phase 5:release 前先调 boundary snapshot,确保 session 结束时的
    // 内容进 page_versions。即便 onRelease 抛错也继续 release —— release
    // 优先,锁 5 分钟自动过期兜底。
    if (opts.onRelease) {
      try {
        await opts.onRelease(pageId.value)
      } catch (err) {
        console.warn('[usePageLock] onRelease callback failed', err)
      }
    }
    try {
      await api.pageLock.release(pageId.value)
    } catch {
      // 释放失败不必挂 UI —— 锁 5 分钟自动过期,server 端兜底。
    } finally {
      lock.value = null
    }
  }

  /** 轮询 GET 锁状态 —— 每秒拉一次,捕捉 expire / takeover / 其他 user 拿锁。 */
  async function refresh(): Promise<void> {
    if (!pageId.value) return
    try {
      const r = await api.pageLock.get(pageId.value)
      lock.value = r.lock
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_found') {
        // page 被 purge / 不可见 —— 路由回首页,顶部 banner 留 409 提示
        lock.value = null
        uiStore.notify('此页面已被删除', 'error', 5000)
        router.replace('/')
        return
      }
      // 网络抖动 / 403(权限过期):不重置 lock,等下一轮
    }
  }

  /** 启动 / 停止轮询。 */
  function startPoll(): void {
    stopPoll()
    scheduleNextPoll()
  }
  function stopPoll(): void {
    if (pollHandle != null) {
      window.clearTimeout(pollHandle)
      pollHandle = null
    }
  }

  /**
   * WS push 路径(2026-08-06)下的 adaptive polling + skip:
   *
   *   - WS 已连接 + lock 是自己的:跳过轮询(server 推 `lock_changed` /
   *     `lock_cleared` 已覆盖 takeover / 过期通知),0 网络请求。
   *   - WS 已连接 + lock 不是自己的:5s 兜底,捕捉 TTL 过期(避免 server
   *     30s sweep 的延迟感)。
   *   - WS 断开:1s 紧轮询,作为 fallback。
   *   - tab hidden:30s 兜底(browser 会 throttle background timer,30s 足够
   *     感知 TTL 过期)。
   *
   * 用 setTimeout 而非 setInterval 是为了下一轮的间隔能根据当前状态
   * (isCollabConnected / document.hidden)动态计算 —— setInterval 的
   * period 是固定的。
   *
   * S8(2026-08-06):lock 是自己的 + WS 已连接 → 0 轮询。lock.userId 变化
   * (takeover)时 watcher 触发 maybeStartPoll() 重新评估并启动。
   */
  function computePollIntervalMs(): number {
    if (typeof document !== 'undefined' && document.hidden) return POLL_INTERVAL_HIDDEN_MS
    if (opts.isCollabConnected && !opts.isCollabConnected.value) return POLL_INTERVAL_DISCONNECTED_MS
    return POLL_INTERVAL_CONNECTED_MS
  }
  function scheduleNextPoll(): void {
    pollHandle = window.setTimeout(async () => {
      await refresh()
      scheduleNextPoll()
    }, computePollIntervalMs())
  }
  function shouldSkipPoll(): boolean {
    // 我的锁 → 永远跳过轮询:
    //   - takeover 由 server 推 `lock_changed` 通知,客户端不需要 poll
    //   - 我自己的 TTL(server 5min 兜底)不需要客户端检测 —— 长时间没操作
    //     server 也会自然过期,我断开连接 server 5min 后也会清掉锁
    // 不管 WS 连不连都跳过。WS 断开时不轮询,避免 server 不可达时反复打
    // GET 拿到 5xx 增加日志噪音。
    const l = lock.value
    if (l && l.userId === currentUser.value?.id) return true
    return false
  }
  function maybeStartPoll(): void {
    if (shouldSkipPoll()) {
      stopPoll()
    } else {
      startPoll()
    }
  }

  /**
   * M13+:handle 一条 server → client stateless 消息。这里只识别删除相关的
   * 两个 kind;其他(hocuspocus takeover / 任意扩展事件)留 caller 自行处理。
   *
   * 容错:parse 失败 / unknown kind 都 warn 后丢,不污染 pageDeleting ref
   * 也不 redirect。
   */
  function handleStateless(rawPayload: string): void {
    let msg: StatelessPayload
    try {
      msg = JSON.parse(rawPayload) as StatelessPayload
    } catch (err) {
      console.warn('[usePageLock] non-JSON stateless payload ignored', rawPayload, err)
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') {
      return
    }
    if (msg.kind === 'page_locked_during_delete') {
      // 设 pageDeleting —— caller 用它挂 PageDeletingBanner。
      // 注意:**不**立即 redirect/notify —— A 还在编辑中,只是 banner
      // 提示;让 A 主动决定是否让出。
      const actorId = (msg as PageDeletingPayload).actorId
      pageDeleting.value = { actorId, at: Date.now() }
      return
    }
    if (msg.kind === 'page_actually_deleted') {
      // 兜底:server 在 purge/软删 commit 后推一条,告诉所有曾经持锁者页面已
      // 经被删了。该离开编辑器了。
      lock.value = null
      pageDeleting.value = null
      uiStore.notify('此页面已被删除', 'error', 5000)
      router.replace('/')
      return
    }
    if (msg.kind === 'lock_changed') {
      // WS push 路径(2026-08-06):server 推带新 lock DTO,直接更新本 ref,
      // 跳过 polling 兜底。注意 pageId 一致才接受(避免跨 page 串扰,
      // 虽然 Hocuspocus documentName 是 page-scoped,理论上不会发生)。
      const p = msg as LockChangedPayload
      if (p.pageId === pageId.value) {
        lock.value = p.lock
      }
      return
    }
    if (msg.kind === 'lock_cleared') {
      // TTL sweep 推送:锁过期被 server 清了。直接 lock.value = null,
      // banner / ReadView tooltip 等 computed 会自动反应。
      const p = msg as LockClearedPayload
      if (p.pageId === pageId.value) {
        lock.value = null
      }
      return
    }
    // 其他 kind 不处理 —— by design,以后扩展可以再往上加 case 分支。
  }

  /**
   * 注册 stateless 订阅 —— 一次订阅,caller(EditView)挂页面 scope。
   * 个人空间 / off 模式不进 Hocuspocus 连接,即便调用 onStateless 也会
   * 因为 provider 没接 server 而永远不 fire,但 unsub 函数照常返回好让
   * caller 不必判 mode。
   */
  function startStateless(): void {
    stopStateless()
    if (!opts.onStateless) return
    statelessUnsub = opts.onStateless(handleStateless)
  }
  function stopStateless(): void {
    if (statelessUnsub) {
      statelessUnsub()
      statelessUnsub = null
    }
  }

  /**
   * watch(pageId, ...) —— 切换页时先释放旧锁,再为新页 acquire。
   * 同时 watch collabMode 翻 personal → shared 时补 acquire。
   *
   * Phase 5 修:切页时也调 onRelease(prevPid) 再 release,跟 unmount 路径
   * 行为对齐 —— 「session 结束 = 锁释放」语义统一。prevPid 是闭包变量,
   * 在 watch 的旧值上读,确保 onRelease 拿的是「要释放的那个 pageId」,
   * 不是新的 pid。
   *
   * 不 watch currentUser —— router.beforeEach 在每次导航时调
   * authStore.init(),即使 user 对象内容没变,赋值也会触发 reactivity,
   * 让本 watcher 在 close → ReadView 切换时多 fire 一次,误触发 acquire
   * (此时 lock 还在手里,反而会写一条 lock-acquire snapshot 进
   * page_versions,跟同路径的 onRelease 撞车)。currentUser 变化后该
   * 走的是 init() 内部的权限刷新,不是 acquire / release —— 后续如果
   * 需要「user 切了立刻释放锁」再加 watch。
   */
  watch(
    [pageId, collabMode],
    async ([pid, mode], [prevPid, _prevMode]) => {
      if (prevPid && prevPid !== pid) {
        // 切到新 page:释放旧锁(用 prevPid)。先打 boundary snapshot,
        // 再调 DELETE /api/pages/:prevPid/lock。
        if (opts.onRelease) {
          try {
            await opts.onRelease(prevPid)
          } catch (err) {
            console.warn('[usePageLock] onRelease callback failed (pageId change)', err)
          }
        }
        try {
          await api.pageLock.release(prevPid)
        } catch {
          /* ignore */
        }
        // releasedPageIds 是 pageId-scoped,旧 pid 已在 release() 里加入集合,
        // 新 pid 不在集合中 → acquire 允许。无需手动清。保留 prevPid 在集合里
        // 是 by design:同一 pid 切换走 watch 路径不会再 release 一次,
        // 也避免外部 watch 重入触发重复 DELETE。
        // 切页时清掉旧 pageDeleting —— 标记的 actor 是基于旧 pageId
        // 的语义,但旧 page 的持有关系也释放了,不该 banner 残留。
        pageDeleting.value = null
      }
      if (!pid || !currentUser.value) {
        lock.value = null
        return
      }
      await acquire()
      maybeStartPoll()
      // onStateless 订阅只在首次或 pageId 变化时重建(provider pageId
      // watch 已经做了 destroy + new connect,callbacks 列表留存)。
      // 这里不重复注册,避免 fanout 多倍。
    },
    { immediate: true },
  )

  // mount 时一次性挂 stateless 订阅(provider 切换时 callbacks 列表留存,
  // 所以 pageId 切换不需要重新注册)。callers 在 unmount 时由框架清理。
  startStateless()

  /** shared mode 离开(personal / off / 切到新页) → release 一次。 */
  watch(
    () => collabMode.value,
    async (newMode, oldMode) => {
      if (oldMode === 'shared' && newMode !== 'shared') {
        await release()
        stopPoll()
      }
    },
  )

  /**
   * S8 (2026-08-06):lock 持有者变化或 WS 连接状态变化时,重新评估 polling 策略。
   *   - lock.userId 从「他人」→「自己」:停止 polling(server push 已足够)
   *   - lock.userId 从「自己」→「他人」(admin takeover):启动 5s 兜底
   *     polling,捕捉 TTL 过期
   *   - isCollabConnected 翻转:重排下一轮 interval
   */
  watch(
    [() => lock.value?.userId, () => opts.isCollabConnected?.value, () => currentUser.value?.id],
    () => {
      maybeStartPoll()
    },
  )

  /** holder name 解析 —— 用 awarenessStates 找 user.id == lock.userId 的 entry。 */
  const holderName = computed(() => {
    const l = lock.value
    if (!l) return null
    for (const [cid, st] of awarenessStates.value) {
      if (cid === clientId.value) continue
      if (st.user?.id === l.userId) return st.user.name
    }
    return null
  })
  const holderColor = computed(() => {
    const l = lock.value
    if (!l) return null
    for (const [cid, st] of awarenessStates.value) {
      if (cid === clientId.value) continue
      if (st.user?.id === l.userId) return st.user.color
    }
    return null
  })

  /**
   * M13+:deleter(actor)的 name / color 解析。优先 awarenessStates(若 B 当前
   * 也连着 Hocuspocus —— 多半是 ReadView 旁观场景);awareness 没覆盖时
   * 返 null,PageDeletingBanner 会 fallback 到 actorId 字面量。deleter 不一定
   * 在 awarenessStates(B 可能纯走 REST 调 DELETE),容忍 null —— 比
   * fetchUsers 轻量、也比「block on network」好得多。
   */
  const pageDeletingActorName = computed(() => {
    const d = pageDeleting.value
    if (!d) return null
    for (const [, st] of awarenessStates.value) {
      if (st.user?.id === d.actorId) return st.user.name
    }
    return null
  })
  const pageDeletingActorColor = computed(() => {
    const d = pageDeleting.value
    if (!d) return null
    for (const [, st] of awarenessStates.value) {
      if (st.user?.id === d.actorId) return st.user.color
    }
    return null
  })

  onBeforeUnmount(async () => {
    stopPoll()
    stopStateless()
    visibilityHandler && window.removeEventListener('visibilitychange', visibilityHandler)
    await release()
  })

  /**
   * visibilitychange —— tab hidden 时 polling 节奏降到 30s,visible 时立即
   * 拉一次并恢复正常节奏。注意 listener 必须在 mount 时挂,unmount 时摘
   * (否则多次进出 EditView 会堆 listener)。
   */
  let visibilityHandler: (() => void) | null = null
  if (typeof document !== 'undefined') {
    visibilityHandler = () => {
      if (!document.hidden) {
        // tab 重新可见 → 立即拉一次 + 重排下一轮
        // S8:走 maybeStartPoll 让 skip 规则一并生效(避免 lock 是自己的时
        // tab 切回突然又触发 5s 轮询)。
        maybeStartPoll()
        void refresh().finally(() => maybeStartPoll())
      } else {
        // tab 隐藏 → 重排下一轮(下一轮 interval 会是 30s)
        maybeStartPoll()
      }
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }

  // isAdmin 仅供 type narrowing 不用,避免 unused 警告
  void isAdmin

  return {
    lock,
    holderName,
    holderColor,
    pageDeleting,
    pageDeletingActorName,
    pageDeletingActorColor,
    setLock: (l) => {
      lock.value = l
    },
    clear: () => {
      lock.value = null
    },
  }
}