/**
 * usePinnedPages — per-user 已固定页面,跨空间 pin。
 *
 * 跟 useRecentPages 同款结构,模块级单例 + reactive list。
 *
 * 存储:localStorage 第一版,per-user key。**不上 server API** — P1-7
 * 范围只做"本地浏览器内的固定",跨设备同步留给后续。clear() 同步清
 * localStorage。
 *
 * 跟 useRecentPages 的关键差异:
 *   - key 是 per-user(`pinned-pages:<userId>`),因为不同账号不应混;
 *     recents 也应当 per-user(P1-7 不动,保留现状以免引入 regression)
 *   - 数据带 `spaceId`,点击 pinned 项时 sidebar 要切 active space
 *     才能让 page tree 跟过去
 *   - pinned 顺序按 pinnedAt DESC(最新固定的排前面)
 *
 * P1-7 用途:Sidebar 顶部「已固定」折叠区,展示当前 user pin 的页面,
 * 不区分 personal / shared(pin 跨空间一致性 — 见 plan "Personal Page
 * 与 Shared Page 的 UX 差异化" 章节)。
 *
 * Pin / unpin 触发点第一版:ReadView 顶部「更多操作」菜单(后续可加
 * PageTree 右键菜单)。不在 PageTree row 上加 hover pin 按钮 — 避免
 * hover 噪音。
 */
import { readonly, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

const MAX = 20

interface PinnedEntry {
  id: string
  title: string
  spaceId: string
  pinnedAt: number
}

function isValid(e: unknown): e is PinnedEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.title === 'string' &&
    typeof r.spaceId === 'string' &&
    r.spaceId.length > 0 &&
    typeof r.pinnedAt === 'number'
  )
}

function keyFor(userId: string): string {
  return `power-wiki:pinned-pages:${userId}`
}

function load(userId: string): PinnedEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValid).slice(0, MAX)
  } catch {
    return []
  }
}

function save(userId: string, list: PinnedEntry[]): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(list))
  } catch {
    // localStorage 满了或被禁用 — 静默忽略,pin 是 nice-to-have
  }
}

const list = ref<PinnedEntry[]>([])

/**
 * 已加载的 user id — load() 时设,logout / 切账号时 reset。
 * 避免 list 跟当前 user 不匹配(避免用户 A 看到用户 B 的 pin)。
 */
let loadedUserId: string | null = null

function ensureLoadedFor(userId: string): void {
  if (loadedUserId === userId) return
  list.value = load(userId)
  loadedUserId = userId
}

function reset(): void {
  list.value = []
  loadedUserId = null
}

export function usePinnedPages() {
  const auth = useAuthStore()
  watch(
    () => auth.user?.id ?? null,
    (userId) => {
      if (userId) ensureLoadedFor(userId)
      else reset()
    },
    { immediate: true },
  )

  /**
   * 检查 id 是否已 pin。ReadView 顶部 pin 按钮用这个决定渲染 pin vs unpin。
   */
  function isPinned(id: string): boolean {
    return list.value.some((e) => e.id === id)
  }

  /**
   * Pin / unpin 二选一(id 不存在则新增并移到最前,已存在则移除)。
   * 同步 localStorage。
   */
  function togglePin(page: { id: string; title: string; spaceId: string }): void {
    const auth = useAuthStore()
    const userId = auth.user?.id
    if (!userId) return
    ensureLoadedFor(userId)
    const idx = list.value.findIndex((e) => e.id === page.id)
    if (idx >= 0) {
      // 已 pin → unpin
      list.value = list.value.filter((e) => e.id !== page.id)
    } else {
      // 未 pin → 加到最前(最新固定的排前面),截断 MAX
      const entry: PinnedEntry = {
        id: page.id,
        title: page.title,
        spaceId: page.spaceId,
        pinnedAt: Date.now(),
      }
      list.value = [entry, ...list.value].slice(0, MAX)
    }
    save(userId, list.value)
  }

  /**
   * 显式 unpin(从 Sidebar 顶部「已固定」section 的「×」按钮触发)。
   */
  function unpin(id: string): void {
    const auth = useAuthStore()
    const userId = auth.user?.id
    if (!userId) return
    ensureLoadedFor(userId)
    if (!list.value.some((e) => e.id === id)) return
    list.value = list.value.filter((e) => e.id !== id)
    save(userId, list.value)
  }

  /**
   * 全清当前 user 的 pin(local dev / 设置抽屉的"清空"按钮预留)。
   */
  function clear(): void {
    const auth = useAuthStore()
    const userId = auth.user?.id
    if (!userId) return
    list.value = []
    save(userId, list.value)
  }

  return {
    list: readonly(list),
    isPinned,
    togglePin,
    unpin,
    clear,
    /** 测试用 — logout 后必须调一次,避免下一个 user 看到前任的 pin。 */
    _reset: reset,
  }
}