/**
 * usePresetAvatars — M11 v2 预设头像清单 client。
 *
 * 后端 GET /api/avatars/presets 运行时扫 apps/web/public/avatars/ 目录,
 * 这里拿清单,模块顶层 fetch + cache,SettingsDrawer grid + UserAvatar
 * 渲染都从这拿。
 *
 * 设计要点:
 *  - 模块顶层 fetch(SPA 无 SSR 风险)。同进程多组件调用共享 `pending`
 *    promise,只 fetch 一次。
 *  - 失败 / 网络错 → `pending` 清掉 + 返空 map,下次调用会重试。
 *  - `presetFileSync(slug)` 同步函数,UserAvatar 内部用 —— 渲染时拿不到
 *    promise(组件是同步路径),fallback `${slug}.svg` 给 cache 还没
 *    ready 的窗口期。错的扩展名 → 404 → `<img @error>` 兜底回 initials。
 *  - cache ready 后 next tick 自动 re-render,UserAvatar 走正确 file。
 */
import { computed, ref, type ComputedRef } from 'vue'

export interface PresetAvatar {
  slug: string
  file: string
  mime: string
}

let pending: Promise<Record<string, string>> | null = null

function fetchOnce(): Promise<Record<string, string>> {
  if (!pending) {
    pending = fetch('/api/avatars/presets')
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ presets: PresetAvatar[] }>)
          : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((j) => Object.fromEntries(j.presets.map((p) => [p.slug, p.file])))
      .catch((err) => {
        console.warn('[usePresetAvatars] fetch failed', err)
        // 清 pending 让下次重试(模块级 cache 不能一直卡在失败态)
        pending = null
        return {} as Record<string, string>
      })
  }
  return pending
}

const fileMapCache = ref<Record<string, string>>({})

/** 同步查询 slug → file;cache 未 ready 时返 fallback `${slug}.svg`。
 *  UserAvatar 内部用 —— 渲染时是同步路径,等不了 promise。错的扩展名
 *  → 404 → `<img @error>` 兜底回 initials,设计上是 fail-soft。 */
export function presetFileSync(slug: string): string {
  return fileMapCache.value[slug] ?? `${slug}.svg`
}

export function usePresetAvatars(): { presets: ComputedRef<PresetAvatar[]> } {
  // 触发 fetch(共享 cache,只一次)
  void fetchOnce().then((m) => {
    fileMapCache.value = m
  })

  const presets = computed<PresetAvatar[]>(() =>
    Object.entries(fileMapCache.value).map(([slug, file]) => ({
      slug,
      file,
      mime: '',
    })),
  )

  return { presets }
}
