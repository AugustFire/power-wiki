-- 0021_user_recent_pages.sql
--
-- M2 服务端「最近浏览」(cross-device 同步):
--   - 之前 power-wiki 用 localStorage 记最近浏览,换浏览器 / 清除缓存就丢。
--     M2 改成服务端持久化:每用户对每页面最多一行 recent,visited_at 滚
--     动更新。
--   - title 冗余存:page 删了之后 recent row 仍有 title 可显示;
--     list 路径优先 LEFT JOIN pages 拿最新 title,这里兜底。
--   - 复合 PK (page_id, user_id) → 天然幂等 UPSERT,跟 user_watched_pages
--     同构。
--   - 索引:(user_id, visited_at DESC)复合给 list 主路径(DESC 必须显式
--     声明才有专用索引方向);(page_id)给 hard-delete 路径清理。
--
-- No FK(CLAUDE.md 硬约束):page hard-delete 由 pages.ts DELETE 递归 CTE
-- 同事务清理;user 删账号由应用层 sweep。

CREATE TABLE "user_recent_pages" (
  "page_id" text NOT NULL,
  "user_id" text NOT NULL,
  "visited_at" bigint NOT NULL,
  "title" text NOT NULL,
  CONSTRAINT "user_recent_pages_page_id_user_id_pk" PRIMARY KEY("page_id","user_id")
);--> statement-breakpoint

CREATE INDEX "user_recent_user_visited_idx" ON "user_recent_pages" ("user_id", "visited_at" DESC);--> statement-breakpoint
CREATE INDEX "user_recent_page_idx" ON "user_recent_pages" ("page_id");--> statement-breakpoint

COMMENT ON TABLE "user_recent_pages" IS 'M2 服务端「最近浏览」表。一行 = 一个用户对一个页面的最近访问记录。ReadView mount 时 PUT /api/users/me/recent/:pageId upsert(visited_at = now,title 冗余);Dashboard 「最近浏览」section 走 GET /me/recent 拉前 N 条。page 软删保留 recent 行,restore 后历史不丢;page 硬删由 pages.ts DELETE 递归 CTE 同事务清理;user 删账号由应用层 sweep。No FK(CLAUDE.md 硬约束)。';--> statement-breakpoint
COMMENT ON COLUMN "user_recent_pages"."page_id" IS '被访问的 page id。page 硬删由 pages.ts DELETE 显式清理;软删 (deletedAt 非 null) 时保留 recent,restore 后历史恢复。';--> statement-breakpoint
COMMENT ON COLUMN "user_recent_pages"."user_id" IS '访问者 user id。每用户对每页面最多一行 recent(PK 复合约束)。disabled / 删账号时由应用层 sweep。';--> statement-breakpoint
COMMENT ON COLUMN "user_recent_pages"."visited_at" IS 'Date.now() 毫秒,最近一次访问时间。每访问一次 (PUT /recent/:id) 刷新;list 路径 ORDER BY DESC 走它。';--> statement-breakpoint
COMMENT ON COLUMN "user_recent_pages"."title" IS '访问时的 page title 冗余。page 删除后 recent row 仍有 title 可显示;list 路径优先 LEFT JOIN pages 拿最新 title。';