-- 0028_phase_d_page_public_shares.sql
--
-- Phase D — 公开链接分享(anonymous read-only)。
--
-- 一行 = 一个公开链接(anonymous 读权限)。明文 token 只在 POST 创建时
-- 返一次,DB 只存 sha256(token) hex;泄露 DB 也无法还原活 token(verify
-- 关键 case:§db_dump_no_plaintext_token)。
--
-- 设计要点:
--   - **严格 No FK(CLAUDE.md)**:page 被 purge 时由 route handler 在事务
--     内显式 sweep page_public_shares(verify_phase_d §cascade 覆盖)。
--     actor / revokedBy 也 No FK,user 被 disable / delete 后 audit 行
--     仍可追溯。
--   - tokenHash unique + sha256 hex(64 字符):精确查表 + 防重。GET 路由
--     走 `WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at
--     IS NULL OR expires_at > $now)`,无 token hash = 直接 404。
--   - 一页多 share 共存(各独立过期 / 撤销 / lastAccess);UI 在
--     ShareDialog 列全。
--   - lastAccessedAt 是 fire-and-forget 异步更新位,UI 不展示,纯运营位。
--
-- 索引:
--   - token_hash UNIQUE:GET 路由主路径(sha256 hex 精确匹配)。
--   - page_id:管理面「某 page 哪些 share 在跑」查询。
--   - expires_at:后台清理过期行(后续做,Phase D 不实现)。

CREATE TABLE "page_public_shares" (
  "id" text PRIMARY KEY,
  "page_id" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "created_by" text NOT NULL,
  "created_at" bigint NOT NULL,
  "expires_at" bigint,
  "revoked_at" bigint,
  "revoked_by" text,
  "last_accessed_at" bigint
);--> statement-breakpoint

CREATE INDEX "page_public_shares_page_idx" ON "page_public_shares" ("page_id");--> statement-breakpoint

CREATE INDEX "page_public_shares_expires_idx" ON "page_public_shares" ("expires_at");--> statement-breakpoint

-- 表注释
COMMENT ON TABLE "page_public_shares" IS
  'Phase D 公开链接分享(anonymous 读权限)。一行 = 一个分享 token:
   - 明文 token 只在 POST 创建时一次性返给调用方,DB 存 sha256(明文)
     hex,token_hash 永不可逆推出活 token。
   - 一页可以同时有多个 share(多 token,各自独立过期 / 撤销 / 访问);
     UI 在 ShareDialog 列全。
   - expires_at:null = 永不过期;非 null 时 GET 路由校验 expires_at > now
     否则 404 share_expired。
   - revoked_at:非 null = 已撤销,GET 拒绝;revoked_by 记撤销人。
   - last_accessed_at:GET 命中时 fire-and-forget 异步更新(不阻塞首屏);
     UI 不展示,纯运营位。
   - No FK(CLAUDE.md):page 被 purge 时由 route 显式 sweep;user 被
     disable / delete 后 audit 行仍可追溯。
   - 唯一索引在 token_hash 上,GET 路由主路径;page_id 索引方便管理面
     查「某 page 哪些 share 在跑」。';--> statement-breakpoint

-- 列注释
COMMENT ON COLUMN "page_public_shares"."id" IS
  'nanoid(10) —— 同其他表 ID 字母表(page_public_shares.id 用作 audit target_id)。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."page_id" IS
  'pages.id,被分享的页。No FK —— page 被 purge 时由 route 显式 sweep
   page_public_shares(verify_phase_d §cascade)。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."token_hash" IS
  'sha256(明文 token) hex(64 字符)。UNIQUE —— GET 路由主路径:
   WHERE token_hash = $1 AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > $now)。
   **明文 token 永不入库**:POST /api/pages/:id/share 创建时一次性返给
   调用方,丢失即失效(create 新的 / revoke 旧的)。verify_phase_d
   §db_dump_no_plaintext_token 断言 DB dump 找不到原始 token。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."created_by" IS
  '创建人 users.id。No FK —— user 被 disable / delete 后 audit 行
   仍可追溯(permission_audit.targetKind=''page_share'')。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."created_at" IS
  'Date.now() 毫秒。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."expires_at" IS
  '可选过期时间(Date.now() 毫秒)。null = 永不过期;非 null 时 GET
   路由校验 expires_at > now 否则 404 share_expired。
   expires_at < created_at 在 route 层拒绝(400 invalid_input)。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."revoked_at" IS
  '非 null = 已撤销,GET 路由拒绝。null = 仍有效。
   撤销时同事务写 permission_audit(kind=''page_share_revoke'')。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."revoked_by" IS
  '撤销人 users.id;revoked_at 非 null 时必填。No FK。';--> statement-breakpoint

COMMENT ON COLUMN "page_public_shares"."last_accessed_at" IS
  'GET /public/pages/:token 命中时 fire-and-forget 异步更新(Date.now()
   毫秒)。不阻塞首屏;失败不抛。UI 不展示,纯运营位(排查「这链接还在
   没人用 / 还在被大量用」)。';--> statement-breakpoint

-- 索引注释
COMMENT ON INDEX "page_public_shares_page_idx" IS
  '管理面「某 page 哪些 share 在跑」查询(ShareDialog 列全 + revoke)。';--> statement-breakpoint

COMMENT ON INDEX "page_public_shares_expires_idx" IS
  '后台清理过期行(Phase D 不实现,索引先建好为后续 cron 留接口)。
   NULL 索引会进 B-tree,扫到 NULL 直接跳过 —— 不会被"等值匹配 NULL"
   卡住。';
