/**
 * useBlockTypeSwitcher — 块类型(段落 / 一级 / 二级 / 三级 / 引用 / 代码块)
 * 共享逻辑。
 *
 * 抽自 EditorToolbar.vue 的私有实现 —— 之前整段 setBlockType +
 * liftAndConvertBlocks + wrapBlocks + matchesBlockType + isPosInsideBlockquote
 * + blockTypeToNodeType 都是文件内私有,无法给 BubbleMenu 等其他「块类型
 * 选择器」复用。本 composable 把这层逻辑封装到一个共享接口,two-way 复用
 * 时不需要双份维护。
 *
 * 设计要点:
 *   1. 行为完全保留 —— 抽出仅是位置变化,不该有任何 UI 行为变化(toolbar
 *      回归点是「视觉/行为一字不差」)。
 *   2. UI 状态(open/close ref、点击外部关闭的 mousedown handler、popover
 *      定位、emit 等)**不**在 composable 范围 —— 它们是组件级 UX,toolbar
 *      和 BubbleMenu 各自实现。本 composable 只暴露「选项 + setter」两个
 *      接口。
 *   3. toggle-off 语义:选区内所有块都已是目标类型时,切回 paragraph;这
 *      是 toolbar 的既有行为,继续遵守。
 */
import { computed, type Ref } from 'vue'
import type { Editor } from '@tiptap/core'

export type BlockTypeId = 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'code'

export interface BlockTypeOpt {
  id: BlockTypeId
  label: string
  icon: string
  isActive: () => boolean
}

// ─── 内部类型抽象 ──────────────────────────────────────────────────────
// toolbar 原实现大量使用 `type AnyEditor = any`,这里切到真正的 Tiptap
// Editor 类型 —— 抽出来的 composable 是新的共享 API,值得用严格类型。
// toolbar 那边的 AnyEditor 在内部仍然有效(被赋值的实际就是 Editor 实例),
// 只是 prop 注解从 any 收紧后 vue-tsc 会更严格 —— 不在这里动它。
type BlockPos = number
interface BlockInfo {
  pos: BlockPos
  node: { isTextblock: boolean; type: { name: string }; nodeSize: number; attrs: Record<string, unknown> }
}

