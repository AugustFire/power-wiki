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
const details = computed(() => state.value.details ?? [])
const requireText = computed(() => state.value.requireText ?? '')
const typedInput = ref('')
const canConfirm = computed(() => !requireText.value || typedInput.value === requireText.value)
const confirmText = computed(() => state.value.confirmText)
const cancelText = computed(() => state.value.cancelText)
const size = computed(() => state.value.size ?? 'default')

function onCancel() {
  typedInput.value = ''
  close(false)
}

function onConfirm() {
  if (!canConfirm.value) return
  typedInput.value = ''
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
          :class="{ danger: isDanger, wide: size === 'wide' }"
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
            <ul v-if="details.length" class="confirm-details">
              <li v-for="detail in details" :key="detail">{{ detail }}</li>
            </ul>
            <label v-if="requireText" class="confirm-typed">
              <span>请输入 <code>{{ requireText }}</code> 以确认</span>
              <input v-model="typedInput" type="text" autocomplete="off" />
            </label>
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
              :disabled="!canConfirm"
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
/* 宽尺寸变体 —— 用于 details[] 长或多行的场景(/manager/trash
 * 批量永久删除)。720px 接近 manager 后台表格的实际宽度,details
 * 列表在宽容器内换行更自然,不再被 420px 卡成「每行 5 个字」。*/
.confirm-dialog.wide {
  width: 720px;
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


.confirm-details {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}
.confirm-typed {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  color: var(--text-2);
  font-size: 13px;
}
.confirm-typed input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  color: var(--text-1);
  background: var(--bg);
}
.confirm-typed code {
  color: var(--text-1);
  font-family: var(--font-mono);
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

