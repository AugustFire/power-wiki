-- 0013_admin_settings.sql
--
-- P1-8 回收站保留期:新增 admin_settings 表(key-value),seed 默认
-- trash_retention_days=30。
--
-- Drizzle migrate 对纯 SQL 迁移会静默跳过。本文件含 CREATE TABLE
-- (Drizzle-tracked),无静默跳过风险。

CREATE TABLE IF NOT EXISTS "admin_settings" (
  "key" text PRIMARY KEY,
  "value" text NOT NULL,
  "updated_at" bigint NOT NULL,
  "updated_by" text
);--> statement-breakpoint
COMMENT ON TABLE "admin_settings" IS '全局 admin 配置 key-value 表。P1-8 引入,目前只存 trash_retention_days。设计上不强制每行存在,缺失的 key 走 lib/retention.ts fallback 默认值。';--> statement-breakpoint
COMMENT ON COLUMN "admin_settings"."key" IS '配置 key,e.g. trash_retention_days。主键。';--> statement-breakpoint
COMMENT ON COLUMN "admin_settings"."value" IS '字符串值,数字也以字符串存(避免 integer/float 强制类型)。前端 parseInt。';--> statement-breakpoint
COMMENT ON COLUMN "admin_settings"."updated_at" IS '最后修改时间 ms(跟其他表一致用 bigint mode number)。';--> statement-breakpoint
COMMENT ON COLUMN "admin_settings"."updated_by" IS '最后修改人 user id。无 FK,admin 删账号不级联 settings。';--> statement-breakpoint

-- Seed 默认保留期 30 天。INSERT ... ON CONFLICT DO NOTHING 保证已有
-- 用户的设置不被 0013 重置(如果之前手工塞过 row)。
INSERT INTO "admin_settings" ("key", "value", "updated_at", "updated_by")
VALUES ('trash_retention_days', '30', EXTRACT(EPOCH FROM NOW()) * 1000, NULL)
ON CONFLICT ("key") DO NOTHING;
