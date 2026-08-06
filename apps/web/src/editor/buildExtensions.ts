/**
 * buildExtensions —— 根据协同模式返回 Tiptap 扩展集合的工厂。
 *
 * 为什么需要:
 *   协同模式下,Tiptap 的 Yjs 绑定(`@tiptap/extension-collaboration` 的
 *   `Collaboration`)会自己管 undo(Y.UndoManager),**必须**关闭 StarterKit
 *   的内置 history —— 否则两个 undo stack 并存,Cmd+Z 会从错误的栈里
 *   弹内容,出现 redo 错位 / 重复撤销 / 部分撤销丢失等诡异 bug。
 *
 *   同理,Cursor 装饰(其他用户的光标 / 选区)必须从 awareness 读,所以
 *   `CursorExtension` 包装 `y-prosemirror/yCursorPlugin`,把
 *   `provider.awareness` 喂进去。provider 由 caller 注入,光标颜色 / 名字
 *   来自 awareness state 的 `user.color` / `user.name`,跟 ReadView 顶栏
 *   头像组共用一份状态。
 *
 * 用法:
 *   const { ydoc, provider, isConnected } = useCollabProvider({ ... })
 *   const extensions = computed(() => buildExtensions({
 *     collabMode: 'shared',
 *     ydoc: ydoc.value,
 *     provider,            // y-prosemirror/yCursorPlugin 接受 y-protocols Awareness
 *     user: authStore.user,
 *   }))
 *
 * 关键约束:
 *   - collabMode !== 'off' 时务必传入 ydoc / provider / user,否则会 throw。
 *     这不是「可选」协同 —— 协同模式是 phase 2 的承诺,断了用户期望。
 *   - StarterKit.history 关闭后,Cmd+Z / Cmd+Shift+Z 仍可用 —— 它们走
 *     Collaboration 提供的 undo/redo command(看 @tiptap/extension-collaboration
 *     的 Commands<ReturnType>.collaboration.undo/redo),Tiptap 默认 keymap
 *     自动绑定这两个。
 *   - 切 pageId 时 ydoc 引用会换,caller 通过 :key 或 editor 重挂绑新 doc。
 *
 * Phase 2 范围:shared mode(server relay);personal mode(BroadcastChannel)
 * 在 Phase 3 实现,这里接受参数但不接 BroadcastChannelProvider。
 */
import { Extension } from '@tiptap/core'
import { Collaboration } from '@tiptap/extension-collaboration'
import { yCursorPlugin } from 'y-prosemirror'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { User } from '@power-wiki/shared'
import { baseExtensions, type Extensions } from './extensions'

export type CollabMode = 'off' | 'shared' | 'personal'

export interface BuildExtensionsOptions {
  collabMode: CollabMode
  ydoc?: Y.Doc | null
  /** yCursorPlugin 接受任意 y-protocols Awareness,HocuspocusProvider / BroadcastChannelProvider 都行。 */
  provider?: { awareness: Awareness } | null
  user?: Pick<User, 'name' | 'color'> | null
}

/**
 * Tiptap 扩展,把 `y-prosemirror/yCursorPlugin` 挂到 ProseMirror state 里。
 *
 * yCursorPlugin 内部:
 *   - 订阅 awareness 'change' → 拿到其他 client 的 cursor 状态,渲染成
 *     decoration(选区背景 + 名字小标签)
 *   - selectionchange → 把自己的 anchor/head 算成相对位置,setLocalStateField
 *     推到 awareness,被 provider 同步到其他人
 *
 * cursorBuilder 默认会把 `awareness.user.name` 渲成小标签、`user.color`
 * 当作背景色。我们用默认 builder,自定义样式在 components.css 里通过
 * `.collaboration-cursor__caret` / `.collaboration-cursor__label` 选择器
 * 覆盖 background / color。
 */
