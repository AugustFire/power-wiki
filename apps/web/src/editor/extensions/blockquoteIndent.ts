/**
 * Blockquote 缩进深度上限的扩展。
 *
 * 为什么独立成文件:StarterKit 的 Blockquote 是已实例化的子扩展,无法
 * 直接 override `addKeyboardShortcuts`。要新增 keyboard 行为,只能从
 * StarterKit 抽出来(`blockote: false`),用 `Blockquote.extend({...})`
 * 重新挂一份 —— 跟 heading / codeBlock 是同一种处理方式(extensions.ts)。
 *
 * 行为:
 *   - Tab:当前选区所在的 blockquote 嵌套深度 < 2 → wrapIn('blockquote');
 *          ≥ 2 → 弹 info toast「已是最深缩进」并 consume,不再叠嵌套。
 *   - Shift-Tab:深度 ≥ 1 → lift 把当前 blockquote 弹回上一级;
 *                深度 0 → return false 让 Tiptap 默认(段落里 Shift-Tab
 *                没什么语义,透传即可)。
 *   - 列表内(listItem / taskItem)Tab 不劫:return false 交给 StarterKit
 *     的 sinkListItem 走默认。
 *
 * 为什么上限是 2 而不是 1:blockquote → blockquote(引文里嵌引文)是合理
 * 排版场景。叠出第 3 层就属于「找不到出口的嵌套叠加」,必须堵死,否则
 * 用户用工具栏的 indent 按钮还能造出第三层 → 完全反人性。
 *
 * 共享:`runIndent` / `runOutdent` 的工具栏按钮也用 `blockquoteDepthAt`
 * 同样的判定,深度 ≥ 2 走同样的 toast。文案复用,不让键盘 / 按钮行为分裂。
 */
import { Blockquote } from '@tiptap/extension-blockquote'
import type { Editor } from '@tiptap/core'
import { useToast } from '@/composables/useToast'

const MAX_DEPTH = 2

/**
 * 选区起点所在的 blockquote 嵌套深度计数。ProseMirror 中 `$pos.depth`
 * 是从 doc 根算到当前位置的层数;从 1 到 $pos.depth 逐层检查 node type,
 * 数 blockquote 出现的次数。0 = 当前块不在任何 blockquote 内。
 *
 * 类型故意取浅(只读 `type` 字段)—— editor 是 tiptap 的 PM state,
 * 完整 ResolvedPos 类型很重;抽象成 duck-type 让 helper 也能在工具栏
 * 那边复用(工具栏 props.editor 也是 Editor,但 toolbar 已经把 helper
 * 写成 any-based)。
 */
type ResolvedPosLike = {
  depth: number
  node: (d: number) => { type: { name: string } }
}

export function blockquoteDepthAt($pos: ResolvedPosLike): number {
  let d = 0
  for (let i = $pos.depth; i > 0; i--) {
    if ($pos.node(i).type.name === 'blockquote') d++
  }
  return d
}

/**
 * `Blockquote.extend(...)` 会复制 Tiptap 的 Blockquote,叠加 addKeyboardShortcuts
 * 而不丢失原有行为(parseHTML / renderHTML / commands 都还在)。工具栏按钮
 * 的 indent(outdent)命令走的是 Tiptap 默认 commands,跟这里互不干扰。
 */
export const BlockquoteIndent = Blockquote.extend({
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }: { editor: Editor }) => {
        const { $from } = editor.state.selection
        const d = blockquoteDepthAt($from)
        if (d >= MAX_DEPTH) {
          useToast().info('已是最深缩进', 1800)
          return true // consume,否则 Tiptap 会在段落里插 \t
        }
        // listItem / taskItem 内让 StarterKit 走 sinkListItem,不在这里劫
        if (editor.isActive('listItem') || editor.isActive('taskItem')) return false
        return editor.chain().focus().wrapIn('blockquote').run()
      },
      'Shift-Tab': ({ editor }: { editor: Editor }) => {
        const { $from } = editor.state.selection
        if (blockquoteDepthAt($from) === 0) return false
        // `lift` 是 PM 的 schema-level command,Blockquote 自身的 typed command 表里
        // 没暴露它(`setBlockquote` / `toggleBlockquote` / `unsetBlockquote` 才是)。
        // editor.chain() 在 toolbar 那边的 typed scope 里能看到 lift,因为那里
        // chain 类型合并了所有扩展;在 addKeyboardShortcuts 的内部 scope 里
        // chain 类型只看到 Blockquote 扩展,所以必须走 commands() 出口 /
        // 用 unsetBlockquote 替代。 unsetBlockquote 直接解开所有 blockquote 包裹,
        // 对 Shift+Tab 来说深度 1 也只解开一层,深度 2 也一次解开 —— 用户预期是
        // "从引文中出去",一次解开所有 quote 包裹也合理(继续 Shift+Tab 无 blockquote 可解,depth 守卫兜底)。
        return editor.chain().focus().unsetBlockquote().run()
      },
    }
  },
})
