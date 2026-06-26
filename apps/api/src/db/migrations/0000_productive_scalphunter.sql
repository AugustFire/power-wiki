CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"title" text DEFAULT '' NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_html" text DEFAULT '' NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"author_id" text DEFAULT 'me' NOT NULL,
	"starred" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pages_parent_idx" ON "pages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "pages_parent_order_idx" ON "pages" USING btree ("parent_id","sort_order");