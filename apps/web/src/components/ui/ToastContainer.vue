<script setup lang="ts">
/**
 * ToastContainer — 全局 toast 通知呈现层.
 *
 * 数据走 uiStore.toasts;产生 toast 通过 uiStore.notify(msg, kind, ms)。
 * ToastContainer 只负责渲染 + 动画 + 关闭 —— 业务逻辑(消息内容、持续
 * 时间)由调用方决定,组件完全 stateless。
 *
 * 设计选择:
 * - 右下角浮动(Linear / Notion / GitHub 都这位置),不抢顶部 banner 给
 *   持续错误的视觉资源
 * - `<Teleport to="body">` 脱离 TopBar / 任意 shell 层级
 * - `<TransitionGroup>` 给 add / remove 加 fade + slide 动画
 * - 卡片左侧 3px 颜色条 + 图标双重提示 kind,用户扫一眼就懂
 * - `pointer-events: none` 在容器上,内部 toast 重新开 `auto`,
 *   不挡页面交互
 */
import { useUiStore } from '@/stores/ui'
import { storeToRefs } from 'pinia'
import type { Toast } from '@/stores/ui'

const uiStore = useUiStore()
const { toasts } = storeToRefs(uiStore)

/**
 * kind → material-symbols-outlined 图标名.
 * 跟 store.ts 里的 Toast kind 单一源,加新 kind 同步这里。
 */
function iconFor(kind: Toast['kind']): string {
  switch (kind) {
    case 'success':
      return 'check_circle'
    case 'error':
      return 'error'
    case 'info':
      return 'info'
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-container" aria-live="polite" aria-atomic="true">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast"
          :class="`toast-${t.kind}`"
          role="status"
        >
          <span class="material-symbols-outlined toast-icon">{{ iconFor(t.kind) }}</span>
          <span class="toast-msg">{{ t.message }}</span>
          <button
            class="toast-close"
            type="button"
            aria-label="关闭"
            @click="uiStore.dismiss(t.id)"
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
/* 容器固定在右下角 topbar 下方(topbar=56px,padding 16px,塞 80)。
   pointer-events: none 让 toast 不挡点击,内部 toast 卡片重新打开
   pointer-events: auto。 */
.toast-container {
  position: fixed;
  top: 80px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 10000;
  pointer-events: none;
  max-width: calc(100vw - 48px);
}

/* 单卡片:左 3px 颜色条 + icon + msg + close,固定最小 240 / 最大 360。 */
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 240px;
  max-width: 360px;
  padding: 12px 14px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 6px;
  box-shadow: var(--shadow-md);
  pointer-events: auto;
  /* 默认左色条透明,由具体 kind 覆盖 */
  border-left: 3px solid var(--border, #dfe1e6);
}
.toast-success {
  border-left-color: var(--success, #36b37e);
}
.toast-error {
  border-left-color: var(--danger, #de350b);
}
.toast-info {
  border-left-color: var(--accent, #0052cc);
}

.toast-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.toast-success .toast-icon {
  color: var(--success, #36b37e);
}
.toast-error .toast-icon {
  color: var(--danger, #de350b);
}
.toast-info .toast-icon {
  color: var(--accent, #0052cc);
}

.toast-msg {
  flex: 1;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-1, #172b4d);
  word-break: break-word;
}

.toast-close {
  background: transparent;
  border: 0;
  width: 22px;
  height: 22px;
  cursor: pointer;
  color: var(--text-3, #6b778c);
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.toast-close:hover {
  background: var(--hover-bg, #f4f5f7);
}
.toast-close .material-symbols-outlined {
  font-size: 16px;
}

/* 进入 / 离开动画:从右侧滑入,200ms 缓和;离开反向。TransitionGroup
   自动给每张卡片 add/remove 类名,无需手动监听。 */
.toast-enter-active,
.toast-leave-active {
  transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(120%);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(120%);
}
/* 旧卡片被移除时,下方卡片向上滑到位(避免空白跳)。 */
.toast-leave-active {
  position: absolute;
  right: 0;
}
</style>
