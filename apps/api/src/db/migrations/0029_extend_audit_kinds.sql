-- 0029_extend_audit_kinds.sql
--
-- 扩展 permission_audit.kind 与 target_kind 的 CHECK 白名单。
--
-- 背景:
--   0027_phase_c_permission_audit.sql 建表时 CHECK 限定 8 个权限变更事件
--   (grant add/remove/set、restriction add/remove/set、share create/revoke)。
--   本次把「资源生命周期」事件(空间删除 / 用户组删除 / 用户匿名化)也归到
--   这张表 —— 任何「会改变可见性 / 访问性」的事件都在一个时间线,审计查询
--   一次搞定,不用跨表 LEFT JOIN。
--
-- 模式:DELETE 旧 CHECK,ADD 新 CHECK。约束名是 0027 自动生成的
-- `permission_audit_kind_check` / `permission_audit_target_kind_check`
-- (Postgres 默认命名)。DROP IF EXISTS 防重放。
--
-- 注意:drizzle-orm 的 migrator 对纯 SQL 文件偶尔会 silently skip(项目
-- 记忆:verify 时如发现新 CHECK 没生效,需要
--   DELETE FROM drizzle.__drizzle_migrations WHERE id = 29;
-- 然后重启 dev —— 强制重跑)。

ALTER TABLE "permission_audit" DROP CONSTRAINT IF EXISTS "permission_audit_kind_check";--> statement-breakpoint

ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_kind_check"
  CHECK ("kind" IN (
    'space_grant_set', 'space_grant_add', 'space_grant_remove',
    'page_restriction_set', 'page_restriction_add', 'page_restriction_remove',
    'page_share_create', 'page_share_revoke',
    'space_deleted', 'group_deleted', 'user_anonymized'
  ));--> statement-breakpoint

ALTER TABLE "permission_audit" DROP CONSTRAINT IF EXISTS "permission_audit_target_kind_check";--> statement-breakpoint

ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_target_kind_check"
  CHECK ("target_kind" IN ('space', 'page', 'page_share', 'group', 'user'));--> statement-breakpoint

-- 表注释更新:补 3 个新事件类型。
COMMENT ON TABLE "permission_audit" IS
  '权限变更 + 资源生命周期审计日志。append-only,一行 = 一次访问性相关事件:
   权限变更:
     - space_grant_set / space_grant_add / space_grant_remove:空间角色变更
     - page_restriction_set / page_restriction_add / page_restriction_remove:页面限制变更
     - page_share_create / page_share_revoke:公开链接生命周期
   资源生命周期(本 migration 起合并到同一张表,审计时间线统一):
     - space_deleted:空间被 admin DELETE(目标是 shared space,personal space 拒绝)
     - group_deleted:用户组被 admin DELETE(pg-* 系统组不删)
     - user_anonymized:用户被 admin 匿名化(非真删,改 name/email/status,
       保留 authorship / comments / audit 行,sentinel 化)
   target_kind 取值:space / page / page_share / group / user。
   payload JSONB 存 {before, after} diff,schema 不约束具体形态。
   严格无 UPDATE / DELETE;应用层只 INSERT。No FK —— actor / target 被
   disable / delete 后行保留(audit 是历史快照)。';--> statement-breakpoint

-- 列注释更新:补 3 个 kind 的语义。
COMMENT ON COLUMN "permission_audit"."kind" IS
  '事件类型白名单。CHECK 限定 11 个合法值;新增事件同步改 CHECK + migration。
   权限变更 8 个 + 资源生命周期 3 个(space_deleted / group_deleted / user_anonymized)。';--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."target_kind" IS
  '目标类型。''space'' = spaces 行 / ''page'' = pages 行 / ''page_share'' =
   page_public_shares 行 / ''group'' = user_groups 行(group_deleted) /
   ''user'' = users 行(user_anonymized)。CHECK 限定合法值。';