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
    <span class="presence-prefix presence-prefix-edit" aria-hidden="true">
      <span class="material-symbols-outlined presence-icon">edit</span>
      <span class="presence-label">正在编辑</span>
    </span>
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
      />
      <span v-if="overflowEditors > 0" class="presence-overflow">+{{ overflowEditors }}</span>
    </span>
  </span>
  <!-- viewers 段:渲染在 editors 之后,语义独立 -->
  <span
    v-if="viewers.length > 0"
    class="presence-avatars"
    :title="`${viewers.length} 人正在看`"
  >
    <span class="presence-prefix" aria-hidden="true">
      <span class="material-symbols-outlined presence-icon">visibility</span>
      <span class="presence-label">正在看</span>
    </span>
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
      />
      <span v-if="overflowViewers > 0" class="presence-overflow">+{{ overflowViewers }}</span>
    </span>
  </span>
</template>

<style scoped>
.presence-avatars {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* 让头像部分重叠,Confluence / Notion 风格 */
}
.presence-prefix {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  /* 前缀与头像之间留白,跟 byline 中其他 metadata 项(12px gap)节奏一致 */
}
/* 「正在编辑」前缀用 danger 色,跟 LockBanner 一致 —— 让 user 一眼看到
   「有人在改我的 page」,而「正在看」只是 metadata 装饰。 */
.presence-prefix-edit {
  color: var(--danger);
}
.presence-icon {
  font-size: 18px;
  line-height: 1;
  /* 跟 👍 同一套 Material Symbols variation:18px 字形大小 + opsz 20 命中
     标准 visual size,字重 400 = outlined 默认。两个 icon 在 byline 同一
     行里视觉重量一致,不会一个胖一个瘦。

     视觉权重再比 👍(wght 400 outlined)略重一档 —— wght 500 让眼睛更醒
     目,跟前缀一起表达「这是 live 状态指示器」,不只是 metadata。 */
  font-variation-settings: 'FILL' 0, 'wght' 500, 'GRAD' 0, 'opsz' 20;
}
.presence-label {
  letter-spacing: 0;
}
.presence-stack {
  display: inline-flex;
  align-items: center;
}
.presence-stack > :deep(.user-avatar) + :deep(.user-avatar) {
  margin-left: -6px;
  /* 重叠边描线,纯色背景才不显出底色 */
  box-shadow: 0 0 0 2px var(--surface-1);
}
.presence-overflow {
  margin-left: 4px;
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
}
</style>
