/**
 * 上传任务状态 — 模块 6 P0(进度条 + 错误精确化)的状态层。
 *
 * 每个上传任务以 client-side `nanoid` 作 key,持有:
 *   - id / filename / sizeBytes:显示用
 *   - loaded / total:实时进度
 *   - phase:'uploading' | 'failed'
 *   - errorKind / errorDetail:UploadError 透传,UploadStatus 据此渲染错误文案
 *   - retry:() => void;失败时挂回调(持有 file + pos + pageId 闭包),点重试即原地再跑
 *
 * Pinia 持有 file 对象是合法的 —— store 不持久化,只活在内存,刷新页面
 * 所有任务清空是预期行为(刷新后未保存的上传本来也已丢失)。
 *
 * 不做事件订阅 / SSE 同步 —— 单页 SPA 上传生命周期很短,无后端推流的必要。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { newId } from '@/lib/id'
import type { UploadErrorKind } from '@/editor/uploadAndInsert'

export interface UploadTask {
  id: string
  filename: string
  sizeBytes: number
  loaded: number
  total: number
  phase: 'uploading' | 'failed'
  errorKind?: UploadErrorKind
  errorDetail?: string
  retry: () => void
}

export const useUploadsStore = defineStore('uploads', () => {
  const tasks = ref<Map<string, UploadTask>>(new Map())

  const list = computed(() => Array.from(tasks.value.values()))
  const hasFailures = computed(() => list.value.some((t) => t.phase === 'failed'))

  function start(args: { filename: string; sizeBytes: number; retry: () => void }): string {
    const id = newId()
    tasks.value.set(id, {
      id,
      filename: args.filename,
      sizeBytes: args.sizeBytes,
      loaded: 0,
      total: args.sizeBytes,
      phase: 'uploading',
      retry: args.retry,
    })
    // 触发响应式:Map 的 set 不会通知依赖项,replace 一次
    tasks.value = new Map(tasks.value)
    return id
  }

  function updateProgress(id: string, loaded: number, total: number): void {
    const t = tasks.value.get(id)
    if (!t || t.phase !== 'uploading') return
    t.loaded = loaded
    if (total > 0) t.total = total
    tasks.value = new Map(tasks.value)
  }

  function complete(id: string): void {
    tasks.value.delete(id)
    tasks.value = new Map(tasks.value)
  }

  function fail(id: string, errorKind: UploadErrorKind, errorDetail?: string): void {
    const t = tasks.value.get(id)
    if (!t) return
    t.phase = 'failed'
    t.errorKind = errorKind
    t.errorDetail = errorDetail
    tasks.value = new Map(tasks.value)
  }

  function retry(id: string): void {
    const t = tasks.value.get(id)
    if (!t || t.phase !== 'failed') return
    // 重置为 uploading 后调 retry 回调(由 RichEditor 创建时挂的 closure)
    t.phase = 'uploading'
    t.loaded = 0
    t.errorKind = undefined
    t.errorDetail = undefined
    tasks.value = new Map(tasks.value)
    t.retry()
  }

  function dismiss(id: string): void {
    tasks.value.delete(id)
    tasks.value = new Map(tasks.value)
  }

  return {
    tasks,
    list,
    hasFailures,
    start,
    updateProgress,
    complete,
    fail,
    retry,
    dismiss,
  }
})