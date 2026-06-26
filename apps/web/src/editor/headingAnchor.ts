/**
 * Tiptap 扩展:H2/H3 标题锚点。
 *
 * 用 Vue NodeView 替换 heading 节点的渲染,把 `#` 锚点包在 heading 外层。
 * ProseMirror 的 NodeView 是稳定的 doc → DOM 映射,不会被 transaction 抹掉。
 *
 * read 端走 @/lib/headingAnchors 直接 DOM 注入(因为 v-html 渲染后
 * ProseMirror 不在场)。
 */
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import Heading from '@tiptap/extension-heading'
import HeadingView from '@/components/editor/HeadingView.vue'

export const HeadingAnchor = Heading.extend({
  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(HeadingView as any)
  },
})