/**
 * 隐藏 <input type="file"> 单例 —— Toolbar / SlashMenu / paste / drop 四处复用。
 *
 * 直接 new 一个 input、append 到 body、点击。选完文件回调后清空 value
 * (这样连续选同一文件也能再次触发 change)。accept 用 shared 的
 * ALLOWED_MIME_TYPES,与后端 upload-url 校验同一事实来源。
 */
import { ALLOWED_MIME_TYPES } from '@power-wiki/shared'

let input: HTMLInputElement | null = null
let currentHandler: ((file: File) => void) | null = null

function ensureInput(): HTMLInputElement {
  if (input) return input
  const el = document.createElement('input')
  el.type = 'file'
  el.accept = ALLOWED_MIME_TYPES.join(',')
  el.style.display = 'none'
  el.addEventListener('change', () => {
    const file = el.files?.[0]
    // 先清 value 再回调:回调里若抛错也不影响下次选同名文件。
    el.value = ''
    const handler = currentHandler
    currentHandler = null
    if (file && handler) handler(file)
  })
  document.body.appendChild(el)
  input = el
  return el
}

/** 打开系统文件选择器;选中后用选中的 File 调 onFile。 */
export function openAttachmentPicker(onFile: (file: File) => void): void {
  const el = ensureInput()
  currentHandler = onFile
  el.click()
}
