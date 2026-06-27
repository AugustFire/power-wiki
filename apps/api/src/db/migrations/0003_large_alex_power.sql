ALTER TABLE "pages" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "deleted_by" text;--> statement-breakpoint
CREATE INDEX "pages_trash_idx" ON "pages" USING btree ("space_id","deleted_at");