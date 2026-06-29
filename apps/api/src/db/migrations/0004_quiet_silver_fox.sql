ALTER TABLE "spaces" ADD COLUMN "kind" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "owner_id" text;