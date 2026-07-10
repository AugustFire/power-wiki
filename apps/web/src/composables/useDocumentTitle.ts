/**
 * useDocumentTitle — 响应式 document.title。
 *
 * 用法:
 *   useDocumentTitle(() => '登录')                         // "登录"
 *   useDocumentTitle(() => page.value?.title)              // "页面名"
 *   useDocumentTitle(() => page.value ? `编辑: ${page.value.title}` : null)
 *
 * getter 返回 string → 直接用 string
 * getter 返回 null/undefined/空串 → 用 BASE("power-wiki · 团队知识库")
 *
 * 早期版本(2026-07)有 `${name} · power-wiki` 后缀;砍掉是因为浏览器 tab
 * 里已经有 favicon 标识 brand,后缀属于冗余,占用 12 字符的 tab 空间却
 * 没带来识别收益 — 多 wiki / 多 tab 用户反而更想看完整 page name。
 *
 * 用 watchEffect 跑,自动响应 getter 内 reactive 依赖 — page.value 从
 * undefined 变成 "Hello" 时,标题也会跟着从 BASE 切到 "Hello",不需要
 * 手动 watch。
 *
 * 卸载时 stop,不会留尾巴到下一个 view。
 *
 * 跟 `exportPage.ts` 里临时改 document.title 配合 print 流程不冲突 —
 * 那个临时改在 print 回调里同步发生,print 结束立刻恢复原值,composable
 * 下次 tick 会再次覆盖(因为 getter 是 reactive 的)。
 */
import { onScopeDispose, watchEffect } from 'vue'

const BASE = 'power-wiki · 团队知识库'

export function useDocumentTitle(
  getter: () => string | null | undefined,
): void {
  const stop = watchEffect(() => {
    const t = getter()
    const next = t && t.trim() ? t.trim() : BASE
    if (document.title !== next) document.title = next
  })
  onScopeDispose(stop)
}
