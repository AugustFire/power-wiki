<script setup lang="ts">
/**
 * UploadStatus — 上传进度条 + 失败重试的状态条。
 *
 * 模块 6 P0(上传进度条):挂在 EditView 编辑器上方,订阅 useUploadsStore,
 * 渲染当前所有上传任务。每条任务:
 *   - uploading:文件名 + 进度条 + 已加载 / 总大小 + 速度估算(可选)
 *   - failed:文件名 + 错误文案(人话,humanizeUploadError) + 重试 + 关闭按钮
 *
 * 设计:
 *   - 单调纯色背景(--accent-soft for uploading, --danger-soft for failed)
 *   - 进度条走 CSS width transition,1s 内完成的大文件基本看不到条;
 *     5s+ 的大文件能感受到动效。速度估算暂不做 —— 实现要 hold 一个
 *     sliding window,复杂度/价值比偏低。
 *   - 多任务叠加:每个任务一行,垂直堆叠。最多同时进行 1-2 个,UI 不会被撑爆。
 *
 * 不做的事:
 *   - 不显示「取消上传」按钮。XHR 没暴露 abort 的钩子给 UI(只能从外面
 *     hold xhr 对象),实现成本跟收益不对称,失败 → 重试已经覆盖。
 *   - 不做 SSE 同步 —— 客户端上传,本地状态就是真相。
 */
import { computed } from 'vue'
import { useUploadsStore } from '@/stores/uploads'
import { formatBytes } from '@/editor/imageAttachmentExtension'
import type { UploadErrorKind } from '@/editor/uploadAndInsert'
import { MAX_UPLOAD_BYTES_DEFAULT } from '@power-wiki/shared'

const store = useUploadsStore()

/** 进度百分比(0-100,取整)。total<=0 时(浏览器拿不到)显示 0。 */
function percent(t: { loaded: number; total: number }): number {
  if (!t.total || t.total <= 0) return 0
  return Math.min(100, Math.round((t.loaded / t.total) * 100))
}

/** 失败时把 kind 转中文文案。跟 RichEditor.humanizeUploadError 同源(简化版),
 * 状态条只显示一句"为什么失败",详细原因由 toast 携带。 */
function reasonLabel(kind?: UploadErrorKind): string {
  switch (kind) {
    case 'size_exceeded':
      return `超过 ${formatBytes(MAX_UPLOAD_BYTES_DEFAULT)} 上限`
    case 'mime_not_allowed':
      return '文件类型不支持'
    case 'network_error':
      return '网络中断'
    case 'server_unavailable':
      return '存储服务暂不可达'
    case 'upload_failed':
      return '上传被拒绝'
    default:
      return '上传失败'
  }
}

const visible = computed(() => store.list.length > 0)
</script>

<template>
  <div v-if="visible" class="upload-status" role="status" aria-live="polite">
    <div
      v-for="t in store.list"
      :key="t.id"
      class="upload-row"
      :class="{ 'is-failed': t.phase === 'failed' }"
    >
      <div class="us-icon">
        <span
          v-if="t.phase === 'failed'"
          class="material-symbols-outlined"
          aria-hidden="true"
        >error</span>
        <span
          v-else
          class="material-symbols-outlined is-spin"
          aria-hidden="true"
        >progress_activity</span>
      </div>
      <div class="us-body">
        <div class="us-line">
          <span class="us-filename" :title="t.filename">{{ t.filename }}</span>
          <span v-if="t.phase === 'uploading'" class="us-meta">
            {{ percent(t) }}% · {{ formatBytes(t.loaded) }} / {{ formatBytes(t.total) }}
          </span>
          <span v-else class="us-meta us-meta-failed">{{ reasonLabel(t.errorKind) }}</span>
        </div>
        <div v-if="t.phase === 'uploading'" class="us-progress">
          <div class="us-progress-bar" :style="{ width: percent(t) + '%' }"></div>
        </div>
      </div>
      <div class="us-actions">
        <button
          v-if="t.phase === 'failed'"
          type="button"
          class="us-retry"
          @click="store.retry(t.id)"
        >
          <span class="material-symbols-outlined">refresh</span>
          重试
        </button>
        <button
          type="button"
          class="us-close"
          :aria-label="t.phase === 'failed' ? '关闭' : '取消显示'"
          :title="t.phase === 'failed' ? '关闭' : '取消显示'"
          @click="store.dismiss(t.id)"
        >
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.upload-status {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.upload-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--accent-soft);
  border: 1px solid transparent;
  border-radius: var(--radius-md, 4px);
  min-width: 0;
}
.upload-row.is-failed {
  background: var(--danger-soft);
}

.us-icon {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.us-icon .material-symbols-outlined {
  font-size: 18px;
  color: var(--accent);
}
.upload-row.is-failed .us-icon .material-symbols-outlined {
  color: var(--danger);
}

.us-icon .is-spin {
  /* progress_activity 自身已经是 partial-spinning icon,
     但 Tiptap / 一些老图标不会自动转;显式 animation 保证反馈 */
  animation: us-spin 1s linear infinite;
}
@keyframes us-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.us-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.us-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-1);
  min-width: 0;
}
.us-filename {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.us-meta {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.us-meta-failed {
  color: var(--danger);
  font-weight: 600;
}

.us-progress {
  height: 4px;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 2px;
  overflow: hidden;
}
.upload-row.is-failed .us-progress {
  /* 失败时进度条冻结到上次值,不再动 */
  display: none;
}
.us-progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 120ms linear;
}

.us-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.us-retry {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid currentColor;
  border-radius: var(--radius-md, 4px);
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.us-retry:hover {
  background: #fff;
}
.us-retry .material-symbols-outlined {
  font-size: 14px;
}
.upload-row.is-failed .us-retry {
  color: var(--danger);
}

.us-close {
  background: transparent;
  border: 0;
  width: 22px;
  height: 22px;
  cursor: pointer;
  color: inherit;
  opacity: 0.55;
  border-radius: var(--radius-md, 4px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.us-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.06);
}
.us-close .material-symbols-outlined {
  font-size: 16px;
}
</style>