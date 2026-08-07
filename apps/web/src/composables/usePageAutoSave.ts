/**
 * usePageAutoSave — 抽离 EditView / RichEditor 各自散落的防抖 + 状态机,
 * 统一一份 composable。
 *
 * 解决的差距(P0/5.1):
 *   - EditView 500ms + RichEditor 800ms 两次防抖串联 → 最坏 1.3s 才落盘
 *   - 两处各持同名 `saveTimer`,易混
 *   - 切页 / 路由 leave / unmount 三处都要手动清定时器,容易漏
 *
 * 设计要点:
 *   - 单一防抖(默认 500ms,env.VITE_AUTO_SAVE_MS 可调,0 = immediate 便于 e2e)
 *   - 5 态 save 状态机:idle / pending / saving / saved / error
 *   - 本地 fingerprint dedup(getPatch() 返回值的稳定 JSON 序列化),
 *     跟服务端 isContentChange 双层去重,前端先拦掉撤销 / 空编辑 的 no-op PATCH
 *   - 首次 scheduleSave(对应 EditView hydration 触发的 watcher 首触发)
 *     被 `justHydrated` 拦截,顺手把当前内容当 baseline 写下,后续真实
 *     编辑才正常 arm 定时器
 *   - error 态 sticky:失败时保留旧 fingerprint,下次 scheduleSave 内容
 *     真的变化了才重试 —— 不让用户看到「保存中」瞬间闪一下又失败
 *   - **不再内置 idle snapshot timer**(Phase 5 砍掉)。snapshot 现在只在
 *     「编辑会话边界」打:进入 EditView 拿锁时(acquire)、释放锁时(release /
 *     route leave / unmount),由 EditView 在 usePageLock 的 onAcquire /
 *     onRelease 回调里调 snapshotPage —— 跟 lock 生命周期对齐,语义清晰。
 *     30s idle timer 砍掉理由:打字中途短暂停顿就打个 checkpoint,
 *     page_versions 噪声太大,且 snapshot 是给 restore 用的、
 *     用户极少主动点 restore,值不回成本。Phase 4 之前 idle snapshot
 *     还有用是因为 Phase 1-3 没有协同锁,「session 边界」不明显;
 *     协同锁引入后,session = lock 生命周期,直接绑 lock boundary
 *     是更准的边界。
 *   - onScopeDispose 自动 dispose,不需要 caller 记得清
 *   - pageId Ref 变化时重置全部内部状态(切页场景);reset 是同步的,
 *     在同一 tick 内后续 scheduleSave 看到的 justHydrated=true 是新页
 *     的「首次触发」,跟 EditView 的 watch [localTitle, localJSON, localHTML]
 *     注册顺序对齐(本 composable 在 setup 中先于该 watch 被调用)
 *
 * env 变量:
 *   - VITE_AUTO_SAVE_MS(默认 500):防抖窗口。设 0 立即保存,便于 e2e 测试
 *     不必等防抖 settle。**这是 power-wiki 第一个 VITE_* env 变量**,后续
 *     类似配置沿用同样模式:`import.meta.env.VITE_* ?? 默认值`
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { ApiError } from '@/lib/api'
import type { PageNode } from '@power-wiki/shared'

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface UsePageAutoSaveOptions {
  /**
   * 当前编辑的 page id。Ref 形式让 route 切换自动重置内部状态。
   * 允许 null —— EditView 新建页在 onMounted 拿到 clientId 之前是 null,
   * 此期间所有 save / snapshot 入口都 early-return(没有 id 可 PATCH)。
   */
  pageId: Ref<string | null>
  /**
   * 取最新 patch(PATCH /api/pages/:id 的 body)。每次防抖触发时调用。
   * 调用方负责过滤 dirty 字段 —— composable 不感知 content shape。
   * 在 scheduleSave / persistNow 时各调一次,值应一致(闭包读最新 refs)。
   */
  getPatch: () => Partial<PageNode>
  /**
   * 真正发起 PATCH。抛错 = 失败,composable 自动置 'error' 态。
   * 不抛错即视为成功,返回 void / PageNode 都行。
   */
  save: (patch: Partial<PageNode>) => Promise<unknown>
  /** 触发 snapshot(POST /api/pages/:id/snapshots)。失败 silent。 */
  snapshot: (changeNote?: string) => Promise<void>
  /** 防抖窗口 ms。默认 env.VITE_AUTO_SAVE_MS ?? 500。设 0 立即保存。 */
  debounceMs?: number
  /**
   * 空闲 snapshot 窗口 ms。默认 0(关闭)。
   *
   * Phase 5 起 snapshots 改在 lock acquire/release 边界打,不再走
   * 30s idle timer。此参数保留以备后续要恢复 idle 行为时不用改
   * 签名;默认 0 即关。传 30_000 可手动恢复旧的 30s 行为,但不建议
   * —— 见 doc 顶部「不再内置 idle snapshot timer」注释。
   */
  idleSnapshotMs?: number
}

