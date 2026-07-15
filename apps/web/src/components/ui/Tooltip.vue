<script setup lang="ts">
/**
 * Tooltip — hover 触发的简短提示.
 *
 * 按 CLAUDE.md Excluded H 的限制:**不做焦点 / 键盘触发**。鼠标 hover /
 * 离开触发即可,不参与 tab 序。
 *
 * 用法:
 *   <Tooltip text="新建页面">
 *     <button @click="create">＋</button>
 *   </Tooltip>
 *
 * position 默认 'top',撑不下时改用 'bottom' / 'left' / 'right'。long-text
 * 超 24 字自动换行,避免横向溢出。
 */
import { onBeforeUnmount, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    text: string
    position?: 'top' | 'bottom' | 'left' | 'right'
    /** Hover delay — ms,default 220 让 cursor 一闪而过时不抖 tip */
    delay?: number
  }>(),
  { position: 'top', delay: 220 },
)

const visible = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function show() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { visible.value = true }, props.delay)
}
function hide() {
  if (timer) { clearTimeout(timer); timer = null }
  visible.value = false
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <span
    class="ttp-wrap"
    @mouseenter="show"
    @mouseleave="hide"
  >
    <slot />
    <Transition name="ttp-fade">
      <span
        v-if="visible"
        class="ttp-tip"
        :class="[`ttp-tip-${position}`, { 'ttp-tip-rich': $slots.tooltip }]"
        role="tooltip"
      >
        <slot name="tooltip">{{ text }}</slot>
      </span>
    </Transition>
  </span>
</template>

<style scoped>
.ttp-wrap {
  position: relative;
  display: inline-flex;
}

.ttp-tip {
  position: absolute;
  z-index: 1100;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 4px 8px;
  background: var(--bg-code);
  color: var(--text-invert, #fff);
  font-size: 12px;
  line-height: 1.5;
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  pointer-events: none;
}
/* 当 tooltip 走具名 slot 时允许换行、多行(描述、标签组等)。 */
.ttp-tip-rich {
  white-space: normal;
  max-width: 280px;
  overflow-wrap: break-word;
}

.ttp-tip-top { bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
.ttp-tip-bottom { top: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
.ttp-tip-left { right: calc(100% + 6px); top: 50%; transform: translateY(-50%); }
.ttp-tip-right { left: calc(100% + 6px); top: 50%; transform: translateY(-50%); }

.ttp-fade-enter-active, .ttp-fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.ttp-fade-enter-from, .ttp-fade-leave-to { opacity: 0; }
</style>
