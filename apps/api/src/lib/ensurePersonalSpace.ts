/**
 * Ensure every user has exactly one personal space.
 *
 *  - `ensurePersonalSpace(user)` — idempotent. If the user already has a
 *    `kind='personal'` space, returns its {spaceId, pageId} without touching
 *    anything. Otherwise creates the full thing in one transaction:
 *      1. A 1-person user group (`pg-<userId>`) — deterministic id so
 *         re-runs hit the existence check instead of creating duplicates.
 *      2. A `user_group_members` row tying that group to the user.
 *      3. A space (`kind='personal'`, `ownerId=userId`, `name='<name> 的空间'`).
 *      4. A `space_group_access` row binding the group to the space.
 *      5. A welcome page at the root of that space, with both contentJSON
 *         (Tiptap doc) and contentHTML (DOMPurify-safe HTML) pre-filled.
 *
 *  Used in two places:
 *    - `routes/adminUsers.ts` POST — at user-create time, so the new user
 *      lands on a populated personal space after first sign-in.
 *    - `auth/bootstrap.ts` step 5 — backfill for any pre-existing user
 *      missing a personal space. Safe to re-run.
 *
 *  Why a transaction: a partial state (group created but space missing) would
 *  leave the user with access to a non-existent space or vice versa, and the
 *  next call would create a duplicate group. Atomicity is the simplest fix.
 *
 *  Why no FK constraints (per project hard rule): `space_group_access.groupId`
 *  is a plain text column, not a `.references()`. Cleanup is handled in the
 *  group delete path; here we just rely on the unique ids we mint.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import {
  pages,
  spaceGroupAccess,
  spaceRoleGrants,
  spaces,
  userGroupMembers,
  userGroups,
} from '../db/schema'
import { generatePageId } from './ids'
import type { TiptapJSON } from '@power-wiki/shared'

const GROUP_ID_PREFIX = 'pg-' // personal-group

export interface PersonalSpaceResult {
  spaceId: string
  pageId: string
}

export function personalGroupId(userId: string): string {
  return `${GROUP_ID_PREFIX}${userId}`
}

/**
 * Build the welcome page content. Hard-coded Tiptap doc + matching HTML
 * (both pre-sanitized — no inline scripts or dangerous attributes).
 *
 * The HTML is the canonical rendering of the doc; on first edit Tiptap will
 * regenerate both from the doc tree. ReadView uses `contentHTML` via v-html
 * so we need it pre-populated for the welcome page to render before any edit.
 */
function buildWelcomeContent(userName: string): { contentJSON: TiptapJSON; contentHTML: string } {
  const heading = `欢迎来到 ${userName} 的个人空间`
  const intro = '这里是你的私人空间,只有你能看到。你可以:'
  const bullets = [
    '写草稿、记笔记、试编辑器功能',
    '准备好分享时,右键页面 → 移动到... → 发布到团队空间',
  ]
  const outro = '随时可以回来继续编辑。'

  const contentJSON: TiptapJSON = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: heading }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: intro }],
      },
      {
        type: 'bulletList',
        content: bullets.map((b) => ({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: b }],
            },
          ],
        })),
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: outro }],
      },
    ],
  }

  // Hand-written HTML matching the doc structure above. Kept simple so a
  // DOMPurify pass (server-side if we add it, client-side on ReadView) won't
  // strip anything. Whitespace and inline tags are fine.
  const contentHTML = [
    `<h2>${escapeHtml(heading)}</h2>`,
    `<p>${escapeHtml(intro)}</p>`,
    '<ul>',
    ...bullets.map((b) => `<li><p>${escapeHtml(b)}</p></li>`),
    '</ul>',
    `<p>${escapeHtml(outro)}</p>`,
  ].join('')

  return { contentJSON, contentHTML }
}

/** Tiny escape — only used for our hand-written seed strings, no user input. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Idempotent: if the user already has a personal space, returns its ids
 * (and the welcome page's id if it still exists) without modifying anything.
 * Otherwise creates the full structure in a transaction.
 */
