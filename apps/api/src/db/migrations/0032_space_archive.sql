-- 0032_space_archive.sql
--
-- 注意:drizzle-orm 的 migrator 对纯 SQL 文件偶尔会 silently skip(项目
-- 记忆:verify 时如发现新列 / CHECK 没生效,需要
--   DELETE FROM drizzle.__drizzle_migrations WHERE id = 32;
-- 然后重启 dev —— 强制重跑)。如重跑仍不生效,在 postgres 容器里手动执行:
--   docker exec power-wiki-postgres psql -U power_wiki -d power_wiki -f \
--     apps/api/src/db/migrations/0032_space_archive.sql
--
-- P1-1: 空间归档状态。
--
-- 背景:
--   power-wiki 之前空间生命周期只有「创建 / 修改 / 删除」。团队结束后不想
--   直接删(为了保留历史文档),但又不能继续显示在主 switcher,只能两边都不
--   讨好。本迁移引入归档(archive / unarchive)二态,跟 P1-1 §建议对齐:
--     - 归档后从普通空间切换器中隐藏
--     - 页面保留可读(成员可以继续看)
--     - 默认禁止新增和编辑(canEditSpace 在 archived 时返 false,统一覆盖
--       pages/comments/labels/attachments 各写路径)
--     - 管理员可以恢复(unarchive)
--     - 删除仍然作为更重的最终操作(物理删,语义不重叠)
--
-- 模式:ALTER TABLE 加列 + CHECK 约束 + COMMENT ON COLUMN。
--   两个新列都是 nullable —— kind='personal' 的空间永远 NULL(矩阵不允许
--   个人空间归档,见下 CHECK);shared 空间默认 NULL 表示「未归档」。
--   现有 shared 行不需要 backfill:NULL 即未归档。
--
-- CHECK 约束(命名 spaces_archived_kind_check):
--   个人空间没有「归档」概念 —— owner 的 scratchpad 由 user anonymize
--   处理(删用户 → 个人空间 sweep)。如果允许 personal 归档,owner 登录
--   后看不到个人空间(被 switcher / list 过滤),会以为数据没了。架构上
--   必须 reject。
--
-- 同时 0027 的 permission_audit.kind CHECK 白名单需要扩两个事件:
--   space_archived / space_unarchived —— 跟已有 space_deleted 同一类
--   (资源生命周期),记录归档 / 恢复动作的 actor + before / after 状态。

-- ─── 1) 归档两列 ────────────────────────────────────────────
ALTER TABLE "spaces" ADD COLUMN "archived_at" bigint;--> statement-breakpoint

ALTER TABLE "spaces" ADD COLUMN "archived_by_user_id" text;--> statement-breakpoint

-- ─── 2) CHECK:personal 不可归档 ──────────────────────────────
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_archived_kind_check"
  CHECK (kind <> 'personal' OR archived_at IS NULL);--> statement-breakpoint

-- ─── 3) 列注释 ──────────────────────────────────────────────
COMMENT ON COLUMN "spaces"."archived_at" IS
  '归档时间(Date.now() 毫秒)。null = 未归档,非 null = 已归档。canEditSpace
   在 archived_at 非 null 时返 false,统一拦截所有写路径;unarchive 路由把
   该列重置为 null。CHECK spaces_archived_kind_check 强制 personal space
   永远为 null —— 个人空间走 owner anonymize 路径,不属于归档语义。';--> statement-breakpoint

COMMENT ON COLUMN "spaces"."archived_by_user_id" IS
  '归档操作者 user id。archive 路由写入,unarchive 路由同事务置 null。No FK
   —— 保留作审计上下文,被 disable 的用户不级联清空;permission_audit
   (kind=''space_archived'' / ''space_unarchived'') 是事实来源。';--> statement-breakpoint

-- ─── 4) permission_audit.kind 白名单扩 2 个 ───────────────
-- 模式跟 0031 一致:DROP 旧 CHECK + ADD 新 CHECK 重新枚举合法值。
-- 0031 的白名单是 12 个,本迁移加到 14 个。命名 permission_audit_kind_check
-- 是 0027 默认生成的,不变。

ALTER TABLE "permission_audit" DROP CONSTRAINT IF EXISTS "permission_audit_kind_check";--> statement-breakpoint

ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_kind_check"
  CHECK ("kind" IN (
    'space_grant_set', 'space_grant_add', 'space_grant_remove', 'space_grant_change',
    'page_restriction_set', 'page_restriction_add', 'page_restriction_remove',
    'page_share_create', 'page_share_revoke',
    'space_deleted', 'group_deleted', 'user_anonymized',
    'space_archived', 'space_unarchived'
  ));--> statement-breakpoint

COMMENT ON COLUMN "permission_audit"."kind" IS
  '事件类型白名单。CHECK 限定合法值;新增事件同步改 CHECK + migration。
   权限变更 9 个(grant add/remove/change/set、restriction add/remove/set、share create/revoke)
   + 资源生命周期 5 个(space_deleted / group_deleted / user_anonymized 加上 0032 起新增的 space_archived / space_unarchived)。';
