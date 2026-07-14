/**
 * useNetworkStatus — 监听浏览器在线/离线状态.
 *
 * 用法(在 App.vue 等顶层调用一次):
 *   const { isOnline } = useNetworkStatus()
 *
 * 实现原理:
 *   - 初始值读 navigator.onLine(同步获取,避免首屏判断延迟)
 *   - 监听 window 'online' / 'offline' 事件,实时翻转 ref
 *   - 组件卸载时清理监听器
 *
 * 边界:
 *   - navigator.onLine 在某些环境下不可靠(wifi 连着但实际不通)。
 *     本期不引入 fetch 心跳检测,先用浏览器事件;后续若用户反馈
 *     "显示在线但操作一直失败"再加心跳。
 *   - 不区分 wifi / 移动网络 / 服务端 unreachable —— 只反映 OS 层的网络
 *     物理状态;后端连不上由 App.vue 已有的 page-error / error-banner 处理。
 */
import { onMounted, onUnmounted, ref } from 'vue'

export function useNetworkStatus() {
  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)

  function handleOnline() {
    isOnline.value = true
  }
  function handleOffline() {
    isOnline.value = false
  }

  onMounted(() => {
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
  })

  onUnmounted(() => {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  })

  return { isOnline }
}