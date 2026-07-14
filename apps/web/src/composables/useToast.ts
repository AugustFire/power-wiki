/**
 * useToast — Toast 通知的薄封装.
 *
 * ToastContainer 已挂在 App.vue:166,uiStore.notify() 是单一入口。
 * 这个 composable 不做新功能,只把 notify 包成 success / error / info 三个
 * 直觉方法,免得调用方每次写 `uiStore.notify(msg, 'success', 2400)`。
 *
 * 设计选择:
 * - 默认 duration 区分:success / info 给 2.4s(短促确认),error 给 4s
 *   (留够时间读完错误信息)。调用方需要更长 / 常驻可自己覆盖。
 * - 不在模块层做单例,每次调用 useToast() 返回新对象 —— Pinia store 本身
 *   是单例,封装只是方法转发,不需要额外状态。
 */
import { useUiStore } from '@/stores/ui'

export function useToast() {
  const ui = useUiStore()
  return {
    success: (msg: string, ms = 2400) => ui.notify(msg, 'success', ms),
    error: (msg: string, ms = 4000) => ui.notify(msg, 'error', ms),
    info: (msg: string, ms = 2400) => ui.notify(msg, 'info', ms),
  }
}