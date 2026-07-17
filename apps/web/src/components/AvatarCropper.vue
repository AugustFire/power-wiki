<script setup lang="ts">
/**
 * AvatarCropper — M11 v3:256×256 圆形头像裁剪器。
 *
 * 设计要点:
 *  - 固定 256×256 圆形画布(直径 = 边长,圆心 = (128, 128))
 *  - 进入时:图自动 cover 圆(取 max 系数,确保图填满圆)
 *  - 拖动:pointerdown/move/up,以圆心为原点,offset 在 px 单位
 *  - 不支持缩放 —— fit 后只能拖动;若原图比例不合适,引导用户先换图
 *  - 输出:canvas.toBlob → 256×256 PNG
 *  - 实时 `crop` emit 节流 200ms;`commit` 时同步 emit 最终 blob
 *
 * 关键实现细节 — 用 <Image>+URL.createObjectURL 而不是 createImageBitmap:
 *  - createImageBitmap 在某些浏览器内部做 sync 解码,**会阻塞主线程**,
 *    setTimeout/console.warn 都不跑 — 用户看到 spinner 永久转,DevTools 沉默
 *  - <Image> 走浏览器 off-thread 解码管线,onload/onerror 走事件循环,
 *    setTimeout 超时 + console.warn 都能正常生效
 *  - 加 img.decode() 强制等完全解码再用,避免 drawImage 时再阻塞
 *
 * 受父组件(SettingsDrawer)控制 props.file,切图时内部图片重新加载。
 * 父组件听 `crop` 拿节流流(实时预览),听 `commit` 拿最终值(走上传)。
 */
import { ref, watch, onBeforeUnmount, useTemplateRef } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 选中的文件;切图时内部图片重新加载 */
    file: File | null
    /** 输出 PNG 边长(同时 = canvas 直径),默认 256 */
    size?: number
  }>(),
  { size: 256 },
)

export interface CroppedAvatarPayload {
  blob: Blob
  mime: 'image/png'
  width: number
  height: number
}

const emit = defineEmits<{
  /** 200ms 节流,父组件可订阅实时预览 */
  (e: 'crop', payload: CroppedAvatarPayload): void
  /** commit 时无节流,父组件走 upload → finalize → PATCH */
  (e: 'commit', payload: CroppedAvatarPayload): void
  /** 文件无法解码(尺寸 0 / 过大 / 浏览器不支持 / 超时)—
   * 父组件收到后应清掉 cropperFile + 显示错误条,让用户重选。 */
  (e: 'error', payload: { message: string }): void
}>()

const SIZE = props.size
const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')

/* ── 状态 ───────────────────────────────────────────────────────────── */
const imgRef = ref<HTMLImageElement | null>(null)
const imgUrl = ref<string | null>(null)   // 关联的 object URL,切图/卸载时 revoke
const offsetX = ref(0)   // 图中心相对圆心位移(px),正方向朝右下
const offsetY = ref(0)
const scale = ref(1)     // 缩放系数
const ready = ref(false) // file 已加载到 img + 初次 fit 完
const errorMsg = ref<string | null>(null)  // 解码失败的兜底,UI + emit 双通道

interface DragStart {
  x: number
  y: number
  ox: number
  oy: number
  pointerId: number
}
let dragStart: DragStart | null = null
let throttleTimer: ReturnType<typeof setTimeout> | null = null

/* ── 异步解码:用 Image() + URL.createObjectURL,off-thread 解码管线 ── */
const DECODE_TIMEOUT_MS = 8000  // 8s,比 createImageBitmap 的 sync decode 友好很多

/** 把图 URL 存到 img 自身,切图时统一 revoke,避免泄漏 */
const URL_KEY = Symbol('cropperUrl')

