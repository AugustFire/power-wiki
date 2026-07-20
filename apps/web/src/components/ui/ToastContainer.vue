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
          :class="[`toast-${t.kind}`, { 'toast-with-action': t.action }]"
          role="status"
        >
          <span class="material-symbols-outlined toast-icon">{{ iconFor(t.kind) }}</span>
          <span class="toast-msg">{{ t.message }}</span>
          <!-- 可选 action 按钮(典型:上传失败 → 重试)。action.onClick
               是闭包,ToastContainer 不持有业务状态,职责止于触发;重试
               成功后由 RichEditor 调 uiStore.dismiss 关闭本 toast。 -->
          <button
            v-if="t.action"
            class="toast-action"
            type="button"
            @click="t.action.onClick()"
          >{{ t.action.label }}</button>
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
/* 容器固定在右下角,bottom 24px / right 24px。flex-direction: column
   让新 toast 出现在最底(远离视口中线),老 toast 自然向上堆叠 —— 跟
   Linear / Notion / GitHub 的位置与堆叠方向一致,不抢顶栏 / banner 的
   视线。pointer-events: none 让容器不挡页面交互,内部 toast 卡片
   重新打开 pointer-events: auto。 */
.toast-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 10000;
  pointer-events: none;
  max-width: calc(100vw - 48px);
}

/* 单卡片:背景走 soft 色块(Atlassian 系统一致 -- App.vue 顶部
   error-banner 用 --danger-soft 同套路),icon + 文字保持全色饱和度。
   圆角 / 阴影 / 间距 全部走 token,跟 CheatSheetModal / ConfirmDialog
   同一族视觉。 */
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 240px;
  max-width: 360px;
  padding: 11px 14px;
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-lg, 6px);
  box-shadow: var(--shadow-sm);
  pointer-events: auto;
}

.toast-success {
  background: var(--success-soft);
  color: var(--success);
}
.toast-error {
  background: var(--danger-soft);
  color: var(--danger);
}
.toast-info {
  background: var(--accent-soft);
  color: var(--accent);
}

.toast-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.toast-success .toast-icon,
.toast-error .toast-icon,
.toast-info .toast-icon {
  color: inherit;
}

.toast-msg {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--text-1);
  word-break: break-word;
}

.toast-close {
  background: transparent;
  border: 0;
  width: 22px;
  height: 22px;
  cursor: pointer;
  color: inherit;
  opacity: 0.6;
  border-radius: var(--radius-md, 4px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 80ms ease;
}
.toast-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.06);
}
.toast-close .material-symbols-outlined {
  font-size: 16px;
}

/* Action 按钮(上传失败 → 重试)。视觉上比 close 更显眼 —— 主操作
 * 是 action,close 只是附带。配色跟 close 一族(透明 + 主题色 hover),
 * 但加了 weight 和 padding 让按钮"可点"信号更强。带 action 的 toast
 * 通常是 sticky 状态,所以加一道左边分隔线,让 action 区域跟消息区
 * 分开。 */
.toast-with-action {
  padding-right: 10px;
}
.toast-action {
  height: 26px;
  padding: 0 12px;
  margin-left: 4px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid currentColor;
  border-radius: var(--radius-md, 4px);
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 80ms ease;
}
.toast-action:hover {
  background: #fff;
}
.toast-action:active {
  background: rgba(255, 255, 255, 0.7);
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
