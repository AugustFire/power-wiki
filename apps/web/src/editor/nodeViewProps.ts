/**
 * EditorNodeViewProps —— Tiptap Vue NodeView 组件的 props 类型。
 *
 * 11 个 NodeView(Callout / CodeBlock / DateInline / Heading / ImageAttachment /
 * Mention / Toggle …)此前各自在顶部写 `// eslint-disable no-explicit-any`
 * + `type AnyEditor = any`,把 editor 退化成 any 才能调自定义命令
 * (unsetCallout / setToggle / replaceAttachment …)。
 *
 * 实际上这些命令都通过各扩展里的 `declare module '@tiptap/core'` 增补进了
 * `Commands` 接口,直接用 `@tiptap/core` 的 `Editor` 类型即可拿到完整链式命令
 * 的类型,不需要 any。
 *
 * `Attrs` 泛型让每个组件精确声明自己的 node.attrs 形状:
 *   defineProps<EditorNodeViewProps<{ variant?: CalloutVariant }>>()
 *
 * node.textContent 始终存在(ProseMirror 节点保证),不用它的组件忽略即可。
 */
import type { Editor } from '@tiptap/core'

export interface EditorNodeViewProps<
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> {
  node: { attrs: Attrs; textContent: string }
  editor: Editor
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
  /** 原子节点(如 imageAttachment)选中态;非原子 NodeView 不消费,可忽略。 */
  selected?: boolean
}
