/**
 * useRecentSlashItems — 斜杠菜单「最近使用」置顶.
 *
 * 复用 useRecentPages 的形状但简化:
 *   - 纯 localStorage,无 server 同步(CLAUDE.md 避免 localStorage/DB 双源
 *     drift;slash recents 没有对应的 DB 表,纯本地偏好合情合理)
 *   - MAX=5:slash 菜单 15 项里挑 5 个最常用够用,多了视觉拥挤
 *   - 不接 useAuthStore:纯个人偏好,跟登录用户无关
 *   - 模块级单例:任何 view 调 recordUse,SlashMenu 通过 recents.value 同步读
 *
 * 「最近使用」区只展示当前还存在的 id(SlashMenu.vue 渲染时按 id 查 items,
 * 找不到就跳过)。废弃 id 在 recordUse 时直接忽略,不会被写入。
 */
import { readonly, ref } from 'vue'

const KEY = 'power-wiki:recent-slash-items'
const MAX = 5

type SlashItemId = string

/**
 * 当前 15 个 slash 项的合法 id 白名单。recordUse 时校验,避免外部脏数据
 * 写入 localStorage。增删 slash 项时同步改这里(只是过期不会崩,只是
 * 「最近使用」里看不到)。
 */
const KNOWN_IDS: ReadonlySet<SlashItemId> = new Set([
  'h1', 'h2', 'h3',
  'ul', 'ol', 'task',
  'table', 'code', 'quote', 'divider',
  'callout', 'toggle',
  'attachment', 'pageRef', 'at',
])

function isValid(id: unknown): id is SlashItemId {
  return typeof id === 'string' && KNOWN_IDS.has(id)
}

function load(): SlashItemId[] {
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

function save(list: SlashItemId[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // localStorage 满了或被禁用 — 静默忽略,recents 是 nice-to-have
  }
}

const list = ref<SlashItemId[]>(load())

export function useRecentSlashItems() {
  /**
   * 把 id 移到最前 + 去重 + 截断 MAX。未知 id 直接 ignore。
   * 触发时机:SlashMenu 选中 builtin 项后立即调;picker-needing 项
   * (attachment / pageRef / at)在 picker 完成路径调,「点了再取消」不会污染。
   */
  function recordUse(id: SlashItemId): void {
    if (!KNOWN_IDS.has(id)) return
    const next = [id, ...list.value.filter((x) => x !== id)].slice(0, MAX)
    list.value = next
    save(next)
  }

  function clear(): void {
    list.value = []
    save([])
  }

  return {
    recents: readonly(list),
    recordUse,
    clear,
  }
}