export async function ensurePersonalSpace(
  user: { id: string; name: string; color: string },
): Promise<PersonalSpaceResult> {
  // 0. Idempotency check — done outside the transaction so the hot path
  //    (user already has one) is a single SELECT.
  const existing = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerId, user.id), eq(spaces.kind, 'personal')))
    .limit(1)
  if (existing.length > 0) {
    const spaceId = existing[0]!.id
    const welcome = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.spaceId, spaceId), isNull(pages.parentId)))
      .orderBy(pages.sortOrder)
      .limit(1)
    if (welcome.length > 0) {
      return { spaceId, pageId: welcome[0]!.id }
    }
    // No welcome page (older data path?) — re-create one. Rare.
    return { spaceId, pageId: await createWelcomePage(spaceId, user) }
  }

  const spaceId = generatePageId()
  const groupId = personalGroupId(user.id)
  const now = Date.now()
  const { contentJSON, contentHTML } = buildWelcomeContent(user.name)

  await db.transaction(async (tx) => {
    // 1. The 1-person group. Description is human-readable so /manager/people
    //    can show "personal group for <name>" instead of just the id.
    await tx.insert(userGroups).values({
      id: groupId,
      name: `${user.name} 的个人组`,
      description: '系统自动创建,用于授予该用户访问其个人空间。',
      createdAt: now,
    })

    // 2. Add the user to the group.
    await tx.insert(userGroupMembers).values({
      groupId,
      userId: user.id,
      addedAt: now,
    })

    // 3. The personal space. Color matches the user's avatar so the sidebar
    //    entry visually belongs to them. Icon 'cottage' signals "home".
    await tx.insert(spaces).values({
      id: spaceId,
      name: `${user.name} 的空间`,
      description: '系统自动创建的个人空间,只有你能访问。',
      color: user.color,
      icon: 'cottage',
      kind: 'personal',
      ownerId: user.id,
      createdAt: now,
      updatedAt: now,
    })

    // 4. Bind the group to the space.
    await tx.insert(spaceGroupAccess).values({
      spaceId,
      groupId,
      grantedAt: now,
    })

    // 4b. Phase A: also insert a space_role_grants row so the new
    //     permissions model recognizes this binding. The group gets
    //     role='admin' — owner of the personal space is the only admin
    //     on it. Global admin writes to personal space content are still
    //     blocked by `assertAdminNotWritingPersonalSpace` (separate
    //     layer, untouched here).
    await tx.insert(spaceRoleGrants).values({
      id: generatePageId(),
      spaceId,
      principalKind: 'group',
      principalId: groupId,
      role: 'admin',
      grantedBy: null,
      grantedAt: now,
    })

    // 5. Welcome page (root of the space).
    const pageId = generatePageId()
    await tx.insert(pages).values({
      id: pageId,
      parentId: null,
      spaceId,
      title: `欢迎来到 ${user.name} 的个人空间`,
      contentJson: contentJSON,
      contentHtml: contentHTML,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      authorId: user.id,
    })
  })

  // Re-read to get the welcome page id we just inserted (the transaction
  // closes before we can capture it from the closure above; this SELECT is
  // cheap and the result is stable).
  const welcome = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), isNull(pages.parentId)))
    .orderBy(pages.sortOrder)
    .limit(1)
  return { spaceId, pageId: welcome[0]?.id ?? '' }
}

/**
 * Re-create a welcome page in an existing personal space that has none.
 * Used by the idempotency branch above. Runs outside any outer transaction.
 */
async function createWelcomePage(spaceId: string, user: { id: string; name: string }): Promise<string> {
  const pageId = generatePageId()
  const now = Date.now()
  const { contentJSON, contentHTML } = buildWelcomeContent(user.name)
  await db.insert(pages).values({
    id: pageId,
    parentId: null,
    spaceId,
    title: `欢迎来到 ${user.name} 的个人空间`,
    contentJson: contentJSON,
    contentHtml: contentHTML,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    authorId: user.id,
  })
  return pageId
}
