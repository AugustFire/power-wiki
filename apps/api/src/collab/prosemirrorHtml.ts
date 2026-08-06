/**
 * Y.Doc → HTML mirror —— Hocuspocus `onStoreDocument` 触发的服务端写回。
 *
 *   - 入参:Y.Doc
 *   - 出参:Tiptap JSON(contentJson)+ HTML 字符串(contentHtml)
 *
 * 为什么需要:
 *   pages.contentJson / contentHtml 是 ReadView / duplicate / export /
 *   snapshot / 搜索索引的事实来源 —— 它们不接 Yjs。协同改造后,Y.Doc
 *   成为「实时编辑事实来源」,但持久层仍然是这两列。
 *
 *   onStoreDocument 拿到的 `document` 是 server 端持有的 Y.Doc 实例,经
 *   过 sync 协议收敛了所有 client 的 update。把这个 Y.Doc 投影到
 *   ProseMirror JSON + HTML,UPDATE 进 pages 表,就保持了两套事实来源
 *   的最终一致性。
 *
 * 设计要点:
 *   - **不写 page_yjs_state**:那是另一张表,onStoreDocument 已经写了。
 *     本函数只负责 contentJson / contentHtml 两列。
 *   - **HTML 用 linkedom 装最小 DOM**,DOMSerializer.serializeFragment
 *     走 schema.toDOM 序列化,跟 client 端 editor.getHTML() 输出 1:1。
 *   - **失败容忍**:mirror 失败(典型情况:Y.Doc 内容跟 schema drift)
 *     不能让 onStoreDocument 抛错回 Hocuspocus —— 否则 connection close,
 *     client 会反复 reconnect。log warn,跳过 UPDATE,只保留上次 contentJson。
 *   - **node 环境没有 document**:Hocuspocus server 跑在 node 进程,引
 *     linkedom(~200KB,比 jsdom 轻 ~30x)装一份最小 DOM 接口。
 */
import * as Y from 'yjs'
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import { collabSchema } from './tiptapSchema'

export interface MirroredPageContent {
  contentJSON: Record<string, unknown>
  contentHTML: string
}

interface LinkedomElement {
  innerHTML: string
  appendChild(child: unknown): unknown
}

interface LinkedomDocument {
  createElement(tag: string): LinkedomElement
}

interface LinkedomModule {
  parseHTML(html: string): { document: LinkedomDocument }
}

/**
 * 一次性装 linkedom。失败抛错 → 上层 mirror 跳过 contentHtml 字段,
 * contentJson 仍写入(contentHtml 缺不影响 Yjs 协同主流程,ReadView 在
 * mirror 后续帧会重新填充)。
 */
let _linkedomHandle: { document: LinkedomDocument } | null = null

async function loadLinkedomOnce(): Promise<NonNullable<typeof _linkedomHandle>> {
  if (_linkedomHandle) return _linkedomHandle
  const mod = (await import('linkedom')) as unknown as LinkedomModule
  _linkedomHandle = mod.parseHTML('<div></div>')
  return _linkedomHandle
}

/**
 * 把一份 Y.Doc 投影到 Tiptap JSON + HTML。
 *
 * 装载 linkedom 一次,DOMSerializer 序列化 fragment。
 *
 * 关键:prosemirror-model 的 DOMSerializer 内部 `doc(options)` fallback
 * 到 `window.document`(dist/index.js:3382),Node 环境没 window → ReferenceError。
 * 解法是把 linkedom 提供的 `document` 显式传给 `DOMSerializer.fromSchema(schema,
 * { document })`,绕过 window 引用。
 */
export async function mirrorYDocToPageContent(ydoc: Y.Doc): Promise<MirroredPageContent> {
  const json = yDocToProsemirrorJSON(ydoc, 'prosemirror')
  const docNode = collabSchema.nodeFromJSON(json) as PMNode
  const fragment = docNode.content
  const { document: linkedomDocument } = await loadLinkedomOnce()
  const serializer = DOMSerializer.fromSchema(collabSchema)
  // prosemirror-model 1.25.9 的 serializeFragment 内部 fallback 到 `window.document`
  // (dist/index.js:3382),Node 环境没 window → ReferenceError。把 linkedom 的
  // document 作为 options 传进去,绕过 window 引用。
  //
  // TypeScript 拿不到 lib.dom 的 Document 全局类型,所以整个 options object
  // double-cast 成 `never` 兼容 prosemirror 的 `{ document?: Document }` 签名。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dom = serializer.serializeFragment(fragment, { document: linkedomDocument as any })
  const wrapper = linkedomDocument.createElement('div')
  // linkedom 的 Element.appendChild 接受任意 node-like,我们的 dom 来自
  // DOMSerializer.serializeFragment 返回的 DocumentFragment,接口契约一致。
  ;(wrapper as unknown as { appendChild: (n: unknown) => unknown }).appendChild(dom)
  return {
    contentJSON: json as unknown as Record<string, unknown>,
    contentHTML: wrapper.innerHTML,
  }
}