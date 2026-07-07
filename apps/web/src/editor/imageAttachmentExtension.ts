/**
 * Image / Attachment 节点(页面级附件,MinIO/S3 存储)
 *
 * 单节点 `imageAttachment`,`kind` attr 决定渲染成图片还是文件卡片
 * (二者 attrs 90% 相同,合并成一个节点省一半样板)。
 *
 * 渲染结构(在编辑器和读视图一致):
 *   kind=image:
 *     <figure class="attachment-image align-{align}" data-attachment-*>
 *       <img src="/api/attachments/{id}/raw" alt="...">
 *       <figcaption>…</figcaption>   ← 仅 caption 非空时
 *     </figure>
 *   kind=file:
 *     <figure class="attachment-file" data-attachment-*>
 *       <a href="/api/attachments/{id}/raw" download="{filename}">
 *         <span class="material-symbols-outlined">{mime-icon}</span>
 *         <span class="attachment-file-name">{filename}</span>
 *         <span class="attachment-file-size">{size}</span>
 *       </a>
 *       <figcaption>…</figcaption>
 *     </figure>
 *
 * 设计决策(与 PageRef / Mention 一致):
 * - atom: true — cursor 不进入,删除即整块移除
 * - selectable / draggable — 可选中、可 DragHandle 拖拽
 * - EditView 走 NodeView(ImageAttachmentView) — 提供 hover 工具栏(对齐/alt/删除)
 *   和 figcaption 原地编辑;ReadView 走 renderHTML 最终 HTML。
 * - src 恒为 /api/attachments/{id}/raw(相对 URL);sanitize.ts 的 img src
 *   白名单只放行这个模式,挡掉 https:// / data: / blob:
 * - align 三档:left(默认,块级居左)/ center(块级居中)/ right(块级居右)。
 *   left/right 走 CSS float + max-width 50% 形成文字绕排;
 *   center 走 display:block + margin:0 auto。
 *   文件卡不参与对齐(块级,放页面流里)。
 *
 * markdown 序列化不在此定义 —— 与其它自定义扩展一致,由
 * markdownSerializer.ts 通过 .extend({ addStorage }) 注入。
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import ImageAttachmentView from '@/components/editor/ImageAttachmentView.vue'
import { fileIconFor } from '@/editor/attachmentIcon'

/** 人类可读体积。attachmentPicker / 卡片渲染共用同一格式。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

type Alignment = 'left' | 'center' | 'right'
const ALIGNMENTS: Alignment[] = ['left', 'center', 'right']

type AttachmentNodeAttrs = {
  id: string
  kind: 'image' | 'file'
  mime: string
  originalFilename: string
  sizeBytes: number
  alt: string
  caption: string
  align: Alignment
}

/** 供 addCommands 的 insertAttachment 用的入参形状(来自 finalize 的 DTO)。 */
export interface InsertAttachmentArg {
  id: string
  kind: 'image' | 'file'
  mimeType: string
  originalFilename: string
  sizeBytes: number
}

