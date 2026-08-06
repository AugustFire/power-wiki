-- 0035_collab.sql
--
-- Phase A 实时协同 Phase 1 落地:page_yjs_state 表 —— Hocuspocus server
-- 持久化每个 page 的 Y.Doc 状态(awareness-only / shared CRDT body 都走
-- 这张表,不再额外分表)。
--
-- 触发场景:
--   - 用户 A 在 ReadView / EditView 打开某 page,Hocuspocus provider 建立
--     WS 连接 → onLoadDocument 拉本表 state 应用到 Y.Doc。
--   - 用户编辑 / 多人协同 → Hocuspocus 自带 2s debounce 合并 burst →
--     onStoreDocument 把 Y.encodeStateAsUpdate(doc) UPSERT 进本表。
--   - 用户全部断开 → 文档 unload,内存释放,下次连接重新 onLoadDocument。
--
-- 与 0033 同款规则:drizzle-orm 对纯 SQL migration 偶发 silently skip。
-- 跑完如发现新表没生效,在 postgres 容器里手动重跑:
--   docker exec power-wiki-postgres psql -U power_wiki -d power_wiki -f \
--     apps/api/src/db/migrations/0035_collab.sql
-- 或 DELETE FROM drizzle.__drizzle_migrations WHERE id = 35; 后重启 dev。

CREATE TABLE "page_yjs_state" (
  "page_id" text PRIMARY KEY,
  "state" bytea NOT NULL,
  "byte_size" integer NOT NULL,
  "updated_at" bigint NOT NULL
);--> statement-breakpoint

COMMENT ON TABLE "page_yjs_state" IS
  'Yjs 协同编辑状态持久化(Phase A 实时协同 / 2026-08-05 落地)。一行 = 一个 page 的 Y.Doc
   状态。Hocuspocus server 的 onStoreDocument 钩子在 2s debounce 合并后把
   Y.encodeStateAsUpdate(doc) 落库;onLoadDocument 启动时拉回 bytea 应用
   到 Y.Doc。冷启动 hydration(Phase 2):首次连接且本表无 state 时从
   pages.contentJson 用 prosemirrorJSONToYDoc 重建;本表暂不立刻回写,
   留待首次 client edit 触发 onStoreDocument 再持久化。

   byte_size 是运维告警位(>1MB 触发拆分 / 归档);不上 CHECK(允许 0 = 刚
   INSERT 但还没 flush 过 state 的中间态)。不做 version 列:30s idle
   snapshot(Phase 5 收口)+ lock boundary 只写 page_versions + 本表,不在
   本表叠加历史。

   No FK(项目硬约束,CLAUDE.md 第 7 条):page hard-delete 时由 pages.ts
   DELETE ?purge=true 在同事务内显式 sweep 本表;page soft-delete (deletedAt)
   不动本表 —— restore 后协作文档状态仍在。';--> statement-breakpoint

COMMENT ON COLUMN "page_yjs_state"."page_id" IS
  'pages.id,nanoid(10)。No FK。';--> statement-breakpoint

COMMENT ON COLUMN "page_yjs_state"."state" IS
  'Y.encodeStateAsUpdate(doc) 产物 —— node-postgres 解析为 Buffer,
   Drizzle customType 在 schema.ts 暴露成 Uint8Array。bytea 列存原始字节,
   不解析、不压缩。';--> statement-breakpoint

COMMENT ON COLUMN "page_yjs_state"."byte_size" IS
  '冗余字节数,运维告警位(>1MB 提示拆分 / 归档)。不上 CHECK,允许 0 = 刚
   INSERT 但还没 flush 过 state 的中间态。';--> statement-breakpoint

COMMENT ON COLUMN "page_yjs_state"."updated_at" IS
  'Date.now() 毫秒 —— onStoreDocument 写入时间。';
