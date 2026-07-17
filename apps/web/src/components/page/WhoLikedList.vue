<script setup lang="ts">
/**
 * 谁赞了这个页 —— 在 byline 行展示点赞者头像组。
 *
 * 显示:最多 5 个 20px 圆形头像,如果有 > 5 人则叠加 "+N" 角标。
 * Hover:tooltip 显示 "X、Y、Z 和其他 N 人"(≤ 5 时直接列出所有人)。
 *
 * 数据来源:PageNode.likedBySample(后端 LEFT JOIN 拼好的前 5 人),如果
 * total ≤ sample.length,不需要"其他 N 人"那段。
 */
import { computed } from 'vue'
import type { PageNode } from '@power-wiki/shared'
import UserAvatar from '@/components/ui/UserAvatar.vue'

const props = defineProps<{ page: PageNode }>()

const sample = computed(() => props.page.likedBySample ?? [])
const total = computed(() => props.page.likesCount ?? 0)

/** 头像显示列表:实际人数 <= sample 长度 → 全显示;否则 sample 截断到 5 个 */
const visibleAvatars = computed(() => {
  const arr = sample.value
  if (arr.length <= 5) return arr
  return arr.slice(0, 5)
})

/** Tooltip 文案:
 *  - sample 已涵盖全部(total <= sample.length) → 直接拼名字
 *  - 总数 > sample.length → 加 "和其他 N 人"
 */
const tooltipText = computed(() => {
  const names = sample.value.map((u) => u.name ?? u.id).filter(Boolean)
  if (names.length === 0) return ''
  const others = Math.max(0, total.value - names.length)
  if (others === 0) return names.join('、')
  return `${names.join('、')} 和其他 ${others} 人`
})
</script>

<template>
  <span class="who-liked" v-if="total > 0">
    <span class="avatar-stack" :title="tooltipText">
      <UserAvatar
        v-for="u in visibleAvatars"
        :key="u.id"
        :size="20"
        :color="u.color ?? 'var(--text-3)'"
        :label="u.name ?? u.id"
        :avatar-kind="u.avatarKind ?? null"
        :avatar-ref="u.avatarRef ?? null"
        :user-id="u.id ?? null"
        class="stack-avatar"
      />
      <span
        v-if="total > visibleAvatars.length"
        class="stack-avatar stack-overflow"
        :title="tooltipText"
      >+{{ total - visibleAvatars.length }}</span>
    </span>
  </span>
</template>

<style scoped>
/* 头像组:横向堆叠 + 负 margin 制造重叠效果。
   放在 .page-reactions 行内,跟 like-button 用 flex gap 隔开,这里不再写 margin。 */
.who-liked {
  display: inline-flex;
  align-items: center;
}

.avatar-stack {
  display: inline-flex;
  align-items: center;
}
.stack-avatar {
  margin-left: -6px;
  border: 1.5px solid var(--bg);
  border-radius: 50%;
  /* UserAvatar 内部是圆形 div,这里再 inset 一圈描边 */
}
.stack-avatar:first-child {
  margin-left: 0;
}
.stack-overflow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  background: var(--bg-subtle);
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  font-variant-numeric: tabular-nums;
}
</style>