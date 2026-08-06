-- 0036_page_locks.sql
--
-- Phase A 实时协同 Phase 4 落地:page_locks 表 ——「页面编辑锁」,UI 提示
-- 「Alice 正在编辑」banner / ReadView Edit tooltip。锁 ≠ 写权限闸,Yjs CRDT
-- 始终接受合法 canEditPage 用户的 update;锁唯一作用是避免两个 user 大改
-- 时互相覆盖造成混乱。
--
-- 与 0035 同款规则:drizzle-orm 对纯 SQL migration 偶发 silently skip。
-- 跑完如发现新表没生效,在 postgres 容器里手动重跑:
--   docker exec power-wiki-postgres psql -U power_wiki -d power_wiki -f \
--     apps/api/src/db/migrations/0036_page_locks.sql
-- 或 DELETE FROM drizzle.__drizzle_migrations WHERE id = 36; 后重启 dev。

CREATE TABLE "page_locks" (
  "page_id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "acquired_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL
);--> statement-breakpoint

COMMENT ON TABLE "page_locks" IS
  '页面编辑锁(Phase A 实时协同 Phase 4 / 2026-08-05 落地)。一行 = 一个 page
   当前被锁住的快照。锁的唯一作用是 UI 提示(避免「Alice 大改时 Bob 乱入」),
   **不是**写权限闸 — Yjs CRDT 始终接受合法 canEditPage 用户的 update,
   没拿锁的 user 照常能编辑,只是 banner / tooltip 告知「有人正在改」。

   5 分钟自动过期:expiresAt = acquiredAt + 5*60*1000。前端每秒轮询一次
   /api/pages/:id/lock 算倒计时;server 端 acquire 时先 SELECT 一次,若现有
   锁 expiresAt < now() 则视为过期可覆盖(防网抖期间两个 user 同时拿锁)。

   强制接管:admin 可 POST /api/pages/:id/lock/takeover,server 端会用
   Hocuspocus stateless 给原 holder 发 lock_takeover 消息 + close conn(4410),
   同时 UPSERT 本表 user_id = admin;holder 端 uiStore 弹 lock_taken toast。

   No FK(项目硬约束,CLAUDE.md 第 7 条):page hard-delete 时由 pages.ts DELETE
   ?purge=true 在同事务内显式 sweep 本表;admin 接管 / 自然过期由各自路径
   覆盖或 DELETE 本行。';--> statement-breakpoint

COMMENT ON COLUMN "page_locks"."page_id" IS
  'pages.id,nanoid(10)。No FK。';--> statement-breakpoint

COMMENT ON COLUMN "page_locks"."user_id" IS
  '当前锁持有人 users.id。acquire / takeover 时覆盖;release 时删除本行。';--> statement-breakpoint

COMMENT ON COLUMN "page_locks"."acquired_at" IS
  'Date.now() 毫秒 — 锁被 acquire 或 takeover 时写入。';--> statement-breakpoint

COMMENT ON COLUMN "page_locks"."expires_at" IS
  'Date.now() 毫秒 = acquiredAt + 5*60*1000。前端每秒轮询算倒计时显示;
   server 端 acquire 时遇到 expiresAt < now() 的过期锁直接覆盖。';