export interface UsePageAutoSaveReturn {
  /** 当前保存状态。template 直接消费,UI 渲染对应的指示器。 */
  saveState: Ref<SaveState>
  /**
   * 最近一次成功 PATCH 的 unix-ms 时间戳。EditView 顶栏指示器用这个 + 一个
   * 30s tick 的 `now` 实时显示「已自动保存 · X 秒前」/「已同步 · X 分钟前」,
   * 让用户能直观判断「我刚才的修改是不是真的落盘了」(P0/5.3)。失败 PATCH
   * 不更新此值 —— error 态时 lastSavedAt 仍是「真的成功过」的时间,跟 isDirty
   * 互相印证(PATCH 失败 + lastSavedAt 是 5 分钟前 → 「最近 5 分钟的修改没
   * 落盘」的语义)。
   */
  lastSavedAt: Ref<number | null>
  /** 是否存在未保存修改。route-leave confirm 提示用这个 flag。 */
  isDirty: Ref<boolean>
  /**
   * 防抖触发 PATCH。无参 —— 自动用 getPatch() 拉最新值。
   * 标准 trailing debounce:已有挂起定时器时重新计时,连续输入期间不发。
   * 内容相对 lastSavedFingerprint 没变(例如用户键入后撤销) → 立即设
   * isDirty=false 并取消挂起的定时器,不会发空 PATCH。
   */
  scheduleSave: () => void
  /**
   * 立即取消定时器 + 同步 PATCH。route-leave / unmount 时调用。
   * 内部有 isFlushingOnLeave 守卫,并发调用安全。
   *
   * Phase 5 起 flushSave 不再补 boundary snapshot —— snapshot 100%
   * 走 lock boundary(EditView 的 onAcquire / onRelease 回调),flushSave
   * 唯一职责是保证 PATCH 落盘,避免离开页面时丢最后一次改动。hasUnsnapshottedEdits
   * 标志保留供 flushSnapshot 单独使用,但 flushSave 不再调它。
   */
  flushSave: () => Promise<void>
  /**
   * 成功 PATCH 后由 composable 内部调用 → arm idle setTimeout(若 idleSnapshotMs > 0)。
   * Phase 5 起 idleSnapshotMs 默认 0,这条退化成 no-op。保留接口以备
   * 后续要恢复 idle snapshot 时不用改 caller 签名。
   */
  scheduleSnapshot: () => void
  /**
   * 立即取消 idle snapshot 定时器 + 同步 snapshot(若仍有未 snapshot 的 edit)。
   * flushSave 已经包含这步,单独调用适用于「只想要 snapshot 不要 PATCH」的场景。
   */
  flushSnapshot: () => Promise<void>
  /** 清理所有定时器。onScopeDispose 会自动调,不需要 caller 手动调。 */
  dispose: () => void
}

function fingerprint(patch: Partial<PageNode>): string {
  const keys = Object.keys(patch).sort()
  const obj: Record<string, unknown> = {}
  for (const k of keys) {
    obj[k] = (patch as Record<string, unknown>)[k]
  }
  return JSON.stringify(obj)
}

