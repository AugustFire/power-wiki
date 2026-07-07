<script setup lang="ts">
/**
 * 图片附件全屏查看器(lightbox)
 *
 * 只在 ReadView 里挂载(EditView 不要,免得和 NodeView 工具栏 / Editor 的
 * 拖拽 / 选区逻辑打架)。
 *
 * 关闭:
 *  - Esc 键(全局 keydown 监听)
 *  - 点击 backdrop
 *  - 显式 emit('close') — ReadView 传 src 时如果图片 404 也关掉
 */
import { onBeforeUnmount, onMounted, watch } from 'vue'

const props = defineProps<{
  open: boolean
  src: string
  alt: string
  filename?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function onImgError() {
  // 图片加载失败(S3 删除 / 网络错误)→ 自动关闭,避免黑屏
  emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})

// 打开时锁 body 滚动;关闭恢复。防止背景也跟着滚
watch(
  () => props.open,
  (open) => {
    if (typeof document === 'undefined') return
    document.body.style.overflow = open ? 'hidden' : ''
  },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox-fade">
      <div
        v-if="open"
        class="lightbox-backdrop"
        role="dialog"
        aria-modal="true"
        :aria-label="alt || filename || '图片预览'"
        @click.self="emit('close')"
      >
        <img
          :src="src"
          :alt="alt"
          class="lightbox-img"
          @error="onImgError"
        />
        <button
          type="button"
          class="lightbox-close"
          aria-label="关闭预览"
          title="关闭 (Esc)"
          @click.stop="emit('close')"
        >
          <span class="material-symbols-outlined">close</span>
        </button>
        <div v-if="filename" class="lightbox-caption">{{ filename }}</div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lightbox-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.86);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 48px 32px;
}
.lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-md);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
  user-select: none;
  -webkit-user-drag: none;
}
.lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  border: 0;
  color: #fff;
  border-radius: 50%;
  cursor: pointer;
  transition: background-color var(--duration-fast) ease;
}
.lightbox-close:hover {
  background: rgba(255, 255, 255, 0.2);
}
.lightbox-close .material-symbols-outlined {
  font-size: 22px;
}
.lightbox-caption {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.78);
  font-size: 13px;
  max-width: 80%;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity 120ms ease;
}
.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}
</style>
