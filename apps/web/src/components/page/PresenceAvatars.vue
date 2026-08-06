<!--
  PresenceAvatars —— ReadView byline 上 awareness-only 的「谁正在看」头像组。

  Phase 1(2026-08-05):只渲染 awareness 状态里的 user 列表。
    - 上限 5 个头像,溢出显示 +N
    - 不带 tooltip 浮窗(awareness 头像纯装饰,内网 R&D 工具不引 a11y)
    - 不显示「我」 —— caller 用 clientId 过滤后传入

  Phase 2 将在 cursor awareness 加 hover 高亮(知道光标在哪一行);
  Phase 4 在 lock 接管后给受让人画 ⚠ 图标。这里先做基础渲染,后续按需
  在 props 拓展 status / icon。

  Phase 6 (2026-08-06):加 👁 正在看 前缀。ReadView byline 上同时出现
  WhoLikedList(已赞的人,带「👍 赞」按钮)和 PresenceAvatars(正在看的人),
  两组都是 20px 重叠圆头像,user 分不清哪组是「赞过」哪组是「正在看」。
  Presence 加眼睛 icon + 文字前缀 + 与 reactions 之间加分隔条(ReadView
  那边的 .byline-divider),让两组一眼分开。WhoLikedList 已经有 👍 按钮
  兜底语义,不需要再加前缀。

  Phase 7 (2026-08-06):byline 风格统一 ②。三组 clusters(👍 likes / ✏
  editing / 👁 viewing)统一成「纯 icon + 数字 + 头像」,不再挂 inline 文字
  label。PresenceAvatars 这边把 "正在编辑" / "正在看" label span 砍掉,
  icon 后挂一个数字(跟 👍 按钮后的数字同款:tabular-nums + min-width 12 +
  count-pop 动画),再跟头像组。语义靠 hover tooltip(outer span 的
  `title=`)兜底 —— byline 是 metadata 行,常驻文字 label 太冗余,留 tooltip
  给想看清楚的人。

  Phase 8 (2026-08-06):byline 风格统一 ③。头像组的重叠方式 + overflow
  圆圈样式,跟 WhoLikedList 合并到 components.css 的 `.byline-stack-avatar`
  + `.byline-stack-overflow` 全局类。likes 跟 editing/viewing 现在用同一
  套视觉规则 —— 同样的 -6px 重叠、同样的 1.5px var(--bg) 描边、同样的
  overflow 圆圈。三组 clusters 在 byline 上是一套设计语言,不再各自维护。

  Phase 9 (2026-08-06):byline 风格统一 ④。editors 跟 viewers 之间补一根
  `·` 中点分隔符(两边都 > 0 才显示),跟 byline 主行的 likes ↔ viewers 中点
  对齐 —— 三组 clusters (👍 / 👁 / ✏)之间用同一套 12px gap + `·` 分隔符,
  视觉节奏统一。复用全局 `.dot` class,跟其他分隔符一个色调(--border-strong)。

  edit / view 区分由 icon 形状(✏ vs 👁)+ 颜色双通道承担:
    - editing ✏ --danger 红 —— 跟 LockBanner 同色系,语义连贯(接管/
      释放是真警示)。
    - viewing 👁 --accent 蓝 —— 跟「已赞」👍 active 同色,统一表达
      「live 状态指示器」。viewing 是被动行为,蓝色比红色低一档。
-->
<script setup lang="ts">
import { computed } from 'vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import type { AwarenessUserState } from '@/editor/collab/useCollabProvider'

const props = withDefaults(
  defineProps<{
    states: Map<number, AwarenessUserState>
    /** 本地 clientID,过滤自己。 */
    clientId: number | null
    /** 上限头像数,溢出 +N。默认 5。 */
    max?: number
  }>(),
  { max: 5 },
)

const others = computed(() => {
  const out: AwarenessUserState[] = []
  for (const [cid, st] of props.states) {
    if (cid === props.clientId) continue
    out.push(st)
  }
  // 同 user 多次连(多 Tab / 多设备)去重,clientID 不同的 entry 合并为 1。
  // 用 user.id 字典序,稳定排序。
  const dedup = new Map<string, AwarenessUserState>()
  for (const st of out) dedup.set(st.user.id, st)
  return Array.from(dedup.values()).sort((a, b) => a.user.id.localeCompare(b.user.id))
})

/**
 * 区分 view / edit(2026-08-06):
 *   - viewers:mode='view' 或 awareness 字段缺失(老 client 兼容)的 user。
 *   - editors:mode='edit' 的 user。
 *
 * 编辑中的人比只是观看的人更重要 —— 排序时 edit 优先,前缀 icon 也分两个。
 * 「正在编辑」前缀用 ✏️ + 红色,跟 LockBanner 同色系,语义连贯;
 * 「正在看」前缀用 👁 + accent 色,跟历史行为一致。
 */
