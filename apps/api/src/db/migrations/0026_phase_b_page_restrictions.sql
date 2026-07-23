-- 0026_phase_b_page_restrictions.sql
--
-- Phase B — 页面级限制(Confluence 风格)。
--
-- 新表 page_restrictions 显式表达「一个 principal 在一个 page 的某 kind 限制下
-- 出现在 allow-list」。kind='view' 表示 view 限制生效(除列表中 principal 外
-- 其他人不能读);kind='edit' 表示 edit 限制生效(同上但只约束写)。
--
-- 反 default-deny 语义:page_restrictions 表里有 kind='view' 行 = 限制生效;
-- 没有行 = 不限制(按 space 角色走)。
--
-- 向后兼容(关键):**无 DML backfill**。新表默认空,所有页面走原有 canAccessSpace
-- / canEditSpace 行为,行为不变。Phase B 上线时:管理员显式对个别 page 调
-- PUT /api/pages/:id/restrictions 加限制,后续默认带。
--
-- 继承语义(关键不变量,lib/permissions.ts 的 canReadPage 实现):
--   - view 继承:任一祖先有 view 限制 → 子页 view 默认收紧(BFS 累计 allow-list)
--   - edit 不继承:父页有 edit 限制 → 子页不受影响(子页自己有 edit 限制就只
--     约束子页),这是 Confluence 的既定行为。
--
-- 角色作者本人 + global admin 始终 full(permissions.ts 短路,不走 allow-list)。
--
-- No FK(CLAUDE.md 硬约束):cleanup 由 pages.ts DELETE ?purge=true 在事务
-- 内显式 sweep。
--
-- CHECK 约束:kind ∈ {view, edit},principal_kind ∈ {user, group}。DB 层强制,
-- 不依赖应用层校验(空字符串 / 拼写错会被 PG 拒掉)。

CREATE TABLE "page_restrictions" (
  "id" text PRIMARY KEY,
  "space_id" text NOT NULL,
  "page_id" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('view', 'edit')),
  "principal_kind" text NOT NULL CHECK ("principal_kind" IN ('user', 'group')),
  "principal_id" text NOT NULL,
  "granted_by" text,
  "granted_at" bigint NOT NULL
);--> statement-breakpoint

CREATE INDEX "page_restrictions_page_idx" ON "page_restrictions" ("page_id");--> statement-breakpoint

CREATE INDEX "page_restrictions_principal_idx" ON "page_restrictions" ("kind", "principal_kind", "principal_id");--> statement-breakpoint

CREATE UNIQUE INDEX "page_restrictions_page_kind_principal_uq" ON "page_restrictions" ("page_id", "kind", "principal_kind", "principal_id");--> statement-breakpoint

-- 表注释
COMMENT ON TABLE "page_restrictions" IS
  'Phase B 页面级限制表。一行 = (page, kind, principal) 的 allow-list 显式授权。
   kind=''view'' 表示 view 限制生效(除列表中 principal 外其他人不能读);
   kind=''edit'' 表示 edit 限制生效(同理,只约束写)。
   反 default-deny 语义:page_restrictions 表里有某 kind 行 = 限制生效;
   没有行 = 不限制(按 space 角色走 canReadSpace / canEditSpace)。
   继承(关键不变量,lib/permissions.ts 的 canReadPage 实现):
   - view 继承父链:任一祖先有 view 限制 → 子页 view 默认收紧(BFS 累计 allow-list)
   - edit 不继承:父页有 edit 限制 → 子页不受影响(子页自己显式限制才约束子页)
   这跟 Confluence 的既定行为一致。
   作者本人 + global admin 始终 full(permissions.ts 短路,不走 allow-list 校验)。
   No FK(CLAUDE.md 硬约束)—— cleanup 由 pages.ts DELETE ?purge=true
   handler 在事务内显式 DELETE FROM page_restrictions WHERE page_id = ? cascade。
   同 (page, kind, principal_kind, principal_id) 唯一(由
   page_restrictions_page_kind_principal_uq 强制)。';--> statement-breakpoint

-- 列注释
COMMENT ON COLUMN "page_restrictions"."id" IS
  'nanoid(10) —— 跟其他表 ID 同套,字母表见 apps/api/src/lib/ids.ts。';--> statement-breakpoint

COMMENT ON COLUMN "page_restrictions"."space_id" IS
  'pages.space_id。冗余存一份是为了让 SQL 在按 (space, kind, principal) 反查
   「某空间内某 principal 被列入了多少页的限制」时直接走索引,不需要再 JOIN pages。
   写入时与 page 行的 space_id 保持一致(同事务约束);No FK —— page 删除时
   由 pages.ts DELETE ?purge=true 在同事务内 sweep page_restrictions。';--> statement-breakpoint

COMMENT ON COLUMN "page_restrictions"."page_id" IS
  'pages.id。无 FK —— adminPages DELETE ?purge=true 在同一事务内
   DELETE FROM page_restrictions WHERE page_id = ? cascade。';--> statement-breakpoint

COMMENT ON COLUMN "page_restrictions"."kind" IS
  '限制类型。''view'' = 限制谁能看该页;''edit'' = 限制谁能改该页。
   view 继承父链(任一祖先有 view 限制 → 子页 view 默认收紧);
   edit 不继承(父页有 edit 限制不影响子页,子页自己显式限制才约束子页)。
   CHECK 限定合法值。';--> statement-breakpoint

COMMENT ON COLUMN "page_restrictions"."principal_kind" IS
  '主体类型。''user'' = 单个用户直接列入 allow-list;''group'' = 整组列入。
   CHECK 限定合法值。';--> statement-breakpoint

COMMENT ON COLUMN "page_restrictions"."principal_id" IS
  '主体 id:
   - principal_kind=''user''  → users.id
   - principal_kind=''group'' → user_groups.id
   No FK。disabled / deleted 主体的行保留(由 admin 端 sweep)。';--> statement-breakpoint

COMMENT ON COLUMN "page_restrictions"."granted_by" IS
  '授予人 user id。null = 系统操作(bootstrap / 迁移等)。
   No FK —— 授予人被 disable / delete 后行保留(audit 可读「当时谁给的」)。';--> statement-breakpoint

COMMENT ON COLUMN "page_restrictions"."granted_at" IS
  'Date.now() 毫秒。授予时间。';--> statement-breakpoint

-- 索引注释(只对 UNIQUE 索引加 COMMENT,普通索引 schema 已自描述)
COMMENT ON INDEX "page_restrictions_page_idx" IS
  '拉单个 page 的所有 restrictions(view + edit allow-list 一起)的热路径。';--> statement-breakpoint

COMMENT ON INDEX "page_restrictions_principal_idx" IS
  '反向解析:某 principal 在某 kind 的限制下被列入了多少页(用于 audit 跟管理
   UI 的「这个用户的限制」视图)。';--> statement-breakpoint

COMMENT ON INDEX "page_restrictions_page_kind_principal_uq" IS
  '幂等 UPSERT + 同 (page, kind, principal) 一行约束。POST
   .../restrictions/{view|edit}/users/:id ON CONFLICT DO UPDATE 走这个 unique。'