export const ImageAttachment = Node.create({
  name: 'imageAttachment',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-attachment-id'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.id ? { 'data-attachment-id': attrs.id as string } : {},
      },
      kind: {
        default: 'image',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-attachment-kind') || 'image',
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-attachment-kind': (attrs.kind as string) || 'image',
        }),
      },
      mime: {
        default: '',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-attachment-mime') || '',
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.mime ? { 'data-attachment-mime': attrs.mime as string } : {},
      },
      originalFilename: {
        default: '',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-attachment-filename') || '',
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.originalFilename
            ? { 'data-attachment-filename': attrs.originalFilename as string }
            : {},
      },
      sizeBytes: {
        default: 0,
        parseHTML: (el: HTMLElement) =>
          Number(el.getAttribute('data-attachment-size') || 0),
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-attachment-size': String(attrs.sizeBytes ?? 0),
        }),
      },
      alt: {
        default: '',
        parseHTML: (el: HTMLElement) => {
          const img = el.querySelector('img')
          return img?.getAttribute('alt') ?? ''
        },
        // alt 走 <img alt> content,不在 figure attr 上序列化
        renderHTML: () => ({}),
      },
      caption: {
        default: '',
        parseHTML: (el: HTMLElement) => {
          const cap = el.querySelector('figcaption')
          return cap?.textContent ?? ''
        },
        // caption 走 <figcaption> content
        renderHTML: () => ({}),
      },
      align: {
        default: 'left',
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-align') as Alignment | null
          return v && ALIGNMENTS.includes(v) ? v : 'left'
        },
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-align': (attrs.align as string) || 'left',
        }),
      },
    }
  },

  parseHTML() {
    return [
      { tag: 'figure.attachment-image' },
      { tag: 'figure.attachment-file' },
    ]
  },

  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(ImageAttachmentView as any)
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as AttachmentNodeAttrs
    const id = attrs.id || ''
    const src = `/api/attachments/${id}/raw`
    const caption = attrs.caption || ''
    const align: Alignment = ALIGNMENTS.includes(attrs.align) ? attrs.align : 'left'
    const isImage = attrs.kind !== 'file'

    if (isImage) {
      // alt 永远填充(filename 兜底)以满足可访问性,绝不留空
      const altText = attrs.alt || attrs.originalFilename || ''
      const figureClass = `attachment-image align-${align}`
      // loading="lazy" + decoding="async":ReadView 多图场景减少首屏带宽 + 防止
      // 大图阻塞渲染。EditView NodeView 同一份 attrs 也加(下面 Vue 模板同步)。
      const children: unknown[] = [
        ['img', { src, alt: altText, loading: 'lazy', decoding: 'async' }],
      ]
      if (caption) children.push(['figcaption', {}, caption])
      return [
        'figure',
        mergeAttributes(HTMLAttributes, { class: figureClass }),
        ...children,
      ] as never
    }

    const filename = attrs.originalFilename || '附件'
    const size = formatBytes(attrs.sizeBytes)
    // 跟 EditView NodeView 用同一份 attachmentIcon.ts —— 否则用户在 ReadView
    // 看到的 PDF 红色会丢,Word/Excel 也会变默认 description 灰图标。
    // 颜色走 inline style,sanitize.ts 的 sanitizeStyle 接受 #hex / rgb / 命名色,
    // 挡掉 url() / expression() / javascript:,XSS 安全。
    //
    // 整张卡不再是 <a download> —— 整卡可点击 → 误下载率高。改成 <div> + 角落
    // hover 才浮出的显式下载按钮(<a download>),跟 EditView 行为对齐。
    const fi = fileIconFor(attrs.mime)
    const iconStyle = `color: ${fi.color}`
    const cardChildren: unknown[] = [
      ['span', { class: 'material-symbols-outlined attachment-file-icon', style: iconStyle }, fi.icon],
      ['span', { class: 'attachment-file-name' }, filename],
    ]
    if (size) cardChildren.push(['span', { class: 'attachment-file-size' }, size])
    cardChildren.push([
      'a',
      { href: src, download: filename, class: 'attachment-file-download', title: `下载 ${filename}`, 'aria-label': '下载附件' },
      ['span', { class: 'material-symbols-outlined' }, 'download'],
    ])
    const children: unknown[] = [
      ['div', { class: 'attachment-file-card' }, ...cardChildren],
    ]
    if (caption) children.push(['figcaption', {}, caption])
    return [
      'figure',
      mergeAttributes(HTMLAttributes, { class: 'attachment-file' }),
      ...children,
    ] as never
  },

  addCommands() {
    return {
      insertAttachment:
        (arg: InsertAttachmentArg) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              id: arg.id,
              kind: arg.kind,
              mime: arg.mimeType,
              originalFilename: arg.originalFilename,
              sizeBytes: arg.sizeBytes,
              alt: '',
              caption: '',
              align: 'left',
            },
          }),
      insertAttachmentAt:
        (arg: InsertAttachmentArg, pos: number) =>
        ({ commands }) =>
          commands.insertContentAt(pos, {
            type: this.name,
            attrs: {
              id: arg.id,
              kind: arg.kind,
              mime: arg.mimeType,
              originalFilename: arg.originalFilename,
              sizeBytes: arg.sizeBytes,
              alt: '',
              caption: '',
              align: 'left',
            },
          }),
      setAttachmentCaption:
        (id: string, caption: string) =>
        ({ state, dispatch }) =>
          patchAttachment(state, dispatch, id, (old) => ({ ...old, caption })),
      setAttachmentAlign:
        (id: string, align: Alignment) =>
        ({ state, dispatch }) =>
          patchAttachment(state, dispatch, id, (old) => ({ ...old, align })),
      setAttachmentAlt:
        (id: string, alt: string) =>
        ({ state, dispatch }) =>
          patchAttachment(state, dispatch, id, (old) => ({ ...old, alt })),
      replaceAttachment:
        (oldId: string, newArg: InsertAttachmentArg) =>
        ({ state, dispatch }) => {
          // 保留用户元数据(alt / caption / align),只换字节属性
          // (id / kind / mime / originalFilename / sizeBytes)。
          // 找不到节点返回 false,调用方拿到 false 后回滚上传(避免孤儿)。
          return patchAttachment(state, dispatch, oldId, (old) => ({
            id: newArg.id,
            kind: newArg.kind,
            mime: newArg.mimeType,
            originalFilename: newArg.originalFilename,
            sizeBytes: newArg.sizeBytes,
            alt: old.alt,
            caption: old.caption,
            align: old.align,
          }))
        },
    }
  },
})

