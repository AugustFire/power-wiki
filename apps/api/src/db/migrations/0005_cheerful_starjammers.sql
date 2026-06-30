CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"parent_id" text,
	"author_id" text NOT NULL,
	"content_md" text NOT NULL,
	"content_text" text NOT NULL,
	"mentioned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"edited_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"page_id" text NOT NULL,
	"page_title" text,
	"comment_id" text,
	"mention_user_id" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_page_idx" ON "comments" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "comments_page_live_idx" ON "comments" USING btree ("page_id","deleted_at");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","is_read","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_page_idx" ON "notifications" USING btree ("page_id");