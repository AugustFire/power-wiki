-- 0027_phase_c_permission_audit.sql
--
-- Phase C — 权限变更审计日志(append-only)。
--
-- 一行 = 一次权限变更事件(space grant add/remove/set、page restriction
-- add/remove/set;Phase D 的 page_share create/revoke 同款形态)。
--
-- 设计要点:
--   - 严格 append-only:无 UPDATE / DELETE 入口;应用层只 INSERT。
--     audit 永远不被级联 —— 即使被改的 user/group/space/page 被删了,
--     审计行保留(audit 本身就是"那时的快照")。
--   - payload 是 JSONB,存 {before, after} 形态 diff,类型不限。schema
--     上的 jsonb 列不加 CHECK,业务层(recordPermissionAudit)约束形态。
--   - CHECK 约束:kind 取值白名单、target_kind 取值白名单,DB 层强制。
--   - 无 DML backfill。新表默认空,Phase C 上线后第一次 mutation 自
--     然产生第一条 audit 行。
--
-- 索引:
--   - (target_kind, target_id, created_at DESC): 查「某 page / space 的
--     权限变更历史」热路径。
--   - (actor_id, created_at DESC): 查「某 user 改过哪些权限」。
--   - (created_at DESC): 通用 list 路径(最新 N 条 audit)。

CREATE TABLE "permission_audit" (
  "id" text PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN (
    'space_grant_set', 'space_grant_add', 'space_grant_remove',
    'page_restriction_set', 'page_restriction_add', 'page_restriction_remove',
    'page_share_create', 'page_share_revoke'
  )),
  "actor_id" text NOT NULL,
  "target_kind" text NOT NULL CHECK ("target_kind" IN ('space', 'page', 'page_share')),
  "target_id" text NOT NULL,
  "created_at" bigint NOT NULL,
  "payload" jsonb
);--> statement-breakpoint

CREATE INDEX "permission_audit_target_idx" ON "permission_audit" ("target_kind", "target_id", "created_at" DESC);--> statement-breakpoint

CREATE INDEX "permission_audit_actor_idx" ON "permission_audit" ("actor_id", "created_at" DESC);--> statement-breakpoint

CREATE INDEX "permission_audit_created_idx" ON "permission_audit" ("created_at" DESC);--> statement-breakpoint

-- 表注释
COMMENT ON TABLE "permission_audit" IS
  'Phase C 权限变更审计日志。append-only,一行 = 一次权限变更事件:
   - space_grant_set / space_grant_add / space_grant_remove:空间角色变更
   - page_restriction_set / page_restriction_add / page_restriction_remove:页面限制变更
   - page_share_create / page_share_revoke(Phase D 占位)
   target_kind = space / page / page_share。
   payload JSONB 存 {before, after} diff,schema 不约束具体形态。
   严格无 UPDATE / DELETE;应用层只 INSERT。No FK —— actor / target 被
   disable / delete 后行保留(audit 是历史快照)。';--> statement-breakpoint

-- 列注释
COMMENT ON COLUMN "permission_audit"."id" IS
  'nanoid(10) —— 同其他表 ID 字母表。';--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."kind" IS
  '事件类型白名单。CHECK 限定 8 个合法值;后续加新事件类型要同步改 CHECK + migration。';--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."actor_id" IS
  '操作人 user id。No FK —— 哪怕被 disable / delete 了,audit 行也保留(audit 是历史快照,
   后续 admin 查「为什么这页现在被限制」能看到「当时是 X 操作的」)。';--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."target_kind" IS
  '目标类型。''space'' = spaces 行 / ''page'' = pages 行 / ''page_share'' =
   page_public_shares 行(Phase D 占位)。CHECK 限定合法值。';--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."target_id" IS
  'target_kind 对应表的主键。No FK —— 同 actor_id 语义,即使目标被
   删了 audit 行也保留。';--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."created_at" IS
  'Date.now() 毫秒。';--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."payload" IS
  'JSONB,存 {before, after} diff:
   - space_grant_set: {before: SpaceGrants, after: SpaceGrants}
   - page_restriction_set: {before: {view, edit}, after: {view, edit}}
   - *_add: {after: 单行限制}
   - *_remove: {before: 单行限制}
   schema 不强约束形态,业务层 recordPermissionAudit 写入。null = 该事件无 diff
   信息(保留列兼容)。';--> statement-breakpoint

-- 索引注释
COMMENT ON INDEX "permission_audit_target_idx" IS
  '查「某 page / space 的权限变更历史」热路径,按时间倒序。';--> statement-breakpoint

COMMENT ON INDEX "permission_audit_actor_idx" IS
  '查「某 user 改过哪些权限」(合规审计常用),按时间倒序。';--> statement-breakpoint

COMMENT ON INDEX "permission_audit_created_idx" IS
  '通用 list 路径(最新 N 条 audit / 时间段扫描),按时间倒序。';