function loadImageAsync(file: File): Promise<HTMLImageElement> {
  console.log('[AvatarCropper] loadImageAsync start', {
    name: file.name,
    type: file.type,
    size: file.size,
  })
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    let settled = false
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      console.warn('[AvatarCropper] decode timeout', {
        name: file.name,
        type: file.type,
        size: file.size,
      })
      reject(new Error(`图片解码超时(>${DECODE_TIMEOUT_MS / 1000}s),请压缩后再上传`))
    }, DECODE_TIMEOUT_MS)
    img.onload = () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      console.log('[AvatarCropper] onload fired', {
        name: file.name,
        w: img.naturalWidth,
        h: img.naturalHeight,
      })
      ;(img as unknown as Record<symbol, string>)[URL_KEY] = url
      resolve(img)
    }
    img.onerror = (e) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      console.warn('[AvatarCropper] onerror fired', {
        name: file.name,
        type: file.type,
        err: e,
      })
      URL.revokeObjectURL(url)
      reject(new Error('该图片格式无法解析,请换一张或压缩后再试'))
    }
    img.src = url
  })
}

function disposeImage() {
  if (imgUrl.value) {
    URL.revokeObjectURL(imgUrl.value)
    imgUrl.value = null
  }
  imgRef.value = null
}

/* ── 加载 file → img,初次 fit ─────────────────────────────────────
 * 关键:{ immediate: true } —— Vue 3 watch 默认 lazy(只在 source 变化时回调),
 * 不会在挂载时 fire。AvatarCropper 的 mount 时机正好是 cropperFile 第一次
 * 从 null 变成 file(parent 的 v-else 条件刚转 true),如果不加 immediate,
 * 首次挂载的 file=File 不会触发回调,ready 永远是初始 false,spinner 永转。
 * 加 immediate 后挂载时立即跑一次,后续 props.file 变了再跑。 */
watch(
  () => props.file,
  async (file) => {
    console.log('[AvatarCropper] watcher fired', {
      file: file?.name ?? null,
      type: file?.type ?? null,
      size: file?.size ?? null,
    })
    // 清旧图(防止切图时短暂闪两张)
    if (throttleTimer) {
      clearTimeout(throttleTimer)
      throttleTimer = null
    }
    disposeImage()
    ready.value = false
    errorMsg.value = null
    dragStart = null
    offsetX.value = 0
    offsetY.value = 0
    if (!file) return

    try {
      const img = await loadImageAsync(file)
      // 防御:onload 偶发 naturalWidth=0
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        throw new Error('该图片格式无法解析,请换一张试试')
      }
      // 防御:浏览器能解码但单边 > 8192 时,缩放 + 渲染都卡
      if (img.naturalWidth > 8192 || img.naturalHeight > 8192) {
        throw new Error('图片过大(超过 8192 像素),请压缩后再上传')
      }
      imgRef.value = img
      imgUrl.value = (img as unknown as Record<symbol, string>)[URL_KEY] ?? null
      // 初次 fit:cover 圆(取 max,确保图填满圆不留白)
      const fit = Math.max(SIZE / img.naturalWidth, SIZE / img.naturalHeight)
      scale.value = fit
      offsetX.value = 0
      offsetY.value = 0
      await render()
      ready.value = true
      scheduleEmit()
    } catch (err) {
      // onerror / 超时 / img.decode() 拒 / 防御检查 — 都汇总到这里
      // UI 切到 error 覆盖 + emit 让父组件重置 cropperFile 让用户重选
      console.warn('[AvatarCropper] decode failed', {
        name: file.name,
        type: file.type,
        size: file.size,
        err,
      })
      const message = err instanceof Error ? err.message : '图片加载失败,请重试'
      errorMsg.value = message
      disposeImage()
      ready.value = false
      emit('error', { message })
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  disposeImage()
  if (throttleTimer) {
    clearTimeout(throttleTimer)
    throttleTimer = null
  }
  dragStart = null
})

/* ── 渲染 ───────────────────────────────────────────────────────────── */
async function render() {
  const cv = canvasRef.value
  const img = imgRef.value
  if (!cv || !img) return
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, SIZE, SIZE)

  // 圆形 clip —— 圆内才可见,圆外被裁
  ctx.save()
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()

  // 绘制图
  const w = img.naturalWidth * scale.value
  const h = img.naturalHeight * scale.value
  const x = (SIZE - w) / 2 + offsetX.value
  const y = (SIZE - h) / 2 + offsetY.value
  ctx.drawImage(img, x, y, w, h)
  ctx.restore()

  // 圆形外圈 —— 轻微边框,让用户看清圆边
  ctx.strokeStyle = 'rgba(0,0,0,0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 0.5, 0, Math.PI * 2)
  ctx.stroke()
}

