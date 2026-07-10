-- 0019_user_watched_pages.sql
--
-- M13 关注(👁 visibility):
--   1. drop `pages.starred` — 这个字段在 v0 是全空间单值 BOOLEAN,事实上
--      不可用(在 M13 之前一直是死的)。改用 per-user `user_watched_pages`。
--   2. 加 `user_watched_pages(user_id, page_id, watched_at)` —— 复合主键,
--      同 page_likes 同构。No FK(CLAUDE.md 硬约束),page hard-delete 时
--      由 pages.ts DELETE 递归 CTE 同事务清理;soft_delete 不删本表行,
--      restore 后用户仍是 watch 状态。
--   3. `notifications.kind` 是 text + 应用层 enum(not Postgres native
--      enum),新增 6 个 kind 值由 schema.ts 的 TypeScript enum 定义保证,
--      DB 端不需要 ALTER TYPE。
--   4. 索引:(user_id)单列给 "/me/watched" 列表走;
--      (page_id)单列给 "该页多少人关注" 用 COUNT(*)。

ALTER TABLE "pages" DROP COLUMN "starred";--> statement-breakpoint

CREATE TABLE "user_watched_pages" (
  "page_id" text NOT NULL,
  "user_id" text NOT NULL,
  "watched_at" bigint NOT NULL,
  CONSTRAINT "user_watched_pages_page_id_user_id_pk" PRIMARY KEY("page_id","user_id")
);--> statement-breakpoint

CREATE INDEX "user_watched_user_idx" ON "user_watched_pages" ("user_id");--> statement-breakpoint
CREATE INDEX "user_watched_page_idx" ON "user_watched_pages" ("page_id");--> statement-breakpoint

COMMENT ON TABLE "user_watched_pages" IS 'M13 关注订阅表。一行 = 一个用户对一个页面的 watch。Toggle 语义:同 page_likes 一致(SELECT-then-INSERT/DELETE),复合主键保证幂等。page hard-delete 时由 pages.ts DELETE 递归 CTE 同事务清理;soft_delete (deletedAt) 不删本表行,restore 后用户仍是 watch 状态。No FK(CLAUDE.md 硬约束)。';--> statement-breakpoint
COMMENT ON COLUMN "user_watched_pages"."page_id" IS '被关注的 page id。page 硬删后由 pages.ts DELETE 显式清理;软删 (deletedAt 非 null) 时保留。';--> statement-breakpoint
COMMENT ON COLUMN "user_watched_pages"."user_id" IS '关注者 user id。disabled / 删账号时由应用层 sweep;UI LEFT JOIN users 拿 null 兜底。';--> statement-breakpoint
COMMENT ON COLUMN "user_watched_pages"."watched_at" IS 'Date.now() ms,watch 起始时间。Sidebar "我的关注" section 与 /me Dashboard Watching tab 都按 DESC 走该字段。';