<script setup lang="ts">
/**
 * Breadcrumb — 统一面包屑渲染(P2 收口)。
 *
 * 此前子项目里有 4 套不同实现:
 *   - ReadView/EditView 走 useBreadcrumb + Teleport 到 #app-subheader
 *   - ActivityView/WatchedView/NotFoundView/PersonalHomeView/SpaceHomeView
 *     自己拼 <div class="breadcrumb"> + Teleport
 *   - HistoryView 走 left-actions + page-context + ·版本历史 三段混排
 *   - ManagerLayout/UserEditView/GroupEditView/SpaceEditView(manager 路径)
 *     在内容区自绘 <nav.se/ue/ge-breadcrumb> 三套不同 class
 *
 * 视觉上有 14px/13px 字号、8px/6px gap、text-2/accent 链接色、underline / soft-bg
 * hover 之分 —— 产品上看似都是「面包屑」,实际用户感受到 4 套不同控件。
 *
 * 收敛策略:
 *   - 「subheader」变体(默认)Teleport 到 #app-subheader,字号 14px、gap 8px,
 *     沿用 styles/components.css 的 .breadcrumb 规则。
 *   - 「bar」变体同样式但原地渲染,给自带 .subheader 的 ManagerLayout 用
 *     ——manager 分支没有 #app-subheader,teleport 无处可去。
 *   - 「inline」变体原地渲染,字号 13px、gap 6px、链接 accent 色,用于 manager
 *     详情页 / 后台子页。
 *   - 每段: { label, to?, icon? }; 折叠段: { ellipsis: true }。
 *   - #current 插槽让上层覆盖最后一段(EditView 的「未命名 · 点此重命名」按钮、
 *     SpaceHomeView 的 lock icon 等 view-specific 行为都走这里,组件本身保持纯)。
 */
import { computed, inject, type Ref } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'

export interface BreadcrumbSegment {
  label: string
  to?: RouteLocationRaw
  /** Material Symbols 图标名;跟在 label 后面,跟文字同段渲染 */
  icon?: string
}

export interface BreadcrumbEllipsis {
  ellipsis: true
}

export type BreadcrumbItem = BreadcrumbSegment | BreadcrumbEllipsis

const props = withDefaults(
  defineProps<{
    segments: BreadcrumbItem[]
    /** 'subheader': Teleport 到 #app-subheader(默认);'bar': 原地渲染但同样式;
     *  'inline': 原地渲染,小一号 */
    variant?: 'subheader' | 'bar' | 'inline'
  }>(),
  { variant: 'subheader' },
)

defineSlots<{
  current?: (props: { segment: BreadcrumbSegment }) => unknown
}>()

/** type guard:在模板里把 BreadcrumbEllipsis 窄化掉,避免访问 .to / .label 报 TS2339。 */
function isEllipsis(item: BreadcrumbItem): item is BreadcrumbEllipsis {
  return 'ellipsis' in item && item.ellipsis === true
}

function isLast(i: number): boolean {
  return i === props.segments.length - 1
}

/** AppShell inject 的 subheader DOM ref —— 优先用它做 Teleport target,
 *  跳过 querySelector,避免 manager → workspace 路由切换时 #app-subheader
 *  还没渲染就 mount 后代组件的时序赛跑(同 right-rail 注释)。
 *
 * 跟 right-rail 同款:<Teleport v-if="targetEl" :to="targetEl">,
 *  ref 是 null(manager 路由 / boot 阶段)就不 render Teleport,等下一帧
 *  workspace 分支 mount、ref 赋值后下次 reactive 更新再触发。 */
const subheaderRef = inject<Ref<HTMLElement | null> | null>('appSubheader', null)
const targetEl = computed<HTMLElement | null>(() => subheaderRef?.value ?? null)

/** 只有 subheader 变体真的 teleport;bar / inline 用 Teleport 的 disabled 原地
 *  渲染同一份 markup,避免两套模板漂移。disabled 时 Vue 不会解析 target,
 *  传 null 也不会 warn。 */
const teleporting = computed(() => props.variant === 'subheader')
</script>

<template>
  <Teleport
    v-if="!teleporting || targetEl"
    :to="targetEl"
    :disabled="!teleporting"
  >
    <nav
      class="breadcrumb"
      :class="{ 'breadcrumb-inline': variant === 'inline' }"
      role="navigation"
      aria-label="面包屑导航"
    >
      <template v-for="(seg, i) in segments" :key="`s-${i}`">
        <span v-if="i > 0" class="sep" aria-hidden="true">/</span>
        <span
          v-if="isEllipsis(seg)"
          class="crumb-item ellipsis"
          title="中间层级省略"
        >…</span>
        <RouterLink
          v-else-if="!isLast(i) && seg.to"
          :to="seg.to"
          class="crumb-item crumb-link"
        >
          {{ seg.label }}
          <span
            v-if="seg.icon"
            class="material-symbols-outlined crumb-icon"
            :title="seg.icon"
          >{{ seg.icon }}</span>
        </RouterLink>
        <span
          v-else-if="!isLast(i)"
          class="crumb-item"
        >{{ seg.label }}</span>
        <slot v-else name="current" :segment="seg">
          <span class="crumb-item current">
            {{ seg.label }}
            <span
              v-if="seg.icon"
              class="material-symbols-outlined crumb-icon"
              :title="seg.icon"
            >{{ seg.icon }}</span>
          </span>
        </slot>
      </template>
    </nav>
  </Teleport>
</template>

<style scoped>
/* Inline 变体:在内容区自绘的后台子页面包屑。沿用 .breadcrumb 的布局但
   字号 / 间距 / 颜色调亮一档,跟放在 subheader 里的浅色面包屑区分。 */
.breadcrumb-inline {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-3);
  gap: 6px;
}
.breadcrumb-inline .crumb-item { color: var(--text-3); }
.breadcrumb-inline .crumb-item.crumb-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: 3px;
  transition: background var(--duration-fast) var(--ease-out);
}
.breadcrumb-inline .crumb-item.crumb-link:hover {
  background: var(--accent-soft, #DEEBFF);
  text-decoration: none;
}
.breadcrumb-inline .crumb-item.current {
  color: var(--text-2);
  font-weight: 500;
}
.breadcrumb-inline .crumb-item.ellipsis { color: var(--text-3); }

.crumb-icon {
  font-size: 16px;
  vertical-align: -3px;
  margin-left: 4px;
}
</style>
