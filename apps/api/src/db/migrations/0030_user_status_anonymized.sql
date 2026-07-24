-- 0030_user_status_anonymized.sql
--
-- M16 把 anonymized 升级为 users.status 第 4 态。
--
-- 背景:inbound:admin/anonymize 把 status 设成 'disabled',跟 admin 临时禁用
-- 的同名 status 混在一起,UI 与 admin 端点都分不清。enable footgun:
-- enable 端点只看 status='disabled' 就允许把 anonymized 行翻成 active,
-- 制造僵尸用户(name='已注销用户',email=.invalid,passwordHash 随机,
-- 还能重新进入 spacePermissions 候选)。见 adminUsers.ts enable / anonymize
-- 与 schema.ts status 字段注释。
--
-- 本次范围:
--   1) 加 DB-level CHECK(users_status_check)把 4 态写死到 DB。
--      0001 建 users 表时这一列没 CHECK,只靠 Drizzle / zod JS 层守,
--      本迁移顺手补齐。
--   2) 把现有已匿名化行(name='已注销用户' AND status='disabled')
--      就地升 status='anonymized'。Phase D 公开链接 sentinel user
--      (id='anon', name='匿名访问', 0025 phase_d_anonymous_principal)
--      name 不命中,不会被误伤。
--   3) status 列 COMMENT 同步补 'anonymized' 枚举语义。
--      schema.ts 字段 JSDoc 是事实来源,改一处必须同步另一处。
--
-- 注意:drizzle-kit 的 migrator 对纯 SQL 文件偶尔会 silently skip
-- (项目已知坑)。`pnpm -F api db:migrate` 之后如果
-- drizzle.__drizzle_migrations 缺第 30 行,手动:
--   DELETE FROM drizzle.__drizzle_migrations WHERE id = 30;
-- 然后重启 dev —— 强制重跑。

-- Step 1: 4 态白名单 DB CHECK(以前 DB 层无 CHECK,只 JS 层守)
ALTER TABLE "users" ADD CONSTRAINT "users_status_check"
  CHECK ("status" IN ('active', 'disabled', 'must_reset_password', 'anonymized'));--> statement-breakpoint

-- Step 2: 把现有已匿名化行就地升 status
UPDATE "users" SET "status" = 'anonymized'
  WHERE "name" = '已注销用户' AND "status" = 'disabled';--> statement-breakpoint

-- Step 3: 列注释同步 4 态
COMMENT ON COLUMN "users"."status" IS
  '账号状态。''active''(正常)/''disabled''(admin 临时禁用,enable 可恢复)/
   ''must_reset_password''(新建/重置密码后待首次重设)/''anonymized''
   (admin 匿名化,不可逆 —— name/email/password/avatar 全清;sweep
   见 apps/api/src/routes/adminUsers.ts anonymize handler)。
   CHECK users_status_check 限定 4 态(迁移 0030 加)。';
