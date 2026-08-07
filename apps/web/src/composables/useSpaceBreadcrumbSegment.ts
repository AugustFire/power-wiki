/**
 * useSpaceBreadcrumbSegment — 渲染 subheader 面包屑第一段需要的「当前空间」
 * 锚点。ReadView / EditView / HistoryView 等 /p/:id 视图过去写死
 * `{ label: '我的知识库', to: '/' }` —— 用户从邮件拿到 /p/abc 直链进
 * 来时,面包屑第一段是「我的知识库」,跟所在的空间没关系,
 * 切到 PersonalHomeView / 团队空间 / 切换空间用户都得回头看顶栏 trigger
 * 才能确认在哪。
 *
 * 本帮 composable 把这个 segment 换成 active space:团队空间显示
 * 「Corporate + 空间名」,个人空间显示「lock_person + 个人空间名」。
 * ReadView / EditView / HistoryView 三处 [P0-1] 都引这一份,后续
 * onboarding / 快捷入口也跟着同一份事实来源。
 *
 * active 还没 hydrate(冷启动首帧):返回 null,caller 不 prepend,
 * 让原 page-chain 自然落地 —— 比「我的知识库」更差,但不会突然
 * 增加 dropdown/popover 的闪烁。
 */
import { computed, type ComputedRef } from 'vue'
import type { BreadcrumbItem } from '@/components/ui/Breadcrumb.vue'
import { useSpacesStore } from '@/stores/spaces'

export function useSpaceBreadcrumbSegment(): ComputedRef<BreadcrumbItem | null> {
  const spacesStore = useSpacesStore()
  return computed<BreadcrumbItem | null>(() => {
    const s = spacesStore.activeSpace.value
    if (!s) return null
    return {
      label: s.name,
      to: '/',
      // 个人空间挂 lock_person 图标,跟 trigger 上的 ss-private-badge
      // / SpaceSwitcher dropdown row 的 visual symbol 保持一致;
      // 团队空间不加 icon(触发按钮上的头像已经在那一行了,这里再
      // 加就重复了),让头像承担 kind 区分,文本「团队空间名」就够。
      icon: s.kind === 'personal' ? 'lock_person' : undefined,
    }
  })
}
