CREATE TABLE "page_labels" (
	"page_id" text NOT NULL,
	"label" text NOT NULL,
	"author_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "page_labels_page_id_label_pk" PRIMARY KEY("page_id","label")
);
--> statement-breakpoint
CREATE TABLE "page_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_html" text DEFAULT '' NOT NULL,
	"icon" text,
	"edited_by" text NOT NULL,
	"edited_at" bigint NOT NULL,
	"change_note" text
);
--> statement-breakpoint
CREATE INDEX "page_labels_label_idx" ON "page_labels" USING btree ("label");--> statement-breakpoint
CREATE INDEX "page_versions_page_idx" ON "page_versions" USING btree ("page_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_page_version_uq" ON "page_versions" USING btree ("page_id","version_number");