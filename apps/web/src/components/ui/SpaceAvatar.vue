<script setup lang="ts">
/**
 * SpaceAvatar — 团队/个人空间身份标识。
 *
 * 收敛所有「空间身份渲染」到这一处,三处 chrome(顶栏触发 / 侧栏徽标 /
 * 切换器下拉项)以及其他未来用到的位置都走它。规则:
 *   - 背景 = space.color(token 兼容的 #RRGGBB)
 *   - 内容 = material-symbols-outlined icon;无 icon 时取 space.name 前两字符大写
 *   - 个人空间永远用 'cottage' 图标(产品定调,忽略 space.icon)
 *   - 形状:圆角方块(border-radius 3px),跟 Atlassian Atlas 一致
 *
 * 只读标记不在这里画 —— 20px 头像上叠角标 glyph 会糊成一团。只读 hint 由消费
 * 方在自己的行内表达(典型:Sidebar 在空间名旁挂一个 14px 的 lock 图标)。
 */
import { computed } from 'vue'
import type { Space } from '@power-wiki/shared'

type Size = 16 | 20 | 28 | 40

const props = withDefaults(
  defineProps<{
    space: Space | null
    size?: Size
    showName?: boolean
  }>(),
  { size: 28, showName: false },
)

const iconName = computed(() => {
  if (!props.space) return ''
  if (props.space.kind === 'personal') return 'cottage'
  return props.space.icon ?? ''
})

const initials = computed(() => {
  const name = props.space?.name?.trim() ?? ''
  if (!name) return ''
  // CJK 单字符已经够辨识;西文短单词才取前 2 个字母
  return /[一-鿿]/.test(name[0]) ? name[0] : name.slice(0, 2).toUpperCase()
})

const hasIcon = computed(() => iconName.value !== '')

const style = computed(() => {
  // 尺寸档位:图标的字号约为盒子尺寸 0.55,首字母字号约 0.42。
  const dim: Record<Size, { w: number; iconPx: number; initialPx: number }> = {
    16: { w: 16, iconPx: 11, initialPx: 8 },
    20: { w: 20, iconPx: 14, initialPx: 10 },
    28: { w: 28, iconPx: 16, initialPx: 12 },
    40: { w: 40, iconPx: 22, initialPx: 14 },
  }
  const c = dim[props.size]
  return {
    width: `${c.w}px`,
    height: `${c.w}px`,
    '--sa-icon-size': `${c.iconPx}px`,
    '--sa-init-size': `${c.initialPx}px`,
    background: props.space?.color ?? 'var(--accent)',
  } as Record<string, string>
})
</script>

<template>
  <span
    class="sa-wrap"
    :class="{ 'sa-with-name': showName }"
  >
    <span
      class="sa-box"
      :style="style"
      role="img"
      :aria-label="space?.name ?? ''"
    >
      <span v-if="hasIcon" class="material-symbols-outlined sa-icon">{{ iconName }}</span>
      <span v-else class="sa-initials">{{ initials }}</span>
    </span>
    <span v-if="showName && space" class="sa-name">{{ space.name }}</span>
  </span>
</template>

<style scoped>
.sa-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}
.sa-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm, 3px);
  color: white;
  font-weight: 700;
  user-select: none;
  line-height: 1;
  flex-shrink: 0;
}
.sa-icon {
  font-size: var(--sa-icon-size) !important;
  color: white;
}
.sa-initials {
  font-size: var(--sa-init-size);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: white;
}
.sa-name {
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
</style>