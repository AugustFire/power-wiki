-- 0022_user_avatar_kind_and_user_avatars.sql
--
-- M11 用户头像三态互斥(NULL / 'preset' / 'custom')。
-- users 表加 avatar_kind + avatar_ref 两列,DB CHECK 软约束兜底,
-- 主校验在 zod(后端 parse 失败 400)。新增 user_avatars 表放自定义头像
-- 对象数据,与 page attachments 独立(无 pageId 维度,不挂在任何页面下)。

-- Step 1: users 表加两列
ALTER TABLE "users" ADD COLUMN "avatar_kind" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_ref" text;--> statement-breakpoint

-- Step 2: avatar_kind 必须在白名单内(NULL 允许)
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_kind_check" CHECK (
  "avatar_kind" IS NULL
  OR "avatar_kind" IN ('preset', 'custom')
);--> statement-breakpoint

-- Step 3: kind/ref 必须同时 NULL 或同时非 NULL(状态机一致性)
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_consistency_check" CHECK (
  ("avatar_kind" IS NULL AND "avatar_ref" IS NULL)
  OR ("avatar_kind" IS NOT NULL AND "avatar_ref" IS NOT NULL)
);--> statement-breakpoint

COMMENT ON COLUMN "users"."avatar_kind" IS '头像形态三态:NULL(用 initials+color)/preset(静态预制,白名单见 AVATAR_PRESETS)/custom(MinIO 用户头像)。CHECK users_avatar_kind_check 限定合法值,迁移 0022 加。';--> statement-breakpoint
COMMENT ON COLUMN "users"."avatar_ref" IS '头像引用:NULL 同 avatar_kind=NULL(走 initials+color);preset 存 AVATAR_PRESETS 里的 slug;custom 存 user_avatars.id。CHECK users_avatar_consistency_check 强制 kind/ref 同 NULL/同非 NULL。';--> statement-breakpoint

-- Step 4: user_avatars 表 —— 用户自定义头像对象
CREATE TABLE "user_avatars" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "bucket_key" text NOT NULL,
  "mime" text NOT NULL,
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0),
  "width" integer NOT NULL CHECK ("width" > 0),
  "height" integer NOT NULL CHECK ("height" > 0),
  "created_at" bigint NOT NULL
);--> statement-breakpoint

-- Step 5: 索引 —— (user_id, created_at DESC),给「该用户最近头像」用
CREATE INDEX "user_avatars_user_idx" ON "user_avatars" ("user_id", "created_at" DESC);--> statement-breakpoint

COMMENT ON TABLE "user_avatars" IS '用户自定义头像对象,bucket_key 指向 MinIO power-wiki-attachments 桶下的 users/{userId}/{avatarId}.{ext} 路径。与 page attachments 表独立(无 pageId 维度,不挂在任何页面下)。delete user 时本表行 + 对应 S3 对象一起 best-effort 删除;用户多次上传不切换 / 切 preset 时由 write-path lazy cleanup 收敛到每用户 ≤ 1 active row,不引入后台 cron / soft-delete / TTL GC。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."id" IS 'nanoid(10),与 attachments id 风格一致,也是 S3 object key 第二段。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."user_id" IS 'users.id,无 FK(由 app 端 DELETE user 时清理)。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."bucket_key" IS 'S3 bucket key,例如 users/u_xxx/abc.png。安全:必须以 users/<me.id>/ 开头,后端 finalize 路径 hard-check;防 a 用户写 b 用户名下对象。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."mime" IS '图 MIME,白名单 image/{png,jpeg,webp,gif}(见 shared AVATAR_ALLOWED_MIME)。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."size_bytes" IS '落库字节数,前端压图后 ≤ 200KB,硬上限 ≤ 5MB(AVATAR_UPLOAD_MAX_BYTES)。finalize 时 HeadObject 校验,不信前端 size。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."width" IS '图宽(像素),≤ 256(AVATAR_TARGET_DIM)。前端 canvas resize 后给到后端。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."height" IS '图高(像素),≤ 256(AVATAR_TARGET_DIM)。';--> statement-breakpoint
COMMENT ON COLUMN "user_avatars"."created_at" IS 'Date.now() 毫秒,上传 finalize 时间。';
