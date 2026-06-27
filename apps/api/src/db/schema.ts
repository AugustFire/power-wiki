/**
 * Drizzle schema for power-wiki's Postgres database.
 *
 * Stage 4 scope: pages + users + sessions + user_groups + user_group_members
 * + spaces + space_group_access.
 *
 * Naming convention:
 *   - DB columns: snake_case (matches Postgres convention)
 *   - TS fields:  camelCase (matches the shared types in packages/shared)
 *
 * Timestamps (`created_at`, `updated_at`) are stored as bigint in milliseconds since epoch.
 * bigint mode 'number' gives JS number (safe up to 2^53 ms ≈ year 287396).
 *
 * ─── NO foreign key constraints (hard project rule) ──────────────────
 * Per user constraint (see CLAUDE.md "硬约束"), this schema does NOT declare
 * any `.references()`. Relations are tracked in app code; cascade deletes
 * happen explicitly in route handlers (e.g. adminGroups DELETE cleans up
 * `user_group_members` + `space_group_access` before deleting the group).
 *
 * `pages.author_id` is also a free-form string by design — older seed pages
 * may have authorId='me' which isn't a real user id, and the frontend renders
 * whatever string is there.
 */

import type { TiptapJSON } from '@power-wiki/shared'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core'

/* ─────────────────────────────────────────────────────────────────
 *  Users / Auth
 * ───────────────────────────────────────────────────────────────── */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  status: text('status', { enum: ['active', 'disabled', 'must_reset_password'] })
    .notNull()
    .default('must_reset_password'),
  color: text('color').notNull().default('#0052CC'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastLoginAt: bigint('last_login_at', { mode: 'number' }),
})

export const sessions = pgTable(
  'sessions',
  {
    /** nanoid(32) — the session token, also stored in the HTTP-only cookie */
    id: text('id').primaryKey(),
    /** No FK — cleanup is handled by session.ts (killSessionsForUser on disable / reset). */
    userId: text('user_id').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/* ─────────────────────────────────────────────────────────────────
 *  User Groups
 * ───────────────────────────────────────────────────────────────── */

export const userGroups = pgTable('user_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

export const userGroupMembers = pgTable(
  'user_group_members',
  {
    /** No FK — cleanup is handled by adminGroups DELETE (explicit). */
    groupId: text('group_id').notNull(),
    /** No FK — disabled/removed users get their memberships swept by app code if needed. */
    userId: text('user_id').notNull(),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('ugm_user_idx').on(t.userId),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Spaces
 * ───────────────────────────────────────────────────────────────── */

export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#0052CC'),
  icon: text('icon'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const spaceGroupAccess = pgTable(
  'space_group_access',
  {
    /** No FK — cleanup is handled by adminSpaces DELETE (explicit). */
    spaceId: text('space_id').notNull(),
    /** No FK — cleanup is handled by adminGroups DELETE (explicit). */
    groupId: text('group_id').notNull(),
    grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.groupId] })],
)

/* ─────────────────────────────────────────────────────────────────
 *  Pages
 * ───────────────────────────────────────────────────────────────── */

export const pages = pgTable(
  'pages',
  {
    id: text('id').primaryKey(),

    /**
     * Parent page id, NULL = top-level.
     * No FK — descendant cleanup happens in pages.ts DELETE via a recursive CTE
     * (one statement, same roundtrip cost as the old FK cascade).
     */
    parentId: text('parent_id'),

    /**
     * Space id (Stage 4+). Nullable at the DB level for migration safety, but every new
     * page MUST have a spaceId (POST /api/pages validates). bootstrap.ts backfills
     * existing rows to the default space on first boot after the schema migration.
     *
     * No FK — pages survive a deleted space (UI just shows them as orphans; admin
     * can delete the space only when empty anyway).
     */
    spaceId: text('space_id'),

    title: text('title').notNull().default(''),
    contentJson: jsonb('content_json').$type<TiptapJSON>().notNull().default({}),
    contentHtml: text('content_html').notNull().default(''),
    icon: text('icon'),

    /** Sibling sort order, lower comes first. */
    sortOrder: integer('sort_order').notNull().default(0),

    /** Date.now() ms — see header comment for why bigint-mode-number. */
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),

    /**
     * User id of the creator. Free-form string — see header comment.
     */
    authorId: text('author_id').notNull().default('me'),

    starred: boolean('starred').notNull().default(false),

    /**
     * Stage 5 soft-delete. NULL = live page; non-NULL = trashed.
     * `deleted_by` records who moved it (admin restores via /api/pages/:id/restore;
     * purge via DELETE /api/pages/:id?purge=true). No FK — see header rule.
     */
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    deletedBy: text('deleted_by'),
  },
  (table) => [
    index('pages_parent_idx').on(table.parentId),
    index('pages_parent_order_idx').on(table.parentId, table.sortOrder),
    index('pages_space_idx').on(table.spaceId),
    index('pages_trash_idx').on(table.spaceId, table.deletedAt),
  ],
)

/* ─────────────────────────────────────────────────────────────────
 *  Row types
 * ───────────────────────────────────────────────────────────────── */

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert
export type UserGroupRow = typeof userGroups.$inferSelect
export type NewUserGroupRow = typeof userGroups.$inferInsert
export type SpaceRow = typeof spaces.$inferSelect
export type NewSpaceRow = typeof spaces.$inferInsert
export type PageRow = typeof pages.$inferSelect
export type NewPageRow = typeof pages.$inferInsert
