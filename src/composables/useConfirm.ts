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
  /** 强调样式(删除等危险操作) */
  danger?: boolean
  confirmText?: string
  cancelText?: string
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
  resolve: null,
})

export function useConfirm() {
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      state.value = {
        open: true,
        title: opts.title,
        message: opts.message ?? '',
        danger: opts.danger ?? false,
        confirmText: opts.confirmText ?? '确认',
        cancelText: opts.cancelText ?? '取消',
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