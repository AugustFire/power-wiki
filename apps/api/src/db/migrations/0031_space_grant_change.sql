-- 0031_space_grant_change.sql
--
-- 扩展 permission_audit.kind 的 CHECK 白名单,新增 space_grant_change 事件。
--
-- 背景:
--   0027_phase_c_permission_audit.sql 建表时 CHECK 限定 8 个权限变更事件
--   (grant add/remove/set、restriction add/remove/set、share create/revoke)。
--   0029 把资源生命周期 3 个也并进来,白名单升到 11。
--   本次新增 space_grant_change —— PUT /api/spaces/:id/permissions 在事务内
--   diff before/after 后,对「principal 仍在但 role 改了」的 grant 写细粒度
--   change 事件,而不是把整张表塞进一个 space_grant_set 的 payload。这样
--   审计行能直接看到「哪个 principal 从什么 role 改成什么 role」,不再被
--   「全量更新了空间成员角色」这种粗粒度摘要淹没。
--
--   space_grant_set kind 仍保留(可能还有历史行,UI 不删),但 PUT 端点
--   已不再写它。
--
-- 模式:DELETE 旧 CHECK,ADD 新 CHECK。约束名是 0027 自动生成的
-- `permission_audit_kind_check`(Postgres 默认命名)。DROP IF EXISTS 防重放。
--
-- 注意:drizzle-orm 的 migrator 对纯 SQL 文件偶尔会 silently skip(项目
-- 记忆:verify 时如发现新 CHECK 没生效,需要
--   DELETE FROM drizzle.__drizzle_migrations WHERE id = 31;
-- 然后重启 dev —— 强制重跑)。

ALTER TABLE "permission_audit" DROP CONSTRAINT IF EXISTS "permission_audit_kind_check";--> statement-breakpoint

ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_kind_check"
  CHECK ("kind" IN (
    'space_grant_set', 'space_grant_add', 'space_grant_remove', 'space_grant_change',
    'page_restriction_set', 'page_restriction_add', 'page_restriction_remove',
    'page_share_create', 'page_share_revoke',
    'space_deleted', 'group_deleted', 'user_anonymized'
  ));--> statement-breakpoint

-- 列注释更新:12 个合法值,权限变更 9 个 + 资源生命周期 3 个。
COMMENT ON COLUMN "permission_audit"."kind" IS
  '事件类型白名单。CHECK 限定 12 个合法值;新增事件同步改 CHECK + migration。
   权限变更 9 个(grant add/remove/change/set、restriction add/remove/set、share create/revoke)
   + 资源生命周期 3 个(space_deleted / group_deleted / user_anonymized)。';