function scheduleEmit() {
  if (throttleTimer) clearTimeout(throttleTimer)
  throttleTimer = setTimeout(emitCrop, 200)
}

async function emitCrop(): Promise<CroppedAvatarPayload | null> {
  const cv = canvasRef.value
  if (!cv) return null
  const blob = await new Promise<Blob | null>((r) =>
    cv.toBlob((b) => r(b), 'image/png'),
  )
  if (!blob) return null
  const payload: CroppedAvatarPayload = {
    blob,
    mime: 'image/png',
    width: SIZE,
    height: SIZE,
  }
  emit('crop', payload)
  return payload
}

/* ── 拖动 ───────────────────────────────────────────────────────────── */
function onPointerDown(e: PointerEvent) {
  if (!ready.value) return
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    ox: offsetX.value,
    oy: offsetY.value,
    pointerId: e.pointerId,
  }
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}
async function onPointerMove(e: PointerEvent) {
  if (!dragStart) return
  if (e.pointerId !== dragStart.pointerId) return
  offsetX.value = dragStart.ox + (e.clientX - dragStart.x)
  offsetY.value = dragStart.oy + (e.clientY - dragStart.y)
  await render()
  scheduleEmit()
}
async function onPointerUp(e: PointerEvent) {
  if (!dragStart) return
  if (e.pointerId !== dragStart.pointerId) return
  try {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    // setPointerCapture 没成功时 releasePointerCapture 会抛,无害
  }
  dragStart = null
  // 拖动结束立即 emit 一次,不留节流尾巴
  const payload = await emitCrop()
  if (payload) emit('commit', payload)
}

/* ── 父组件可显式调 commit() 拿最终 blob ──────────────────────────── */
defineExpose({
  /** 同步 emit 最终 blob,无节流。父组件 onSave 路径调。 */
  async commit(): Promise<CroppedAvatarPayload | null> {
    const payload = await emitCrop()
    if (payload) emit('commit', payload)
    return payload
  },
})
</script>

<template>
  <div class="avatar-cropper" :style="{ width: `${SIZE}px`, height: `${SIZE}px` }">
    <canvas
      v-show="ready && !errorMsg"
      ref="canvas"
      :width="SIZE"
      :height="SIZE"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
    <div v-if="!ready && !errorMsg" class="avatar-cropper-loading">
      <span class="material-symbols-outlined is-loading">progress_activity</span>
    </div>
    <div v-if="errorMsg" class="avatar-cropper-error">
      <span class="material-symbols-outlined">image_not_supported</span>
      <div class="avatar-cropper-error-text">{{ errorMsg }}</div>
    </div>
  </div>
</template>

<style scoped>
.avatar-cropper {
  display: inline-block;
  position: relative;
  user-select: none;
  touch-action: none; /* 让 pointer 拖动生效,阻止触屏默认滚动/缩放 */
  margin: 4px auto 0;
}
canvas {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  cursor: grab;
}
canvas:active {
  cursor: grabbing;
}
.avatar-cropper-loading,
.avatar-cropper-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--bg-subtle, #f4f5f7);
  border-radius: 50%;
  color: var(--text-3, #6b778c);
  padding: 16px;
  text-align: center;
}
.avatar-cropper-error {
  background: var(--error-soft, #ffebe6);
  color: var(--danger, #de350b);
}
.avatar-cropper-loading .material-symbols-outlined,
.avatar-cropper-error .material-symbols-outlined {
  font-size: 32px;
  pointer-events: none;
}
.avatar-cropper-error-text {
  font-size: 12px;
  line-height: 1.3;
  max-width: 200px;
}
.is-loading { animation: spin 0.9s linear infinite; }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