const editors = computed(() => others.value.filter((s) => s.user.mode === 'edit'))
const viewers = computed(() => others.value.filter((s) => s.user.mode !== 'edit'))
const visibleEditors = computed(() => editors.value.slice(0, props.max))
const visibleViewers = computed(() =>
  viewers.value.slice(0, Math.max(0, props.max - visibleEditors.value.length)),
)
const overflowEditors = computed(() => Math.max(0, editors.value.length - visibleEditors.value.length))
const overflowViewers = computed(() => Math.max(0, viewers.value.length - visibleViewers.value.length))
</script>

<template>
  <!-- editors 段:render 第一组(最关键 —— 有人正在编辑此页) -->
  <span
    v-if="editors.length > 0"
    class="presence-avatars presence-editing"
    :title="`${editors.length} 人正在编辑`"
  >
    <span class="material-symbols-outlined presence-icon presence-icon-edit" aria-hidden="true">edit</span>
    <span :key="editors.length" class="presence-count">{{ editors.length }}</span>
    <span class="presence-stack">
      <UserAvatar
        v-for="st in visibleEditors"
        :key="`e-${st.user.id}`"
        :size="20"
        :color="st.user.color"
        :label="st.user.name"
        :avatar-kind="st.user.avatarKind"
        :avatar-ref="st.user.avatarRef"
        :user-id="st.user.id"
        class="byline-stack-avatar"
      />
      <span
        v-if="overflowEditors > 0"
        class="byline-stack-avatar byline-stack-overflow"
        :title="`${overflowEditors} 人未显示`"
      >+{{ overflowEditors }}</span>
    </span>
  </span>
  <!-- editors ↔ viewers 中点 —— 2026-08-06 byline 风格统一 ④。两边都 > 0 才
       显示,只有 viewers 或只有 editors 时不挂孤立的点。复用全局 `.dot` class
       (由 `.page-byline .dot { color: var(--border-strong); }` 着色),
       跟 byline 主行的 likes ↔ viewers 中点对齐。 -->
  <span
    v-if="editors.length > 0 && viewers.length > 0"
    class="dot"
    aria-hidden="true"
  >·</span>
  <!-- viewers 段:渲染在 editors 之后,语义独立 -->
  <span
    v-if="viewers.length > 0"
    class="presence-avatars"
    :title="`${viewers.length} 人正在看`"
  >
    <span class="material-symbols-outlined presence-icon presence-icon-view" aria-hidden="true">visibility</span>
    <span :key="viewers.length" class="presence-count">{{ viewers.length }}</span>
    <span class="presence-stack">
      <UserAvatar
        v-for="st in visibleViewers"
        :key="`v-${st.user.id}`"
        :size="20"
        :color="st.user.color"
        :label="st.user.name"
        :avatar-kind="st.user.avatarKind"
        :avatar-ref="st.user.avatarRef"
        :user-id="st.user.id"
        class="byline-stack-avatar"
      />
      <span
        v-if="overflowViewers > 0"
        class="byline-stack-avatar byline-stack-overflow"
        :title="`${overflowViewers} 人未显示`"
      >+{{ overflowViewers }}</span>
    </span>
  </span>
</template>

<style scoped>
.presence-avatars {
  display: inline-flex;
  align-items: center;
  /* 跟 .like-button 同款 gap,让「icon → 数字 → 头像」三件套的视觉节奏跟
     「👍 → 数字 → 头像」一致。byline 三组 clusters 是同一套设计语言。 */
  gap: 4px;
}
/* icon 颜色语义化:
     - editing ✏ --danger 红 —— 跟 LockBanner 同色系,语义连贯(接管/释放
       是真警示)。edit 比 view 更重要,红色自带视觉权重,一眼能锁定。
     - viewing 👁 --accent 蓝 —— 跟「已赞」👍 active 同色,统一表达「live
       状态指示器」(实时在场的某种活动)。viewing 是被动行为,不需要警示
       等级,蓝色比红色低一档。
   区分由 icon 形状(✏ vs 👁) + 颜色双通道承担。 */
.presence-icon {
  font-size: 18px;
  line-height: 1;
  /* 跟 👍 同一套 Material Symbols variation:18px 字形大小 + opsz 20 命中
     标准 visual size,wght 500 比 👍 outlined(wght 400)略重一档,让眼睛
     更醒目,跟前缀一起表达「这是 live 状态指示器」,不只是 metadata。
     FILL 0 = outlined,不跟 active 状态的 👍 filled 抢视觉重量。 */
  font-variation-settings: 'FILL' 0, 'wght' 500, 'GRAD' 0, 'opsz' 20;
}
.presence-icon-edit { color: var(--danger); }
.presence-icon-view { color: var(--accent); }

/* 数字样式跟 .like-count 对齐:tabular-nums 防数字宽度撑变形 + count-pop
   动画在数字变化时弹一下。颜色继承 byline 的 --text-3(灰),不被 icon 的
   红/蓝染色 —— 数字是「信息」,icon 是「语义」。 */
.presence-count {
  font-variant-numeric: tabular-nums;
  min-width: 12px;
  text-align: left;
  display: inline-block;
  animation: like-count-pop var(--duration-base) var(--ease-out);
}

.presence-stack {
  display: inline-flex;
  align-items: center;
}
</style>