const CursorExtension = Extension.create<{ provider: { awareness: Awareness } | null }>({
  name: 'collaborationCursor',
  addProseMirrorPlugins() {
    const provider = this.options.provider
    if (!provider) return []
    return [
      yCursorPlugin(provider.awareness, {
        // 选区为空(只有 caret,无 range)时仍画一根 caret —— 默认行为是
        // 选区为空时不画,这里显式打开让「另一个用户在原地思考但没选中
        // 文字」也能看到。
        cursorBuilder: (user) => {
          // y-prosemirror 默认 builder 只在 selection 非空时画 caret。
          // 我们希望空选区也画 —— 因为「对方正在编辑」是个明确的语义信号,
          // 比「对方光标消失了」对协作帮助大。
          const cursor = document.createElement('span')
          cursor.classList.add('collaboration-cursor__caret')
          cursor.setAttribute('style', `border-color: ${user.color || '#0F8AFF'}`)
          const label = document.createElement('div')
          label.classList.add('collaboration-cursor__label')
          label.setAttribute('style', `background-color: ${user.color || '#0F8AFF'}`)
          label.appendChild(document.createTextNode(user.name || '匿名'))
          cursor.appendChild(label)
          return cursor
        },
      }),
    ]
  },
})

/**
 * 工厂:返回当前协同模式下 Tiptap 用的扩展列表。
 *
 * 行为:
 *   - collabMode === 'off':返回 baseExtensions(单写者模式,跟改造前 1:1)。
 *   - collabMode === 'shared' | 'personal':
 *       1. 复制 baseExtensions
 *       2. 关闭 StarterKit.history(避免双 undo stack)
 *       3. 追加 Collaboration(绑 ydoc,fragment 名 'prosemirror',跟 server
 *          mirror 的 prosemirrorJSONToYDoc(..., 'prosemirror') 对齐)
 *       4. 追加 CursorExtension(绑 provider.awareness)
 *
 * **Provider 还没就绪的退化路径**:HocuspocusProvider 是异步 connect 的,
 * useCollabProvider 在 collabMode 翻 'shared' 后立刻同步给 RichEditor 喂
 * collabMode='shared',但 provider.awareness 要等 onSynced 才到位。中间窗口
 * (几十毫秒 ~ 几百毫秒)如果不 graceful 退路,RichEditor setup throw 会
 * 把整个 EditView render 打断 —— LockBanner 等上层组件也跟着挂掉。
 * 这里检测 provider/ydoc/user 任一缺位时,静默退到 baseExtensions 走单写者
 * 模式;调用方(EditView 的 editorKey watch)需要在 provider 就绪时 bump key
 * 触发重挂,把 extensions 切回完整 collab 配置。
 */
export function buildExtensions(opts: BuildExtensionsOptions): Extensions {
  const { collabMode } = opts
  if (collabMode === 'off') {
    return baseExtensions
  }
  if (!opts.ydoc || !opts.provider || !opts.user) {
    if (import.meta.env.DEV) {
      console.warn(
        '[buildExtensions] collab deps not ready yet, falling back to single-writer mode',
      )
    }
    return baseExtensions
  }

  // 关 StarterKit.history — Collaboration 自己接管 undo(用 Y.UndoManager)。
  // 同时给 CursorExtension 喂 awareness。
  const base: Extensions = baseExtensions.map((ext: Extensions[number]) => {
    if (ext.name !== 'starterKit') return ext
    // StarterKit 是 SingleExtension,configure 返回新实例;原链没破坏。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sk = ext as any
    return sk.configure({ history: false })
  })

  // 强转 — provider 实际是 HocuspocusProvider 但 yCursorPlugin 只读 awareness
  const collaboration = Collaboration.configure({
    document: opts.ydoc,
    field: 'prosemirror',
  })

  const cursor = CursorExtension.configure({
    provider: opts.provider as { awareness: Awareness },
  })

  // 把 user 信息塞 awareness(本地 setLocalStateField 跟服务端 hooks.onAuthenticate
  // 注入 context.user 同步;这里再写一份防止 HocuspocusProvider 的 onAuthenticated
  // 还没 fire 的窗口期 awareness 缺 user 字段)。
  if (opts.provider.awareness.getLocalState()?.['user'] == null) {
    opts.provider.awareness.setLocalStateField('user', {
      name: opts.user.name,
      color: opts.user.color,
    })
  }

  return [...base, collaboration, cursor]
}

/** yCursorPlugin 接受的 provider shape 收紧:HocuspocusProvider / 后续 BroadcastChannelProvider 都满足。 */
export type CollabProviderShape = {
  awareness: Awareness
}