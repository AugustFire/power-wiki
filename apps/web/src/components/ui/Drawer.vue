<script setup lang="ts">
/**
 * Drawer — 右侧抽屉面板(NotificationBell 用,以及未来 comments drawer 等).
 *
 * 通用 chrome:teleport + 半透明 backdrop + ESC 关闭 + body 锁。
 * 内部内容由 caller 完全控制。
 *
 * 用法:
 *   <Drawer v-model:open="open" title="通知">
 *     <button @click="markAll">全部已读</button>
 *     <NotificationList … />
 *   </Drawer>
 *
 * Slots:
 *   default  — 主体
 *   header   — 自定义标题区(覆盖 title prop)
 *   actions  — header 右侧操作(在 close 按钮**之前**渲染,顺序:title / actions / close)
 *   footer   — 底部
 *
 * Props:
 *   open:   v-model:open
 *   title:  简单标题
 *   width:  抽屉宽度 px(默认 440)
 */
import { computed, onBeforeUnmount, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    width?: number
    /** aria-label 当没有 title 时 */
    label?: string
  }>(),
  { width: 440 },
)
const emit = defineEmits<{
  'update:open': [open: boolean]
  close: []
}>()

function close(): void {
  emit('update:open', false)
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') close()
}

let prevBodyOverflow = ''
watch(
  () => props.open,
  (open) => {
    if (open) {
      prevBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', onKey)
    } else {
      document.body.style.overflow = prevBodyOverflow
      document.removeEventListener('keydown', onKey)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  document.body.style.overflow = prevBodyOverflow
  document.removeEventListener('keydown', onKey)
})

const panelStyle = computed(() => ({ width: `${props.width}px` }))
const labelId = useId()
</script>

<template>
  <Teleport to="body">
    <Transition name="drw-backdrop">
      <div v-if="open" class="drw-backdrop" @click="close" />
    </Transition>
    <Transition name="drw-panel">
      <aside
        v-if="open"
        class="drw-panel"
        :style="panelStyle"
        role="dialog"
        :aria-label="title ?? label ?? labelId"
        :aria-labelledby="title || $slots.header ? labelId : undefined"
        aria-modal="true"
      >
        <header v-if="title || $slots.header" class="drw-head">
          <slot name="header">
            <h2 :id="labelId" class="drw-title">{{ title }}</h2>
          </slot>
          <slot name="actions" />
          <button
            type="button"
            class="drw-close"
            aria-label="关闭"
            @click="close"
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>
        <div class="drw-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="drw-foot">
          <slot name="footer" />
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drw-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim-1);
  z-index: 9998;
}
.drw-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  max-width: 100vw;
  background: var(--bg);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  z-index: 9999;
}
.drw-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.drw-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-1);
  margin: 0;
  flex: 1;
  min-width: 0;
}
.drw-close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.drw-close:hover { background: var(--hover-bg, #f4f5f7); }
.drw-close .material-symbols-outlined { font-size: 18px; }

.drw-body {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}
.drw-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.drw-backdrop-enter-active, .drw-backdrop-leave-active {
  transition: opacity 200ms ease;
}
.drw-backdrop-enter-from, .drw-backdrop-leave-to { opacity: 0; }

.drw-panel-enter-active, .drw-panel-leave-active {
  transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
}
.drw-panel-enter-from, .drw-panel-leave-to { transform: translateX(100%); }
</style>