/**
 * 找到第一个 id 匹配的 imageAttachment 节点,patch 它的 attrs 后 dispatch。
 * 抽出来避免 4 个 setter 各自重复 state.doc.descendants + setNodeMarkup + found
 * 标志位,也避免未来加新 attrs setter 时复制粘贴漂移。
 *
 * 性能:descendants 一旦找到第一个匹配就 return false 提前停止,单次 setter
 * 平均是 O(找到位置所需的遍历),最坏 O(N)。建 id→pos Map 在 4 个 setter
 * 各自独立调用时并不更省 —— 反而要遍历完整文档。
 */
function patchAttachment(
  state: EditorState,
  dispatch: ((tr: import('@tiptap/pm/state').Transaction) => void) | undefined,
  id: string,
  patch: (old: AttachmentNodeAttrs) => Partial<AttachmentNodeAttrs>,
): boolean {
  let foundPos: number | null = null
  let foundNode: PMNode | null = null
  state.doc.descendants((n, pos) => {
    if (foundPos !== null) return false
    if (n.type.name === 'imageAttachment' && n.attrs.id === id) {
      foundPos = pos
      foundNode = n as PMNode
      return false
    }
  })
  if (foundPos === null || foundNode === null) return false
  const oldAttrs = (foundNode as PMNode).attrs as AttachmentNodeAttrs
  const newAttrs = patch(oldAttrs)
  if (dispatch) {
    const tr = state.tr
    tr.setNodeMarkup(foundPos, undefined, newAttrs)
    dispatch(tr)
  }
  return true
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    imageAttachment: {
      insertAttachment: (arg: InsertAttachmentArg) => ReturnType
      insertAttachmentAt: (arg: InsertAttachmentArg, pos: number) => ReturnType
      setAttachmentCaption: (id: string, caption: string) => ReturnType
      setAttachmentAlign: (id: string, align: 'left' | 'center' | 'right') => ReturnType
      setAttachmentAlt: (id: string, alt: string) => ReturnType
      replaceAttachment: (oldId: string, newArg: InsertAttachmentArg) => ReturnType
    }
  }
}
