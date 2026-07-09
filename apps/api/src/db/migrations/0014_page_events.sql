-- 0014_page_events.sql
--
-- P1-3 v2:page_events 事件表,作为活动流数据源。
--
-- 之前活动流从 pages.updated_at 派生,UI verb 写死成「编辑了」,掩盖了
-- create / move / restore / duplicate / publish 这些不同语义的事件。本表
-- 由写路径显式 INSERT,前端按 kind 渲染不同动词。
--
-- Drizzle migrate 对纯 SQL 迁移会静默跳过。本文件含 CREATE TABLE +
-- CREATE INDEX,Drizzle-tracked,无静默跳过风险。

CREATE TABLE IF NOT EXISTS "page_events" (
  "id" text PRIMARY KEY,
  "page_id" text NOT NULL,
  "space_id" text NOT NULL,
  -- enum: 'created' | 'edited' | 'moved' | 'restored' | 'duplicated' | 'published'
  -- 用 text + 应用层 enum 校验(避免 schema 升级被 DB enum 锁死)。
  "kind" text NOT NULL,
  -- actor 可空(理论上写路径都有 actor,但保留 nullable 容错)。
  "actor_id" text,
  -- 上下文 jsonb,move 存 from→to space,duplicate / publish 存 source id。
  "payload" jsonb,
  "created_at" bigint NOT NULL
);--> statement-breakpoint
COMMENT ON TABLE "page_events" IS 'workspace-wide 活动流数据源。写路径(POST /pages, PATCH, /move, /restore, /duplicate, /publish)显式插行,前端按 kind 渲染不同动词。无 FK(CLAUDE.md 硬约束):actor 删账号后事件行保留;page 硬删后事件行也保留作历史审计。';--> statement-breakpoint
COMMENT ON COLUMN "page_events"."id" IS 'nanoid 主键,跟其他表对齐。';--> statement-breakpoint
COMMENT ON COLUMN "page_events"."page_id" IS '事件关联的 page id。硬删后保留(审计)。';--> statement-breakpoint
COMMENT ON COLUMN "page_events"."space_id" IS '事件发生时 page 所属 space id。move 后会变;以事件发生时的值落表。';--> statement-breakpoint
COMMENT ON COLUMN "page_events"."kind" IS '事件类型: created/edited/moved/restored/duplicated/published。text + 应用层 enum。';--> statement-breakpoint
COMMENT ON COLUMN "page_events"."actor_id" IS '触发事件的 user id。disabled / 删账号后保留,前端 LEFT JOIN users 拿 null 兜底显示「已删除用户」。';--> statement-breakpoint
COMMENT ON COLUMN "page_events"."payload" IS '可选 jsonb 上下文:move 存 {fromSpaceId, toSpaceId};duplicate / publish 存 {sourcePageId}。前端 v0 不解析。';--> statement-breakpoint
COMMENT ON COLUMN "page_events"."created_at" IS 'ms since epoch。索引按 DESC 让活动流一次 index scan。';--> statement-breakpoint

-- 复合索引: ?space=<id> 的核心查询路径走 (space_id, created_at DESC)
CREATE INDEX IF NOT EXISTS "page_events_space_created_idx"
  ON "page_events" ("space_id", "created_at" DESC);--> statement-breakpoint
-- 单列索引: workspace-wide (无 space filter) 查询走 created_at DESC
CREATE INDEX IF NOT EXISTS "page_events_created_idx"
  ON "page_events" ("created_at" DESC);
