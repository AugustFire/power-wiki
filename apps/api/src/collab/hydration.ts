/**
 * 冷启动 hydration —— 从 `pages.contentJson`(Tiptap 产出的 ProseMirror JSON)
 * 把 doc 状态重建到一份新的 Y.Doc。
 *
 * 触发场景:
 *   - 共享空间 page 第一次接入 Yjs 协同。`page_yjs_state` 无行(老 page
 *     在协同改造之前只有 contentJson),第一个 client 连进来时 onLoadDocument
 *     返回 undefined,本模块用 prosemirrorJSONToYDoc 把现有内容灌进
 *     Y.Doc —— 用户看到完整内容,而不是空白编辑器。
 *
 * 设计要点:
 *   - `prosemirrorJSONToYDoc(schema, json, ydoc)` 直接把 JSON 拆成 CRDT
 *     操作写入 ydoc —— 跟 client 通过 Tiptap insertContent 写入 ydoc 的
 *     结果等价(都是同一份 Y.Doc,只是入口不同)。
 *   - **不立刻回写 `page_yjs_state`**:本表由 Hocuspocus 自带的 2s debounce
 *     在第一次 client edit 后触发 onStoreDocument 自然落库。这样冷启动
 *     路径只读不写,避免 idle page 凭空多一条 bytea 行。
 *   - **失败容忍**:`contentJson` 是 client 给的(可能有 schema 漂移的旧
 *     数据 —— orphan marks / 未知 attr),解析失败时本模块 log warn 然后
 *     抛给调用方 bail。Phase 1 awareness-only 阶段 hydration 不跑,失败
 *     也不影响 awareness 收敛。
 *
 * 边界 case:
 *   - contentJson 是 `{ type: 'doc', content: [] }`(空 doc,默认新建页)→
 *     写一个空 paragraph 进 ydoc,与 client 新建 page 看到的空编辑器一致。
 *   - 未知 node / mark 类型 → prosemirrorJSONToYDoc 抛 "Node type X not
 *     in schema"。这种 case 是 client / server schema drift,需要人工介入。
 */
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import { collabSchema } from './tiptapSchema'

export interface HydrateResult {
  /** 写进 ydoc 的内容字节数(给上层 log 用)。 */
  byteSize: number
}

/**
 * 把 Tiptap / ProseMirror JSON 灌进新的 Y.Doc。
 *
 *   - `ydoc` 是 Hocuspocus 注入 payload.document 的实例,会被 mutate。
 *   - `contentJson` 是 pages.contentJson 列读出来的 raw JSON,Tiptap schema。
 *
 * 实现要点:
 *   y-prosemirror 的 `prosemirrorJSONToYDoc(schema, json, xmlFragment)`
 *   总是新建一份 Y.Doc(签名约束)。要 hydrate 到 Hocuspocus 给的
 *   payload.document,得用 `Y.applyUpdate(target, Y.encodeStateAsUpdate(source))`
 *   做一次 state 拷贝。
 *
 * 失败抛错:上层 onLoadDocument 在 try/catch 里调,失败时降级空 ydoc +
 * log warn,不让冷启动把 Hocuspocus 连接搞挂。
 */
export function hydrateYDocFromContentJson(
  ydoc: Y.Doc,
  contentJson: unknown,
): HydrateResult {
  if (!contentJson || typeof contentJson !== 'object') {
    throw new Error('invalid_content_json: not an object')
  }
  /**
   * 形状守卫:新建 page 落库时 `contentJson` 是 `{}`(pages.ts:575 `input.contentJSON ?? {}`),
   * 没有 `type` 字段,直接喂给 `Node.fromJSON(schema, {})` 会抛 "Unknown node type: undefined"。
   *
   * 这里只接受 `{ type: 'doc', content?: ... }` 形态;其他(空对象 / 缺 type / type 不是 'doc')
   * 一律按空 doc 走 —— 等价于「没有可 hydrate 的内容」,返回 byteSize=0,ydoc 不变。
   *
   * 为什么不抛错:跟顶层 onLoadDocument 的「失败容错 → 留空 YDoc」一致(参见 hooks.ts:159
   * 的 catch),这里把形状失败也归到「不可 hydrate」一类,不污染日志。
   */
  const obj = contentJson as { type?: unknown; content?: unknown }
  const valid = obj.type === 'doc' && (obj.content === undefined || Array.isArray(obj.content))
  if (!valid) {
    return { byteSize: Y.encodeStateAsUpdate(ydoc).byteLength }
  }
  // 1. 让 y-prosemirror 把 JSON 拆成一份新的 Y.Doc 字节
  const tempDoc = prosemirrorJSONToYDoc(collabSchema, contentJson, 'prosemirror')
  const update = Y.encodeStateAsUpdate(tempDoc)
  tempDoc.destroy()
  // 2. 把这份 state apply 到 Hocuspocus 持有的 payload.document
  Y.applyUpdate(ydoc, update)
  return {
    byteSize: Y.encodeStateAsUpdate(ydoc).byteLength,
  }
}

/**
 * 把 Y.Doc 内容 mirror 回 Tiptap JSON(等同 client editor.getJSON() 的输出)。
 *
 * 跟 hydrate 互为反向操作 —— Hocuspocus 持久化时用这个把 Y.Doc 转回
 * pages.contentJson 持久列,供 ReadView / duplicate / export / snapshot
 * 等读路径使用(它们不接 Yjs)。
 *
 * 失败抛错:mirror 失败通常意味着 Y.Doc 内容被某个不在 schema 里的节点
 * 污染(极端情况,client 端扩展改动但忘了同步服务端 schema)。上层走
 * try/catch,失败时跳过 mirror + log,pages.contentJson 保留上一次
 * 收敛值(不删,避免把上次的内容抹了)。
 */
export function yDocToTiptapJSON(ydoc: Y.Doc): Record<string, unknown> {
  // yDocToProsemirrorJSON 直接走 schema 解码 Y.Doc 的 fragment,产出
  // ProseMirror JSON(node tree)。字段名 'prosemirror' 跟 hydrate 对齐。
  const json = yDocToProsemirrorJSON(ydoc, 'prosemirror')
  return json as unknown as Record<string, unknown>
}