-- 0012_pages_updated_by.sql
--
-- P1-3 活动流的数据来源:pages 表加 updated_by 列(最近编辑者 user id)。
-- 老存量行 backfill 成 author_id(创建者 = "我" 至少不是 null)。
--
-- Drizzle migrate 会对纯 SQL 迁移静默跳过 — 加一个 CREATE INDEX
-- 让 drizzle-kit 把本文件识别为 Drizzle-tracked,避免线上漏跑。
-- 索引本身是 P1-3 活动流 WHERE updated_by=? ORDER BY updated_at DESC
-- 的 hot path,常驻用户每开一次 /activity 路由都跑。
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "updated_by" text;--> statement-breakpoint
COMMENT ON COLUMN "pages"."updated_by" IS '最近编辑者 user id。每次 PATCH / move / restore / soft-delete 同步更新。无 FK,disabled/deleted users 行保留不动,UI LEFT JOIN users 派生 name/color。P1-3 活动流的数据来源。';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_updated_by_idx" ON "pages" USING btree ("updated_by");--> statement-breakpoint
COMMENT ON INDEX "pages_updated_by_idx" IS '活动流 "某人最近改的页" hot path;同时让 drizzle-kit 把本迁移识别为 Drizzle-tracked,避免纯 SQL 静默跳过。';--> statement-breakpoint
UPDATE "pages" SET "updated_by" = "author_id" WHERE "updated_by" IS NULL;