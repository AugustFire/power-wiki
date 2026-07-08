-- 0010_add_page_likes.sql
--
-- 顶栏 👍 用的 page_likes 表。一行 = 一个用户对一页的一次点赞。
-- Toggle 语义:后端 SELECT-then-INSERT/DELETE,不需要单独 unliked 标志。
-- 复合主键 (page_id, user_id) 保证幂等。
-- 无外键(硬约束:CLAUDE.md 第 6 条),page hard-delete 时由
-- pages.ts DELETE 递归 CTE 显式清理。
CREATE TABLE IF NOT EXISTS "page_likes" (
  "page_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" bigint NOT NULL,
  CONSTRAINT "page_likes_page_id_user_id_pk" PRIMARY KEY("page_id","user_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_likes_user_idx" ON "page_likes" USING btree ("user_id");--> statement-breakpoint
COMMENT ON TABLE "page_likes" IS '页面点赞。一行 = (page_id, user_id) 的一次点赞记录,toggle 语义:SELECT 后 INSERT 或 DELETE,前端只调一个 /:id/like 端点。无外键,page hard-delete 时由 pages.ts DELETE 递归 CTE 显式清理。';--> statement-breakpoint
COMMENT ON COLUMN "page_likes"."page_id" IS '所属页面 id。无 FK,page purge 时显式清掉。';--> statement-breakpoint
COMMENT ON COLUMN "page_likes"."user_id" IS '点赞用户 id。无 FK,disabled/deleted users 的行未来由 app code 清理。';--> statement-breakpoint
COMMENT ON COLUMN "page_likes"."created_at" IS 'Date.now() 毫秒,点赞时间;当前 UI 不展示具体时间,仅供 audit / 排序用。';--> statement-breakpoint
COMMENT ON INDEX "page_likes_user_idx" IS '未来 "我赞过哪些页面" 查询路径;现阶段未使用,先对齐 page_labels.user_idx 的命名一致性。';
