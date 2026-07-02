/**
 * useRecentPages — per-user 最近访问的页面(localStorage)。
 *
 * 设计选择:走 localStorage 而不是新建 `page_views` 表,理由:
 *   - 强烈 per-device(同一用户换浏览器 / 隐身窗口应该看不到对方的历史),
 *     这一点 localStorage 天然契合
 *   - 没有跨设备同步需求(没有用户提)
 *   - 不需要后端 round-trip,首页渲染时立即可用
 *   - v0 阶段省一张表 + 一个路由 + 一个 dispose hook;真要做"团队 recents"
 *     或"管理员看谁访问过"再升级成 server-side
 *
 * 模块级单例 — App.vue 任意 view 调 `recordVisit()`,HomeView 任意时刻
 * 读 `list`,通过 Vue 标准 reactivity 同步。登出时调 `clear()` 清掉
 * 当前用户的数据,避免下一个登入的用户看到前任的列表。
 */
import { readonly, ref } from 'vue'

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
  }

  function remove(id: string): void {
    const next = list.value.filter((e) => e.id !== id)
    list.value = next
    save(next)
  }

  function clear(): void {
    list.value = []
    save([])
  }

  return {
    list: readonly(list),
    recordVisit,
    remove,
    clear,
  }
}