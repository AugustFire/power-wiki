-- 0024_phase_a_space_role_grants.sql
--
-- Phase A — 空间角色分层(Confluence 风格)。
--
-- 新表 space_role_grants 显式表达「一个 principal 在一个 space 的角色」。
-- 三档:viewer(只读)/ editor(读+写)/ admin(读+写+管理)。principal 可以是
-- 单个 user(principal_kind='user',直授外部协作者)或一个 user_group
-- (principal_kind='group',与 legacy space_group_access 同构)。
--
-- 向后兼容(关键):**本 migration 不做 DML backfill**。legacy
-- space_group_access 行继续有效,lib/permissions.effectiveSpaceRole()
-- 会 UNION 两表,legacy 行默认视为 role='editor'(最宽松,保留旧行为:
-- 任何组能进 = 全文读写)。
--
-- 为什么不 backfill:
--   - 既有授权语义被打破的风险(任何把 legacy 视作 viewer 的选择都会
--     静默断编辑)—— 默认 'editor' 不需要 backfill,effectiveSpaceRole
--     合并读取已经满足。
--   - 既有的 space_group_access 行的 actor 信息(group_id 是无时间戳的
--     「一直存在」语义),backfill 过去拿不到合理的 granted_by / granted_at。
--   - 迁移:admin 后续用新 UI(SpacePermissionsView)显式 PUT 一次,
--     旧行通过 adminGroups / adminSpaces DELETE 时的 sweep 自然消失。
--
-- 无 FK(CLAUDE.md 硬约束):cleanup 由 adminSpaces/adminGroups/adminUsers
-- DELETE 在事务内显式 DELETE FROM space_role_grants WHERE ...。
--
-- 'admin' 不能授予 group(同约束):由 routes/spacePermissions.ts
-- assertNotAdminToGroup 在路由层校验,DB 层不强制(避免触发 CHECK 失败
-- 时的整事务回滚,UI 提示更清晰)。

CREATE TABLE "space_role_grants" (
  "id" text PRIMARY KEY,
  "space_id" text NOT NULL,
  "principal_kind" text NOT NULL CHECK ("principal_kind" IN ('user', 'group')),
  "principal_id" text NOT NULL,
  "role" text NOT NULL CHECK ("role" IN ('viewer', 'editor', 'admin')),
  "granted_by" text,
  "granted_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX "space_role_grants_space_idx" ON "space_role_grants" ("space_id");--> statement-breakpoint

CREATE INDEX "space_role_grants_principal_idx" ON "space_role_grants" ("principal_kind", "principal_id");--> statement-breakpoint

CREATE UNIQUE INDEX "space_role_grants_space_principal_uq" ON "space_role_grants" ("space_id", "principal_kind", "principal_id");--> statement-breakpoint

-- 表注释
COMMENT ON TABLE "space_role_grants" IS
  'Phase A 空间角色授予表。一行 = (space, principal, role) 的显式授权。
   principalKind=''user'' 表示单个用户直接授予(可用于未入组的外部协作者),
   principalKind=''group'' 表示整组授予(同构语义对齐 legacy space_group_access)。
   角色三档:viewer(只读)/ editor(读+写)/ admin(读+写+管理)。
   admin 角色不能授予 group —— 路由层 assertNotAdminToGroup 强制(见
   routes/spacePermissions.ts);Confluence 也不允许组级 space admin(审计
   模糊:谁代表组执行?)。
   同 (space, principal_kind, principal_id) 唯一(由 space_role_grants_space_principal_uq 强制)。
   与 legacy space_group_access 表并存:effectiveSpaceRole() UNION 两表,
   legacy 行默认视为 ''editor''(最宽松,保留旧行为);新写入走本表。
   No FK(CLAUDE.md 硬约束)—— cleanup 由 adminGroups/adminUsers/
   adminSpaces DELETE 在事务内显式 sweep。';--> statement-breakpoint

-- 列注释
COMMENT ON COLUMN "space_role_grants"."id" IS
  'nanoid(10) —— 跟其他表 ID 同套,字母表见 apps/api/src/lib/ids.ts。';--> statement-breakpoint

COMMENT ON COLUMN "space_role_grants"."space_id" IS
  'spaces.id。无 FK —— adminSpaces DELETE handler 在同一事务内
   DELETE FROM space_role_grants WHERE space_id = ? cascade。';--> statement-breakpoint

COMMENT ON COLUMN "space_role_grants"."principal_kind" IS
  '主体类型。''user'' = 单个用户直接授予(可用于未入任何组的外部协作者);
   ''group'' = 整组授予(与 legacy space_group_access 同构语义)。
   CHECK 限定合法值。';--> statement-breakpoint

COMMENT ON COLUMN "space_role_grants"."principal_id" IS
  '主体 id:
   - principal_kind=''user''  → users.id
   - principal_kind=''group'' → user_groups.id
   No FK。disabled / deleted 主体的行保留(由 adminGroups / adminUsers
   DELETE sweep)。';--> statement-breakpoint

COMMENT ON COLUMN "space_role_grants"."role" IS
  '角色。''viewer''(只读)/ ''editor''(读+写)/ ''admin''(读+写+管理)。
   CHECK 限定合法值。
   路由层约束:不能把 ''admin'' 授予 group(见
   routes/spacePermissions.ts:assertNotAdminToGroup)。';--> statement-breakpoint

COMMENT ON COLUMN "space_role_grants"."granted_by" IS
  '授予人 user id。null = 系统操作(ensurePersonalSpace 创建个人空间时
   自动插入的 grant 走 system actor)。
   No FK —— 授予人被 disable / delete 后行保留(audit 可读「当时谁给的」)。';--> statement-breakpoint

COMMENT ON COLUMN "space_role_grants"."granted_at" IS
  'Date.now() 毫秒。授予时间。';--> statement-breakpoint

-- 索引注释(只对 UNIQUE 索引加 COMMENT,普通索引 schema 已自描述)
COMMENT ON INDEX "space_role_grants_space_idx" IS
  '拉单个空间的所有 grants(空间设置页)的热路径。';--> statement-breakpoint

COMMENT ON INDEX "space_role_grants_principal_idx" IS
  '解析一个用户的有效角色(对当前用户的所有空间),permission SQL 核心 join 列。';--> statement-breakpoint

COMMENT ON INDEX "space_role_grants_space_principal_uq" IS
  '幂等 UPSERT + 同 (space, principal) 一行约束。POST .../permissions/...
   ON CONFLICT DO UPDATE 走这个 unique。'
