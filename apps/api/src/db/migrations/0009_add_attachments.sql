-- 0009_add_attachments.sql
--
-- 页面级附件表(image + PDF),存储在 MinIO/S3。
-- 一行 = 一个上传文件,只能被一个页面引用。
-- 删除页面时由 pages.ts DELETE 递归 CTE 显式清理行 + best-effort 删 S3 对象。
-- 无外键(硬约束:CLAUDE.md 第 6 条)。
CREATE TABLE "attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "page_id" text NOT NULL,
  "uploader_id" text NOT NULL,
  "original_filename" text NOT NULL,
  "storage_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "kind" text NOT NULL,
  "created_at" bigint NOT NULL
);--> statement-breakpoint
CREATE INDEX "attachments_page_idx" ON "attachments" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_uploader_idx" ON "attachments" USING btree ("uploader_id");--> statement-breakpoint
COMMENT ON TABLE "attachments" IS '页面级附件(image + application/pdf),文件字节存 MinIO/S3,DB 只存元数据。一行 = 一个上传文件,只能被一个页面引用。删除页面时由 pages.ts DELETE 递归 CTE 显式清理行 + best-effort 删 S3 对象。无外键(硬约束)。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."id" IS 'nanoid(12) 附件 id,也是 S3 object key 的第二段。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."page_id" IS '所属页面 id。无 FK,page purge 时显式清掉。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."uploader_id" IS '上传者 user id。无 FK。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."original_filename" IS '用户上传时的原始文件名(展示用),≤ 255 字符。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."storage_key" IS 'S3 object key,格式 {page_id}/{id}{ext}。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."mime_type" IS 'MIME 类型;上传前已校验为 ALLOWED_MIME_TYPES 之一。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."size_bytes" IS '文件字节数;由 HeadObject 验证写入(不信前端 size)。≤ MAX_UPLOAD_BYTES。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."kind" IS '''image''(image mime)或 ''file''(application/pdf 等)。决定编辑器 / read view 渲染哪种节点。';--> statement-breakpoint
COMMENT ON COLUMN "attachments"."created_at" IS 'Date.now() 毫秒,上传时间。';--> statement-breakpoint
COMMENT ON INDEX "attachments_page_idx" IS '热路径:列出某页所有附件(按上传时间倒序)。';--> statement-breakpoint
COMMENT ON INDEX "attachments_uploader_idx" IS '按上传者查询附件(未来审计 / 配额用)。';
