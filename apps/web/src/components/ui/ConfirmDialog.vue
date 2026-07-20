<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useConfirm } from '@/composables/useConfirm'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useBodyLock } from '@/composables/useBodyLock'
import { useEscape } from '@/composables/useEscape'

const { state, close } = useConfirm()

const isDanger = computed(() => state.value.danger)
const title = computed(() => state.value.title)
const message = computed(() => state.value.message)
const confirmText = computed(() => state.value.confirmText)
const cancelText = computed(() => state.value.cancelText)

function onCancel() {
  close(false)
}

function onConfirm() {
  close(true)
}

// Esc 取消由 useEscape 处理;这里只兜 Enter 确认(Shift+Enter 留给多行 message)
function onKey(e: KeyboardEvent) {
  if (!state.value.open) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onConfirm()
  }
}

useBodyLock(() => state.value.open)
useEscape(() => state.value.open, onCancel)

// 打开时监听 Enter,关闭时摘掉
watch(
  () => state.value.open,
  (open) => {
    if (open) document.addEventListener('keydown', onKey)
    else document.removeEventListener('keydown', onKey)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
})

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap(dialogRef, () => state.value.open, {
  initialFocus: '[autofocus]',
})
</script>

<template>
  <Teleport to="body">
    <transition name="confirm-fade">
      <div v-if="state.open" class="confirm-backdrop" @mousedown.self="onCancel">
        <div
          ref="dialogRef"
          class="confirm-dialog"
          :class="{ danger: isDanger }"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          tabindex="-1"
          @mousedown.stop
        >
          <div class="confirm-icon">
            <span class="material-symbols-outlined">
              {{ isDanger ? 'delete' : 'help' }}
            </span>
          </div>
          <div class="confirm-body">
            <div id="confirm-title" class="confirm-title">{{ title }}</div>
            <div v-if="message" class="confirm-message">{{ message }}</div>
          </div>
          <div class="confirm-actions">
            <button class="btn ghost" type="button" @click="onCancel">
              {{ cancelText }}
            </button>
            <button
              class="btn"
              :class="isDanger ? 'danger' : 'primary'"
              type="button"
              autofocus
              @click="onConfirm"
            >
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim-2);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.confirm-dialog {
  width: 420px;
  max-width: calc(100vw - 32px);
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 24px;
  display: grid;
  grid-template-columns: 40px 1fr;
  grid-template-rows: auto auto;
  gap: 16px 16px;
  align-items: start;
}

.confirm-icon {
  grid-row: 1;
  grid-column: 1;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--bg-subtle);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-dialog.danger .confirm-icon {
  background: rgba(255, 86, 48, 0.12);
  color: var(--danger);
}
.confirm-dialog:not(.danger) .confirm-icon {
  background: var(--accent-soft);
  color: var(--accent);
}
.confirm-icon .material-symbols-outlined {
  font-size: 22px;
}

.confirm-body {
  grid-row: 1;
  grid-column: 2;
  min-width: 0;
}
.confirm-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.4;
  margin-bottom: 4px;
}
.confirm-message {
  font-size: 14px;
  color: var(--text-2);
  line-height: 1.5;
  word-break: break-word;
  /* message 支持换行 / 多段:用 \n\n 段落、\n 行。其它弹窗都是单行
     不带 \n,加这个不影响它们。 */
  white-space: pre-wrap;
}

.confirm-actions {
  grid-row: 2;
  grid-column: 2;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

/* 过渡动画 */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity var(--duration-fast) ease;
}
.confirm-fade-enter-active .confirm-dialog,
.confirm-fade-leave-active .confirm-dialog {
  transition: transform var(--duration-base) var(--ease-out);
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-from .confirm-dialog,
.confirm-fade-leave-to .confirm-dialog {
  transform: translateY(-8px) scale(0.97);
}
</style>

