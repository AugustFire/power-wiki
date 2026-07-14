<script setup lang="ts">
/**
 * UserPopover — 自定义 hover 气泡,替代浏览器原生 title tooltip.
 *
 * 设计动机:TocPanel 里关注者头像堆叠的 :title 属性触发的是浏览器原生
 * tooltip,延迟 ~1s,样式不可控,在快速 hover 时反应迟钝。这个组件用
 * 固定定位的卡片 + Teleport 到 body,延迟可调到 0,样式跟产品视觉对齐。
 *
 * 用法(典型 TocPanel 场景):
 *   <div v-for="w in watchers" :ref="el => setRef(w.id, el)">
 *     <UserAvatar ... @mouseenter="hovered = w.id" @mouseleave="hovered = null" />
 *     <UserPopover v-if="hovered === w.id" :name="w.name" :color="w.color"
 *                  :anchor="avatarRefs[w.id]" />
 *   </div>
 *
 * 注意:
 *   - 父组件用 v-if 控制挂载,组件挂载后立刻定位(下一次 rAF)
 *   - 显隐完全靠父组件 hover 状态管理,组件自己不做延迟逻辑
 *   - pointer-events: none 让气泡不挡鼠标穿透到下方元素
 *   - 不做滚动跟随:页面内容滚动时气泡会"留在原地",符合 Notion / Linear
 *     的 hover popover 习惯(用户已 hover 完锚点开始读气泡时,内容滚动
 *     是常见的副作用)
 */
import { computed, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    color?: string
    avatarSize?: number
    anchor?: HTMLElement | null
  }>(),
  { color: 'var(--text-3)', avatarSize: 20, anchor: null },
)

const popRef = ref<HTMLElement | null>(null)
const style = ref<{ top: string; left: string }>({ top: '0px', left: '0px' })

const initials = computed(() => {
  const trimmed = props.name.trim()
  if (!trimmed) return '?'
  // 跟 UserAvatar 同套:短无空格标签按字面大写;否则取前两个 token 首字母。
  if (trimmed.length <= 3 && !/\s/.test(trimmed)) return trimmed.toUpperCase()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
})

function position() {
  const anchor = props.anchor
  const pop = popRef.value
  if (!anchor || !pop) return
  const aRect = anchor.getBoundingClientRect()
  const pRect = pop.getBoundingClientRect()
  const GAP = 8
  const vw = window.innerWidth
  const vh = window.innerHeight

  // 默认浮在 anchor 上方,空间不够翻到下方
  let top = aRect.top - pRect.height - GAP
  if (top < 8) top = aRect.bottom + GAP

  // 水平居中,出 viewport 贴边
  let left = aRect.left + aRect.width / 2 - pRect.width / 2
  if (left < 8) left = 8
  if (left + pRect.width > vw - 8) left = vw - pRect.width - 8

  // 垂直兜底,避免下方也溢出
  if (top + pRect.height > vh - 8) top = Math.max(8, vh - pRect.height - 8)

  style.value = { top: `${top}px`, left: `${left}px` }
}

onMounted(() => position())
watch(() => props.anchor, () => requestAnimationFrame(() => position()))
</script>

<template>
  <Teleport to="body">
    <div
      ref="popRef"
      class="user-popover"
      :style="{ top: style.top, left: style.left }"
      role="tooltip"
    >
      <span
        class="up-avatar"
        :style="{
          width: avatarSize + 'px',
          height: avatarSize + 'px',
          background: color,
        }"
        aria-hidden="true"
      >{{ initials }}</span>
      <span class="up-name">{{ name }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
.user-popover {
  position: fixed;
  z-index: var(--z-popover, 1000);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg, #fff);
  color: var(--text-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-md);
  font-size: var(--text-sm, 13px);
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
  animation: up-fade 120ms cubic-bezier(0.16, 1, 0.3, 1);
}
.up-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 9px;
  color: var(--text-invert);
  font-weight: 600;
  flex-shrink: 0;
}
.up-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
@keyframes up-fade {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>