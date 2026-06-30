/**
 * 列表分页 helpers.
 *
 * 设计:
 * - `?limit=` / `?offset=` 通过 query 传入,parsePagination 用 zod
 *   PaginatedQuerySchema 校验。两者都 optional — 不传 = 后端走全量分支,
 *   保留 stores / 一次性拉全量的调用方的向后兼容。
 * - hasMore 检测走 "LIMIT N+1" 技巧:SQL 多取一行,有这行 = 后面还有,
 *   没有 = 到底。比 COUNT(*) 便宜,一次往返搞定。
 *
 * 典型用法(参考 apps/api/src/routes/adminUsers.ts):
 *   const { limit, offset } = parsePagination(c)
 *   let q = db.select().from(table).where(...)
 *   if (limit !== undefined) q = q.limit(limit + 1).offset(offset) as typeof q
 *   const rows = await q
 *   const result = applyPagination(
 *     rows.map((r) => XSchema.parse(rowToX(r))),
 *     limit,
 *     offset,
 *   )
 *   return c.json(PaginatedListSchema(XSchema).parse(result))
 */
import type { Context } from 'hono'
import { PaginatedQuerySchema } from '@power-wiki/shared/schemas'

export interface PaginationArgs {
  /** undefined = 调用方没传 limit,走全量分支 */
  limit?: number
  offset: number
}

/**
 * 解析 ?limit=&offset= query。两者都 optional;都缺省时返回 `{limit: undefined, offset: 0}`,
 * 路由据此走"全量"分支。
 *
 * 失败时 zod 抛 ZodError — 调用方通常在 try/catch 里转 400 invalid_input。
 * 这里提供 `safeParsePagination` 包装,直接返回 400 Response 给调用方短路。
 */
export function parsePagination(c: Context): PaginationArgs {
  const raw = {
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  }
  // .partial() 因为 PaginatedQuerySchema 的两个字段本来就 optional,
  // 这里再 partial 一次只为了拿到"两个都缺省"也合法的解析路径。
  const parsed = PaginatedQuerySchema.partial().parse(raw)
  return { limit: parsed.limit, offset: parsed.offset ?? 0 }
}

/**
 * Same as `parsePagination` but returns `{ ok: true, args }` on success or
 * `{ ok: false, response }` carrying a 400 Response on schema failure.
 *
 * Use in route handlers to keep the Hono handler a single `c` return path:
 *
 *   const parsed = safeParsePagination(c)
 *   if (!parsed.ok) return parsed.response
 *   const { limit, offset } = parsed.args
 */
export function safeParsePagination(
  c: Context,
): { ok: true; args: PaginationArgs } | { ok: false; response: Response } {
  try {
    return { ok: true, args: parsePagination(c) }
  } catch (err) {
    return {
      ok: false,
      response: c.json(
        {
          error: 'invalid_input',
          message: 'limit / offset 取值非法',
          issues: err instanceof Error ? (err as { issues?: unknown }).issues ?? String(err) : String(err),
        },
        400,
      ),
    }
  }
}

export interface PaginatedResult<T> {
  items: T[]
  limit: number
  offset: number
  hasMore: boolean
}

/**
 * 把 LIMIT N+1 拿到的 rows 收缩成对外的响应包装。
 *
 * - `limit === undefined` → 全量分支:items 原样返回,limit/offset 填成
 *   反映实际返回行数的默认值,hasMore 永远 false(语义上"已经全在 items 里")。
 * - `limit` 有限 → 取前 limit 行作为 items,hasMore 由 rows.length > limit 判定。
 */
export function applyPagination<T>(
  rows: T[],
  limit?: number,
  offset = 0,
): PaginatedResult<T> {
  if (limit === undefined) {
    return {
      items: rows,
      limit: rows.length,
      offset: 0,
      hasMore: false,
    }
  }
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit),
    limit,
    offset,
    hasMore,
  }
}