export function useBlockTypeSwitcher(editorRef: Ref<Editor | null>) {
  const blockTypeOptions = computed<BlockTypeOpt[]>(() => {
    const e = editorRef.value
    if (!e) return []
    return [
      { id: 'p', label: '正文', icon: 'notes', isActive: () => e.isActive('paragraph') },
      { id: 'h1', label: '一级标题', icon: 'format_h1', isActive: () => e.isActive('heading', { level: 1 }) },
      { id: 'h2', label: '二级标题', icon: 'format_h2', isActive: () => e.isActive('heading', { level: 2 }) },
      { id: 'h3', label: '三级标题', icon: 'format_h3', isActive: () => e.isActive('heading', { level: 3 }) },
      { id: 'quote', label: '引用', icon: 'format_quote', isActive: () => e.isActive('blockquote') },
      { id: 'code', label: '代码块', icon: 'code', isActive: () => e.isActive('codeBlock') },
    ]
  })

  const blockTypeLabel = computed(() => {
    const opt = blockTypeOptions.value.find((o) => o.isActive())
    return opt?.label ?? '正文'
  })

  function setBlockType(type: BlockTypeId): void {
    const e = editorRef.value
    if (!e) return

    const { state } = e
    const { from, to } = state.selection

    // 收集选区里所有顶层文本块(跳过 listItem / taskItem 这种嵌套节点)
    const blocks: BlockInfo[] = []
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return
      if (node.type.name === 'listItem' || node.type.name === 'taskItem') return
      blocks.push({ pos, node })
    })
    if (blocks.length === 0) return

    // toggle off:选区里所有块都是目标类型时,切回正文
    const allMatch = blocks.every(({ node }) => matchesBlockType(node, type))
    if (allMatch && type !== 'p') {
      liftAndConvertBlocks(blocks, 'paragraph')
      return
    }

    if (type === 'p') {
      liftAndConvertBlocks(blocks, 'paragraph')
      return
    }
    if (type === 'h1' || type === 'h2' || type === 'h3') {
      const level = type === 'h1' ? 1 : type === 'h2' ? 2 : 3
      // lift + 改 heading level 必须在同一 transaction,否则 lift 后 pos 失效
      liftAndConvertBlocks(blocks, 'heading', (tr, node, pos) => {
        if (node.type.name === 'heading') {
          // heading→heading 用 setNodeMarkup 保留子内容,NodeViewContent 不会被重置
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, level })
        } else {
          // 其他 → setBlockType 创建新 heading 节点
          tr.setBlockType(pos, pos + node.nodeSize, tr.doc.type.schema.nodes.heading, { level })
        }
      })
      return
    }
    if (type === 'quote') {
      // 检查所有块是否都已在外层 blockquote 里(用于 toggle-off)
      const allInQuote = blocks.every(({ pos }) => isPosInsideBlockquote(e.state, pos))
      if (allInQuote) {
        liftAndConvertBlocks(blocks, 'paragraph')
      } else {
        wrapBlocks(blocks, 'blockquote')
      }
      return
    }
    if (type === 'code') {
      liftAndConvertBlocks(blocks, 'codeBlock')
      return
    }
  }

  // ─── 内部辅助(模块闭包私有,不再 export) ─────────────────────────────

  // 把块从外层 blockquote 里 lift 出来,然后在同一个 transaction 里把它们转成目标类型
  // (用 Tiptap 自带的 lift 命令,内部用 $pos.blockRange() 正确处理位置;
  //  tr.lift(from, to) 直接传数字会触发 internal ProseMirror 错误)
  function liftAndConvertBlocks(
    blocks: BlockInfo[],
    targetTypeName: 'paragraph' | 'heading' | 'codeBlock',
    perBlockConvert?: (tr: Editor['state']['tr'], node: BlockInfo['node'], pos: number) => void,
  ): void {
    const e = editorRef.value
    if (!e) return
    e.chain().focus().command(({ tr, state }) => {
      const targetType = state.schema.nodes[targetTypeName]
      if (!targetType) return false
      const blockquoteType = state.schema.nodes.blockquote

      // 步骤 1:lift 每个块从外层 blockquote
      // 用 $pos.blockRange() 拿到正确的 NodeRange,然后 tr.lift(range, target)
      // 不用 from/to 数字 — ProseMirror 内部需要 NodeRange 对象
      for (let i = blocks.length - 1; i >= 0; i--) {
        const { pos } = blocks[i]
        const $pos = state.doc.resolve(pos)
        const $end = state.doc.resolve(pos + blocks[i].node.nodeSize)
        // blockRange 的第二个参数是谓词函数(node) => boolean,不是 spec 对象
        const range = $pos.blockRange($end, (node) => node.type === blockquoteType)
        if (range) {
          // 找一个有效的 lift target:lift 到 blockquote 之上
          const liftTgt = (() => {
            for (let d = range.depth; d > 0; d--) {
              if (range.$from.node(d - 1).type === blockquoteType) {
                return d - 1
              }
            }
            return null
          })()
          if (liftTgt !== null) {
            tr.lift(range, liftTgt)
          }
        }
      }

      // 步骤 2:lift 后块位置变了(往上移动),需要重新找块位置再转换类型
      // 用原始 pos 作 hint,在 tr.doc 里找对应的 textblock
      for (let i = 0; i < blocks.length; i++) {
        const { pos } = blocks[i]
        // lift 不会改变块的内容位置(块本身还在原 pos,只是少了外层 blockquote)
        const cur = tr.doc.nodeAt(pos)
        if (!cur || !cur.isTextblock) continue
        if (perBlockConvert) {
          perBlockConvert(tr, cur, pos)
        } else {
          tr.setBlockType(pos, pos + cur.nodeSize, targetType)
        }
      }
      return true
    }).run()
  }

  // 检查 pos 所在的块是否被外层 blockquote 包裹
  function isPosInsideBlockquote(state: Editor['state'], pos: number): boolean {
    const $pos = state.doc.resolve(pos)
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === 'blockquote') return true
    }
    return false
  }

  // 把一组块整体包进 container(blockquote)
  function wrapBlocks(blocks: BlockInfo[], typeName: 'blockquote'): void {
    const e = editorRef.value
    if (!e) return
    // 直接 chain wrapIn,不预先 setTextSelection(逐块 chain 会自己设选区)
    for (let i = blocks.length - 1; i >= 0; i--) {
      const { pos, node } = blocks[i]
      const endPos = pos + node.nodeSize
      // 必须 focus():点工具栏按钮时编辑器没焦点,wrapIn 在 unfocused 状态下不会应用
      e.chain().focus().setTextSelection({ from: pos, to: endPos }).wrapIn(typeName).run()
    }
  }

  function matchesBlockType(node: BlockInfo['node'], type: BlockTypeId): boolean {
    switch (type) {
      case 'p': return node.type.name === 'paragraph'
      case 'h1': return node.type.name === 'heading' && node.attrs.level === 1
      case 'h2': return node.type.name === 'heading' && node.attrs.level === 2
      case 'h3': return node.type.name === 'heading' && node.attrs.level === 3
      case 'quote': return node.type.name === 'blockquote'
      case 'code': return node.type.name === 'codeBlock'
    }
  }

  return {
    blockTypeOptions,
    blockTypeLabel,
    setBlockType,
  }
}
