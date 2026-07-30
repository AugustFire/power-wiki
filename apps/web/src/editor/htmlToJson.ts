/**
 * 把 HTML 字符串转成 Tiptap ProseMirror 的 JSON 结构。
 *
 * 用途:种子页和早期存量页面只有 contentHTML、没有 contentJSON 时,
 * 在 store init 阶段批量回填,避免编辑时内容丢失。
 *
 * 错误兜底:解析失败返回空文档,调用方拿到后可以安全写入。
 */
import { generateJSON } from '@tiptap/core'
import extensions from './extensions'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJSON = Record<string, any>

/**
 * 当前 extensions 的 schema 版本号。
 *
 * 改动 extensions(尤其是 CodeBlockLowlight 这类影响节点结构的)时,
 * 必须 bump 这个版本号。store init 会重新解析旧页面,确保 schema 对齐。
 *
 * 版本记录:
 *   1 - 初始 StarterKit + Placeholder + TaskList + Table
 *   2 - 加入 CodeBlockLowlight(codeBlock 节点从此带 language 属性 + hljs-* 高亮)
 */
export const CURRENT_SCHEMA_VERSION = 2

export function htmlToJson(html: string): AnyJSON {
  try {
    const json = generateJSON(html, extensions)
    if (json && typeof json === 'object' && 'type' in json) {
      return json as AnyJSON
    }
  } catch (err) {
    console.warn('[htmlToJson] generateJSON failed, returning empty doc', err)
  }
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/**
 * 判断一段 JSON 是否可以视为"已迁移"。
 *
 * 判定条件:
 *   1. 必须是合法对象
 *   2. 顶层必须有 type === 'doc'
 *   3. 顶层必须有非空 content 数组
 *
 * 注意:即使"已迁移",也可能因为 schema 升级而需要重新解析 —
 * 见 `needsRemigrate`。
 */
export function isMigratedJSON(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false
  const j = json as { type?: unknown; content?: unknown }
  if (j.type !== 'doc') return false
  if (!Array.isArray(j.content)) return false
  return j.content.length > 0
}

/**
 * 判断一段 JSON 是否需要重新解析。
 *
 * 触发条件(任一):
 *   - schemaVersion 不存在或小于当前版本
 *   - 包含没有 language 属性的 codeBlock 节点(老 schema 解析的)
 */
export function needsRemigrate(json: unknown): boolean {
  if (!json || typeof json !== 'object') return true
  const j = json as { __schemaVersion?: unknown; content?: unknown }
  if (typeof j.__schemaVersion !== 'number') return true
  if (j.__schemaVersion < CURRENT_SCHEMA_VERSION) return true
  // 再做一次 schema 体检:扫一遍 content,如果发现任何 codeBlock 没有 language,需要重解析
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scan = (nodes: any[]): boolean => {
    for (const n of nodes) {
      if (n?.type === 'codeBlock' && !n?.attrs?.language) return true
      if (Array.isArray(n?.content)) {
        if (scan(n.content)) return true
      }
    }
    return false
  }
  if (Array.isArray(j.content) && scan(j.content)) return true
  return false
}

/**
 * 给已迁移的 JSON 打上 schema 版本号。
 */
export function stampSchemaVersion(json: AnyJSON): AnyJSON {
  json.__schemaVersion = CURRENT_SCHEMA_VERSION
  return json
}

/**
 * 旧 mark 名 → Tiptap StarterKit mark 名的映射。
 *
 * 存量页面(尤其是走 Markdown 导入的)可能带 prosemirror-markdown /
 * markdown-it 的 mark 名 `strong` / `em` / `strikethrough`,而 Tiptap
 * StarterKit 的 mark 分别叫 `bold` / `italic` / `strike`。EditView 把
 * contentJson 直接喂 `setContent` 时,未知 mark type 会抛
 * "There is no mark type strong in this schema"。
 * 导入侧已在 `apps/api/src/lib/mdImport.ts` 修正,这里是打开编辑器前的
 * 兜底,顺带自愈:改后的内容在下一次 auto-save 会以正确 mark 名回写。
 */
const LEGACY_MARK_NAME_MAP: Record<string, string> = {
  strong: 'bold',
  em: 'italic',
  strikethrough: 'strike',
}

/**
 * 把一份 contentJson 修整成 Tiptap 编辑器可以吃的形态:
 *   1. legacy mark 名 → Tiptap mark 名(`strong` → `bold` 等),覆盖历史
 *      Markdown 导入留下的脏 mark 名。
 *   2. 删掉空 text 节点。ProseMirror schema 不允许 `{type:'text',
 *      text:''}`,EditView 一旦撞上就抛 RangeError: Empty text nodes are
 *      not allowed。空 text 节点的来源包括:
 *        - prosemirror-markdown 解析 `**P0**` 时会在 strong 边界吐首尾空
 *          token(已在 `apps/api/src/lib/mdImport.ts` 跳过,但存量页面已
 *          落库);服务端修复前那批 markdown 导入页面顶上就挂着这些节点,
 *          一进编辑态就炸。
 *        - Tiptap DOM 粘贴路径里偶发的边界行为(纯空 inline run)。
 *        - 旧版 schema 写入的残留(本地化工具 / 编辑器内 ctrl+shift+v 等)。
 *      自愈策略是递归扫整棵树,凡是 text 类型且 text === '' 的直接抽掉。
 *      抽掉后父节点 content 可能变空数组 — 大多数块类型(content: 'block*')
 *      允许空 content,无副作用;`tableCell` / `tableHeader` 要求至少一个
 *      paragraph(原表格行内已有此保证,这条 sanitize 不会让它们破)。
 *
 * 深拷贝返回,不改动传入的(可能是 reactive 的)原对象。
 */
export function normalizeLegacyMarks(json: AnyJSON): AnyJSON {
  const clone = JSON.parse(JSON.stringify(json)) as AnyJSON
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (Array.isArray(node.marks)) {
      // 1. 把 legacy mark 名改成 Tiptap 名。
      // 2. 抽掉缺 type 的 malformed mark。历史 markdown 导入残留
      //    `{"attrs":{}}`(没 type)时,ProseMirror `Schema.markFromJSON` 会
      //    抛 `There is no mark type undefined in this schema`,整份文档
      //    编辑器拒绝挂载。抽掉这种 mark 是廉价修复——失去的只是这一段
      //    文本的格式,文本内容保留;auto-save 会把干净内容回写。
      node.marks = node.marks.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mk: any) => mk && typeof mk === 'object' && typeof mk.type === 'string' && mk.type.length > 0,
      )
      for (const mk of node.marks) {
        if (LEGACY_MARK_NAME_MAP[mk.type]) {
          mk.type = LEGACY_MARK_NAME_MAP[mk.type]
        }
      }
    }
    if (Array.isArray(node.content)) {
      // 先递归,再过滤掉标记为空的 text 节点。
      node.content.forEach(walk)
      node.content = node.content.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => !(c && c.type === 'text' && c.text === ''),
      )
    }
  }
  walk(clone)
  // 顶层 doc.content 也走一遍同样的过滤。
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => !(c && c.type === 'text' && c.text === ''),
    )
  }
  return clone
}