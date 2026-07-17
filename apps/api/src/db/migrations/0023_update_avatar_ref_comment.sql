-- 0023_update_avatar_ref_comment.sql
--
-- M11 v2:更新 users.avatar_kind / avatar_ref 的 pg_description,
-- 跟 apps/api/src/db/schema.ts 同名字段 JSDoc 同步(CLAUDE.md §10
-- 硬约束,drift 视为 bug)。
--
-- v1 时期「白名单见 AVATAR_PRESETS」措辞已不准确 —— v2 改成「前端
-- 动态发现」(GET /api/avatars/presets 运行时扫 apps/web/public/avatars/)。
-- AVATAR_PRESETS 常量在 packages/shared/src/constants.ts 已删除。
--
-- 本文件不修改 schema(列 / 约束 / 索引),只更新 pg_description。
-- drizzle-kit 不跟踪 COMMENT 的 content_hash,所以更新 comment 不会让
-- drizzle "re-apply" 也不会被认为有改动。手动跑:psql -f 本文件。

COMMENT ON COLUMN "users"."avatar_kind" IS
  '头像形态三态:NULL(用 initials+color)/preset(静态预制,前端通过
   GET /api/avatars/presets 运行时扫 apps/web/public/avatars/ 动态发现
   slug,不写死)/custom(MinIO 用户头像,见 user_avatars 表)。
   CHECK users_avatar_kind_check 限定合法值,迁移 0022 加。';--> statement-breakpoint

COMMENT ON COLUMN "users"."avatar_ref" IS
  '头像引用:NULL 同 avatar_kind=NULL(走 initials+color);preset 存
   slug(后端 z.string 校验格式,不限 enum,文件不存在时前端 <img @error>
   兜底回 initials);custom 存 user_avatars.id。
   CHECK users_avatar_consistency_check 强制 kind/ref 同 NULL/同非 NULL。';
