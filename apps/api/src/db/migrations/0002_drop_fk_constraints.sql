-- Stage 4d: drop all foreign key constraints.
--
-- Project rule (see CLAUDE.md "硬约束"): no FKs in the schema. Cascade
-- deletes are handled explicitly in app code:
--   - sessions.userId → session.ts (killSessionsForUser on disable / reset)
--   - userGroupMembers.{groupId,userId} → adminGroups DELETE (transactional sweep)
--   - spaceGroupAccess.{spaceId,groupId} → adminGroups/adminSpaces DELETE
--   - pages.parentId → pages DELETE (recursive CTE)
--   - pages.spaceId → not cascaded; pages survive a deleted space as orphans
--     (admin UI refuses to delete a non-empty space anyway)
--
-- Drizzle's `migrate` runs these forward — safe to apply on dev DBs that
-- already have the constraints.

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "space_group_access" DROP CONSTRAINT IF EXISTS "space_group_access_space_id_spaces_id_fk";--> statement-breakpoint
ALTER TABLE "space_group_access" DROP CONSTRAINT IF EXISTS "space_group_access_group_id_user_groups_id_fk";--> statement-breakpoint
ALTER TABLE "user_group_members" DROP CONSTRAINT IF EXISTS "user_group_members_group_id_user_groups_id_fk";--> statement-breakpoint
ALTER TABLE "user_group_members" DROP CONSTRAINT IF EXISTS "user_group_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "pages" DROP CONSTRAINT IF EXISTS "pages_space_id_spaces_id_fk";--> statement-breakpoint
ALTER TABLE "pages" DROP CONSTRAINT IF EXISTS "pages_parent_id_pages_id_fk";
