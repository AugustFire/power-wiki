/**
 * useAttachmentLightbox — 图片附件全屏预览的共享状态与打开逻辑。
 *
 * ReadView / EditView 原本各自内联一份完全相同的 lightbox state + open/close +
 * 「从 figure.attachment-image > img 提取 src/alt/filename」逻辑。收敛到这里。
 *
 * 注意:**点击绑定策略两边不同,故意不放进 composable** —— ReadView 绑在
 * content root 上(普通冒泡);EditView 走 document capture 阶段 + `.ProseMirror`
 * 过滤 + stopPropagation(要抢在 Tiptap 消费 click 之前,且 cover ProseMirror
 * 节点重建)。两边各自保留自己的监听器,只共用 `openFromImg` 提取逻辑。
 */
import { ref } from 'vue'

export interface LightboxState {
  open: boolean
  src: string
  alt: string
  filename?: string
}

export function useAttachmentLightbox() {
  const lightbox = ref<LightboxState>({ open: false, src: '', alt: '' })

  function openLightbox(state: LightboxState): void {
    lightbox.value = state
  }
  function closeLightbox(): void {
    lightbox.value = { open: false, src: '', alt: '' }
  }
  /** 从 figure.attachment-image > img 元素提取元数据并打开全屏预览。 */
  function openFromImg(img: HTMLImageElement): void {
    const fig = img.closest('figure.attachment-image') as HTMLElement | null
    const filename = fig?.getAttribute('data-attachment-filename') || undefined
    openLightbox({ open: true, src: img.src, alt: img.alt, filename })
  }

  return { lightbox, closeLightbox, openFromImg }
}
