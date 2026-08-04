/**
 * 全局确认弹窗 — Promise 化的 API
 *
 * 用法:
 *   const ok = await confirm({ title: '...', message: '...', danger: true })
 *   if (!ok) return
 *
 * 在 App.vue 挂一次 ConfirmDialog 实例,所有组件共享同一个 modal。
 */
import { ref } from 'vue'

export interface ConfirmOptions {
  title: string
  message?: string
  details?: string[]
  requireText?: string
  /** 强调样式(删除等危险操作) */
  danger?: boolean
  confirmText?: string
  cancelText?: string
  /**
   * 弹窗尺寸 —— 默认 420px,适合简短确认;`wide` 把宽度提到接近
   * 表格 / 表单容器的视觉宽度,适合 details[] 较长或多行的场景
   * (如 /manager/trash 的批量永久删除提示)。不直接接任意 width:
   * 弹窗尺寸是设计 token,改全局尺寸比每次声明 px 更稳。
   */
  size?: 'default' | 'wide'
}

interface ConfirmState extends ConfirmOptions {
  open: boolean
  resolve: ((v: boolean) => void) | null
}

const state = ref<ConfirmState>({
  open: false,
  title: '',
  message: '',
  danger: false,
  confirmText: '确认',
  cancelText: '取消',
  size: 'default',
  resolve: null,
})

export function useConfirm() {
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      state.value = {
        open: true,
        title: opts.title,
        message: opts.message ?? '',
        details: opts.details ?? [],
        requireText: opts.requireText ?? '',
        danger: opts.danger ?? false,
        confirmText: opts.confirmText ?? '确认',
        cancelText: opts.cancelText ?? '取消',
        size: opts.size ?? 'default',
        resolve,
      }
    })
  }

  function close(result: boolean) {
    if (state.value.resolve) {
      state.value.resolve(result)
    }
    state.value = {
      ...state.value,
      open: false,
      resolve: null,
    }
  }

  return { state, confirm, close }
}