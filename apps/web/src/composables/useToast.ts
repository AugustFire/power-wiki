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
 * - 带 action 的 toast 永远是常驻的(durationMs=0),action 本身就是
 *   让用户主动决定下一步的入口,自动消失会逼用户重试。
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
    /**
     * 带 action 的错误 toast(常驻)。典型用途:附件上传失败挂「重试」
     * 按钮 —— onClick 闭包持有 file 对象,直接复用上传 pipeline。
     */
    errorWithAction: (
      msg: string,
      action: { label: string; onClick: () => void },
    ) => ui.notify(msg, 'error', 0, action),
  }
}