function readDebounceMsFromEnv(fallback: number): number {
  if (typeof import.meta === 'undefined' || !import.meta.env) return fallback
  const raw = (import.meta.env as Record<string, unknown>)['VITE_AUTO_SAVE_MS']
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_IDLE_SNAPSHOT_MS = 0
const SAVED_HIDE_MS = 1_600

export function usePageAutoSave(opts: UsePageAutoSaveOptions): UsePageAutoSaveReturn {
  const {
    pageId,
    getPatch,
    save,
    snapshot,
    debounceMs = readDebounceMsFromEnv(DEFAULT_DEBOUNCE_MS),
    idleSnapshotMs = DEFAULT_IDLE_SNAPSHOT_MS,
  } = opts

  const saveState = ref<SaveState>('idle')
  const lastSavedAt = ref<number | null>(null)
  const isDirty = ref(false)

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let savedHideTimer: ReturnType<typeof setTimeout> | null = null
  let idleSnapshotTimer: ReturnType<typeof setTimeout> | null = null
  let lastSavedFingerprint: string | null = null
  let justHydrated = true
  let hasUnsnapshottedEdits = false
  let isFlushingOnLeave = false

  function clearSaveTimer(): void {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }
  function clearSavedHideTimer(): void {
    if (savedHideTimer) {
      clearTimeout(savedHideTimer)
      savedHideTimer = null
    }
  }
  function clearIdleSnapshotTimer(): void {
    if (idleSnapshotTimer) {
      clearTimeout(idleSnapshotTimer)
      idleSnapshotTimer = null
    }
  }

  function flashSaved(): void {
    saveState.value = 'saved'
    clearSavedHideTimer()
    savedHideTimer = setTimeout(() => {
      if (saveState.value === 'saved') saveState.value = 'idle'
    }, SAVED_HIDE_MS)
  }

  function scheduleIdleSnapshot(): void {
    if (idleSnapshotMs <= 0) return
    clearIdleSnapshotTimer()
    idleSnapshotTimer = setTimeout(async () => {
      // timer fire 时如果 pageId 变了(切页 / 卸载)或 hasUnsnapshottedEdits
      // 已被外部清掉,直接退出。
      if (!pageId.value || !hasUnsnapshottedEdits) return
      try {
        await snapshot()
        hasUnsnapshottedEdits = false
      } catch {
        // 静默。失败只是少一个 checkpoint,用户下次的 snapshot 还会
        // 自然触发;store 已经弹过 ui().setError 才到这里的。
      }
    }, idleSnapshotMs)
  }

  async function persistNow(): Promise<boolean> {
    if (!pageId.value) return false
    const patch = getPatch()
    const fp = fingerprint(patch)
    if (fp === lastSavedFingerprint) {
      // 内容相对上次 PATCH 没变(可能用户键入又撤销,也可能 hydration
      // 后第一次 scheduleSave 走这条)→ 跳过 API 调用,但仍标 saved
      // 让 UI 走完整进度反馈。
      isDirty.value = false
      return true
    }
    try {
      await save(patch)
      lastSavedFingerprint = fp
      lastSavedAt.value = Date.now()
      isDirty.value = false
      // Phase 5:不再调 scheduleIdleSnapshot() —— snapshot 在 lock acquire/
      // release 边界打(EditView 的 onAcquire/onRelease)。这里仍记
      // hasUnsnapshottedEdits=true,留给 route-leave 时 flushSnapshot 兜底
      // (用户写完字没等边界就 tab close / 刷新)。
      hasUnsnapshottedEdits = true
      return true
    } catch (e) {
      // M13+ 协同删除 race 收口:not_found(后端返 404,page 已被软删/硬删)
      // 走 pagesStore.updatePage 兜底处理(弹 notify + router.replace('/')),
      // 这里不要再 sticky 一个 'error' saveState —— 用户已经离开编辑器,
      // 显示「保存失败」banner 是误导。短路返回 false,后续 scheduleSave
      // 不会再来(组件卸载路径),即便来也会在 pageId 变化/不上时自然消停。
      // 把 saveState 拉回 'idle' 而非 'saving' —— 此时 saveState 已在
      // persistNow 前被 caller 设为 'saving'(flushSave / setTimeout 防抖),
      // 不主动清会导致 EditView 销毁前的最后一帧渲染出「正在保存」假指示。
      if (e instanceof ApiError && e.code === 'not_found') {
        saveState.value = 'idle'
        return false
      }
      // 保留旧 fingerprint(避免 error 状态下 fingerprint 被清空),
      // 下次 scheduleSave 仍走原 fingerprint 对比,内容真的变化才重试。
      // 'error' 态 sticky,不自动清 —— 下次成功的 PATCH 会把它
      // 推回 'saving' → 'saved'。
      saveState.value = 'error'
      return false
    }
  }

  function scheduleSave(): void {
    if (justHydrated) {
      // 首次 scheduleSave 对应 EditView 的 hydration watcher 首触发:
      // 此刻用户没编辑,把当前 getPatch() 当 baseline 写下,后续真
      // 实编辑才正常 arm 定时器。
      justHydrated = false
      lastSavedFingerprint = fingerprint(getPatch())
      isDirty.value = false
      return
    }
    const fp = fingerprint(getPatch())
    if (fp === lastSavedFingerprint) {
      // 用户键入后撤销回原值 → 取消挂起定时器,不发空 PATCH。
      isDirty.value = false
      clearSaveTimer()
      return
    }
    isDirty.value = true
    // 'saving' / 'saved' 期间不覆盖,避免「正在保存」被「有未保存的修改」打回去。
    if (saveState.value !== 'saving' && saveState.value !== 'saved') {
      saveState.value = 'pending'
    }
    clearSaveTimer()
    saveTimer = setTimeout(async () => {
      saveState.value = 'saving'
      const ok = await persistNow()
      if (ok) flashSaved()
    }, debounceMs)
  }

  async function flushSnapshot(): Promise<void> {
    if (!pageId.value) return
    clearIdleSnapshotTimer()
    if (hasUnsnapshottedEdits) {
      try {
        await snapshot()
        hasUnsnapshottedEdits = false
      } catch {
        /* silent */
      }
    }
  }

  async function flushSave(): Promise<void> {
    if (!pageId.value) return
    if (isFlushingOnLeave) return
    // 同时取消 save + snapshot 定时器,避免正在 flush 时定时器又 fire。
    clearSaveTimer()
    clearIdleSnapshotTimer()
    isFlushingOnLeave = true
    try {
      // Phase 5:flushSave 只保证 PATCH 落盘 —— 不再补 boundary snapshot。
      // snapshot 走 lock acquire/release 边界(EditView onAcquire /
      // onRelease 回调),flushSave 调 snapshot 会跟 release 路径撞车,
      // 同一次 leave 触发两次 page_versions 写入。isDirty 仍用,因为
      // auto-save 防抖触发期间 isDirty 已被翻回 false,但用户可能在
      // 防抖窗口内(比如连续打字中)点了导航 —— 此时 isDirty=true
      // 表示有挂起的 PATCH,需要 persistNow 立即落盘。
      if (isDirty.value) {
        saveState.value = 'saving'
        const ok = await persistNow()
        if (ok) flashSaved()
      }
    } finally {
      isFlushingOnLeave = false
    }
  }

  function dispose(): void {
    clearSaveTimer()
    clearSavedHideTimer()
    clearIdleSnapshotTimer()
  }

  // pageId 变化时重置全部内部状态(对应 caller 切换编辑对象)。
  // 注册顺序保证:本 composable 在 EditView 的 [localTitle, localJSON,
  // localHTML] watch 之前注册 → 同一 tick 内 pageId watch 先 fire(重置),
  // 后者再 fire 时 justHydrated=true → 消费首次触发 + 写 baseline,
  // 跟 EditView 原本的 justHydrated 行为 1:1。
  watch(
    () => pageId.value,
    () => {
      clearSaveTimer()
      clearSavedHideTimer()
      clearIdleSnapshotTimer()
      saveState.value = 'idle'
      lastSavedAt.value = null
      isDirty.value = false
      lastSavedFingerprint = null
      hasUnsnapshottedEdits = false
      justHydrated = true
    },
  )

  onScopeDispose(dispose)

  return {
    saveState,
    lastSavedAt,
    isDirty,
    scheduleSave,
    flushSave,
    scheduleSnapshot: scheduleIdleSnapshot,
    flushSnapshot,
    dispose,
  }
}
