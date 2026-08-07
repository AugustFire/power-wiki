/**
 * 非 Yjs 写入路径的协同状态预填 —— 共享给 import / duplicate 端点。
 *
 * 触发场景:
 *   - POST /api/pages/import:把 Markdown 解析成 Tiptap JSON 写入 pages 行,
 *     跳过 Hocuspocus 协同通道。
 *   - POST /api/pages/:id/duplicate:源页 contentJson 拷成新行,同样跳过
 *     Hocuspocus。
 *
 * 为什么需要:
 *   M13+ 之后,`pages.contentJson` / `contentHtml` 是 mirror 列,事实来源
 *   是 `page_yjs_state` 里的 Y.Doc 字节。Hocuspocus onLoadDocument 优先
 *   查 `page_yjs_state`,无 row 才走冷启动 hydration(apps/api/src/collab/
 *   hooks.ts:132)。hydration 走 `hydrateYDocFromContentJson` —— 解析
 *   失败时 Y.Doc 留空,接着 onBeforeUnloadDocument → persistYDoc →
 *   mirrorYDocToPageContent 会把**空** Y.Doc 投影写回 pages 表,**反向
 *   覆盖** import / duplicate 刚写入的 contentJson / contentHtml。
 *   用户的可见现象:「import 一个 md → 浏览器看到内容 → 刷新后内容没了」。
 *
 *   预填把 `page_yjs_state` 跟 `pages` 行同步建出来,ReadView 首次 mount
 *   时 onLoadDocument 直接命中「state 有 row」分支(hooks.ts:140),跳过
 *   冷启动 hydration,mirror 写回的内容与 import / duplicate 写入一致,
 *   不会再被空 Y.Doc 反向覆盖。
 *
 * 设计要点:
 *   - 复用 `hydrateYDocFromContentJson`(apps/api/src/collab/hydration.ts:53)
 *     做 Tiptap JSON → Y.Doc 转换,跟 hooks.ts 冷启动走同一份 schema,
 *     保证两路径产出等价。
 *   - 复用 hooks.ts:220 的 UPSERT SQL 模板,INSERT ... ON CONFLICT
 *     (page_id) DO UPDATE,幂等 —— 重复调用安全(Hocuspocus debounce
 *     路径如果已经先写了 state,我们这里 UPSERT 覆盖为相同字节,无副作用)。
 *   - **不传事务**:prefill 是协同状态落库,跟 pages 行的写是两件事,
 *     pages 行失败应回滚 import / duplicate,prefill 失败不阻塞主流程。
 *   - 失败语义:抛错 → 上层 try/catch warn + skip。contentJson 已经在
 *     pages 行里持久化,只丢协同状态可接受(ReadView 走 hydration 兜底,
 *     行为与 pre-fix 等价,不会更糟)。
 *
 * 不在本函数范围:
 *   - `POST /api/pages`(新建空白页):contentJson 是 `{}`,hydration
 *     形状守卫拒,空页本来就空,无可观察 bug。留作 follow-up。
 *   - `restore` / snapshot 回写:同上,本轮不动。
 */
import * as Y from 'yjs'
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { hydrateYDocFromContentJson } from './hydration'

/**
 * 把 Tiptap JSON 灌进新 Y.Doc 并把字节 UPSERT 进 `page_yjs_state`。
 *
 * 成功返回 Y.Doc 字节数(给调用方 log / 埋点用)。
 * 失败抛错 —— 上层 try/catch 决定是否降级。
 */
export async function persistPageYjsState(
  pageId: string,
  contentJson: unknown,
): Promise<{ byteSize: number }> {
  const doc = new Y.Doc()
  try {
    hydrateYDocFromContentJson(doc, contentJson)
    const state = Y.encodeStateAsUpdate(doc)
    const byteSize = state.byteLength
    const now = Date.now()

    await db.execute(sql`
      INSERT INTO page_yjs_state (page_id, state, byte_size, updated_at)
      VALUES (${pageId}, ${state}, ${byteSize}, ${now})
      ON CONFLICT (page_id) DO UPDATE
        SET state = EXCLUDED.state,
            byte_size = EXCLUDED.byte_size,
            updated_at = EXCLUDED.updated_at
    `)

    return { byteSize }
  } finally {
    doc.destroy()
  }
}
