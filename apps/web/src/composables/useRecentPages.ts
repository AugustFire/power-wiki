/**
 * useRecentPages — per-user 最近访问的页面。
 *
 * M2 改造:
 *   - server 是 source of truth(`user_recent_pages` 表,PUT /api/users/me/recent/:id
 *     upsert,GET /me/recent 拉取)
 *   - localStorage 保留作 offline cache(首屏渲染立即可用,refresh 后再
 *     用 server 真值覆盖)
 *   - 任意 view 调 `recordVisit({id, title})` 时双写:本地 reactive list
 *     立刻更新 + PUT /server fire-and-forget。ReadView mount 时同步调
 *     一次(详见 apps/web/src/views/ReadView.vue)。
 *
 * 模块级单例 — App.vue 任意 view 调 `recordVisit()`,HomeView 任意时刻
 * 读 `list`,通过 Vue 标准 reactivity 同步。登出时调 `clear()` 清掉
 * 当前用户的数据,避免下一个登入的用户看到前任的列表(server 端 DELETE
 * /me/recent 也会被调,真正的 source-of-truth 清理)。
 */
import { readonly, ref } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const KEY = 'power-wiki:recent-pages'
const MAX = 8

interface RecentEntry {
  id: string
  title: string
  visitedAt: number
}

function isValid(e: unknown): e is RecentEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.title === 'string' &&
    typeof r.visitedAt === 'number'
  )
}

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValid).slice(0, MAX)
  } catch {
    return []
  }
}

function save(list: RecentEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // localStorage 满了或被禁用 — 静默忽略,recents 是 nice-to-have
  }
}

const list = ref<RecentEntry[]>(load())

export function useRecentPages() {
  /**
   * M2: 启动 / sign-in 后从 server 拉一次真值覆盖本地缓存。
   * 失败 / 未登录时静默保留 localStorage(offline cache)。
   * 调用方应在 auth.status === 'ready' 后调一次。
   */
  async function syncFromServer(): Promise<void> {
    const auth = useAuthStore()
    if (!auth.user) return
    try {
      const { items } = await api.users.me.recent.list({ limit: 50 })
      const next: RecentEntry[] = items.slice(0, MAX).map((p) => ({
        id: p.id,
        title: p.title,
        visitedAt: p.updatedAt,
      }))
      list.value = next
      save(next)
    } catch {
      // 失败时保留 localStorage,不影响 UI 渲染
    }
  }

  function recordVisit(page: { id: string; title: string }): void {
    if (!page.id || !page.title) return
    // 移到最前 + 去重 + 截断。Date.now() 而不是去重旧 visitedAt,保证
    // 重新访问时刷新"刚刚"。
    const next: RecentEntry[] = [
      { id: page.id, title: page.title, visitedAt: Date.now() },
      ...list.value.filter((e) => e.id !== page.id),
    ].slice(0, MAX)
    list.value = next
    save(next)

    // M2: 双写 server。fire-and-forget — 不 await,ReadView mount / 路由
    // 跳转都不应该等这个 PUT。401 (signed out) / 网络错误静默,本地 list
    // 仍是真值,下次 syncFromServer 会覆盖。
    const auth = useAuthStore()
    if (!auth.user) return
    void api.users.me.recent
      .record(page.id, page.title)
      .catch(() => {
        // 静默,recents 是 nice-to-have
      })
  }

  function remove(id: string): void {
    const next = list.value.filter((e) => e.id !== id)
    list.value = next
    save(next)
    // M2: server 端没有 DELETE single row 端点(只 DELETE /me/recent 整清);
    // 单条删除是 UI 行为(如 trash 联动),不需要同步 server —— 自然
    // 90 天 TTL / visited_at 滚动会把它顶出 top-N。
  }

  function clear(): void {
    list.value = []
    save([])
    // M2: 同步清 server 端整 recent history。fire-and-forget。
    const auth = useAuthStore()
    if (!auth.user) return
    void api.users.me.recent.clear().catch(() => {
      // 静默
    })
  }

  return {
    list: readonly(list),
    recordVisit,
    remove,
    clear,
    syncFromServer,
  }
}