-- 0011_fix_schema_drift.sql
--
-- 修正 schema JSDoc 与 SQL COMMENT 的 3 处 drift(CLAUDE.md 硬约束第 10 条)。
-- 这是个纯 SQL 注释 / 索引修正迁移,drizzle-kit 对纯 SQL 迁移会
-- 静默跳过,所以迁移后必须 psql 验证 3 处真实生效。
--
-- 三处修正:
--   1. users.password_hash:SQL 注释写 bcrypt(错,实际是 argon2id)
--   2. notifications.kind:SQL 注释缺 page_like(落后,schema.ts enum 已含)
--   3. page_likes_page_idx:schema JSDoc 提到但 0010 没建(性能隐患)

-- 1. 修正密码哈希注释:实际是 argon2id(@node-rs/argon2,见 apps/api/src/auth/password.ts)
COMMENT ON COLUMN "users"."password_hash" IS 'argon2id 密码哈希(由 @node-rs/argon2 生成,$argon2id$v=19$m=...,t=...,p=...$salt$hash 格式)。登录时 verifyPassword 常量时间校验。';--> statement-breakpoint

-- 2. 补通知类型注释:schema.ts enum 已含 page_like(0010 引入),SQL 注释落后
COMMENT ON COLUMN "notifications"."kind" IS 'mention | reply | comment_on_my_page | page_like';--> statement-breakpoint

-- 3. 补点赞表缺失索引:schema.ts JSDoc 提到 "page_likes_page_idx (page_id 单独)",
--    但 0010 没建。"某页点赞数" correlated subquery 现在走全表,
--    加索引后 COUNT(*) 走 index-only scan。
CREATE INDEX IF NOT EXISTS "page_likes_page_idx" ON "page_likes" USING btree ("page_id");--> statement-breakpoint
COMMENT ON INDEX "page_likes_page_idx" IS '某页点赞数 correlated subquery hot path(selectPagesWithAuthor 的 likesCount 子查询)。';