-- 0025_phase_d_anonymous_principal.sql
--
-- Phase D 预备 — 匿名 sentinel user。
--
-- 公开链接分享(public shares)是匿名访问:没有 login session,但要走
-- 现有的 canReadSpace / canReadPage 路径,需要一个"主体"参与 SQL。
-- 这里把匿名主体作为 users 表里一行 sentinel('anon', disabled 状态,
-- 不可登录),Principal 类型直接复用 user-kind + isAdmin=false。
--
-- 重要:不写 passwordHash(空字符串,通过 isDisabled/不可登录 防误用);
-- status='disabled' 是双重保险 —— 即使有人摸到 anon email 也不能登录。
-- email 用 'anonymous@power-wiki.local',跟现有 admin bootstrap 同
-- 域。ON CONFLICT DO NOTHING 幂等。
--
-- 这个迁移只管 INSERT sentinel;不在这里建 page_public_shares(那是
-- 0028_phase_d_page_public_shares.sql 的事)。
--
-- 注意:drizzle-kit migrate 对纯 SQL migration 静默 skip(项目已记此
-- 坑)。`pnpm -F api db:migrate` 之后如果没看到 __drizzle_migrations
-- 多一行,要手动:
--   INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES
--     ('25_phase_d_anonymous_principal_manual', 1783500000000);

INSERT INTO "users" (
  "id", "email", "name", "password_hash", "role", "status",
  "color", "created_at", "updated_at", "last_login_at",
  "avatar_kind", "avatar_ref"
) VALUES (
  'anon',
  'anonymous@power-wiki.local',
  '匿名访问',
  '',
  'user',
  'disabled',
  '#7A869A',
  1783500000000,
  1783500000000,
  NULL,
  NULL,
  NULL
)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- 注释
COMMENT ON COLUMN "users"."password_hash" IS
  'argon2id 哈希字符串。匿名 sentinel user (''anon'') 的 password_hash
   故意为空字符串 —— 它 status=''disabled'' 永远不可登录,只是占位让
   anonymous principal 走通用 user-kind 路径。';
