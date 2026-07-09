<script setup lang="ts">
/**
 * Modal — 居中弹窗的 chrome(backdrop + esc + body 锁 + click-outside).
 *
 * 抽出共性是为了让 ConfirmDialog / CheatSheetModal / 其他自建 dialog 不必
 * 各自重写一套。视觉沿用既有 dialog 模式(backdrop blur + scale-in)
 *
 * 用法:
 *   <Modal v-model:open="show" title="导入文档">
 *     <p>…</p>
 *     <template #footer>
 *       <button class="btn primary" @click="confirm">确定</button>
 *     </template>
 *   </Modal>
 *
 * Slots:
 *   default    — 主体
 *   header     — 自定义头部(覆盖 title prop)
 *   footer     — 操作栏(默认不渲染)
 *
 * Props:
 *   open:          v-model:open 开关
 *   title:         简单标题,纯文本
 *   size:          'sm' 420 / 'md' 560 / 'lg' 760 / 'auto'(默认,自适应内容)
 *   closeOnBackdrop: 点 backdrop 关闭(默认 true);false 则只能 esc / 显式按钮
 */
import { computed, onBeforeUnmount, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    size?: 'sm' | 'md' | 'lg' | 'auto'
    closeOnBackdrop?: boolean
  }>(),
  { size: 'auto', closeOnBackdrop: true },
)
const emit = defineEmits<{
  'update:open': [open: boolean]
  close: []
}>()

function close(): void {
  emit('update:open', false)
  emit('close')
}

function onBackdrop(): void {
  if (props.closeOnBackdrop) close()
}

function onKey(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
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

const dialogClass = computed(() => {
  switch (props.size) {
    case 'sm':   return 'modal-dialog modal-sm'
    case 'md':   return 'modal-dialog modal-md'
    case 'lg':   return 'modal-dialog modal-lg'
    default:     return 'modal-dialog'
  }
})

const titleId = useId()
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="open" class="modal-backdrop" @mousedown.self="onBackdrop">
        <div
          :class="dialogClass"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title || $slots.header ? titleId : undefined"
          @mousedown.stop
        >
          <header v-if="title || $slots.header" class="modal-head">
            <slot name="header">
              <h2 :id="titleId" class="modal-title">{{ title }}</h2>
            </slot>
            <button
              type="button"
              class="modal-close"
              aria-label="关闭"
              @click="close"
            >
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>
          <div class="modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal-foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim-2);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 32px;
}
.modal-dialog {
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 64px);
  max-height: calc(100vh - 64px);
  overflow: hidden;
}
.modal-sm { width: 420px; }
.modal-md { width: 560px; }
.modal-lg { width: 760px; }

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 14px;
  flex-shrink: 0;
}
.modal-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
  line-height: 1.4;
}
.modal-close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.modal-close:hover { background: var(--hover-bg, #f4f5f7); }
.modal-close .material-symbols-outlined { font-size: 20px; }

.modal-body {
  padding: 0 24px 24px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.modal-foot {
  padding: 14px 24px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.modal-fade-enter-active, .modal-fade-leave-active {
  transition: opacity var(--duration-fast) ease;
}
.modal-fade-enter-active .modal-dialog,
.modal-fade-leave-active .modal-dialog {
  transition: transform var(--duration-base) var(--ease-out);
}
.modal-fade-enter-from, .modal-fade-leave-to { opacity: 0; }
.modal-fade-enter-from .modal-dialog,
.modal-fade-leave-to .modal-dialog {
  transform: translateY(-8px) scale(0.97);
}
</style>
