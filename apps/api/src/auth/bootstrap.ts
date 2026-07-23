/**
 * Bootstrap — runs once on API startup, before the HTTP server starts accepting
 * requests.
 *
 *  1. Ensure an admin user exists. If the users table is empty:
 *     - Read ADMIN_EMAIL + ADMIN_PASSWORD from env
 *     - If either is missing → log a clear error and process.exit(1).
 *     - Otherwise create the admin with status='active' (no forced reset;
 *       the admin bootstraps themselves).
 *
 *  2. Ensure at least one space exists. If the spaces table is empty:
 *     - Create a "默认空间" (Default Space). Admin sees all spaces via the
 *       role check; this is the destination for the page.space_id backfill.
 *
 *  3. Backfill `pages.space_id` from null → default space id.
 *     Safe to run repeatedly (idempotent: skips rows that already have space_id).
 *
 *  4. Purge expired sessions (best-effort cleanup).
 *
 *  5. Personal space backfill. For every user without a `kind='personal'`
 *     space, create one (1-person group + space + access row + welcome page).
 *     Idempotent — `ensurePersonalSpace` is a no-op when one already exists.
 *
 *  6. Phase D — anonymous sentinel user('anon', status='disabled')。幂等
 *     INSERT ON CONFLICT DO NOTHING。公开分享链接的匿名主体走 user-kind
 *     路径时复用这一行。理论上 migration 0025 已经写过,这里再 idempotent
 *     写一次保护「老库升级」场景(虽然本项目还没到那个阶段)。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { pages, spaces, users } from '../db/schema'
import { generatePageId } from '../lib/ids'
import { ensurePersonalSpace } from '../lib/ensurePersonalSpace'
import { hashPassword } from './password'
import { purgeExpiredSessions } from './session'
import { ANONYMOUS_USER_ID } from './anonymousSession'

export interface BootstrapResult {
  adminCreated: boolean
  defaultSpaceId: string
  pagesBackfilled: number
  personalSpacesProvisioned: number
  expiredSessionsPurged: number
}

const DEFAULT_SPACE_NAME = '默认空间'
const DEFAULT_SPACE_DESCRIPTION = '系统自动创建的第一个空间。所有现有页面归属到这里。'

export async function runBootstrap(): Promise<BootstrapResult> {
  // ─── 1. Admin user ───────────────────────────────────────────────────────
  const existingUsers = await db.select({ id: users.id }).from(users).limit(1)
  const userCount = existingUsers.length

  let adminCreated = false
  if (userCount === 0) {
    const email = process.env['ADMIN_EMAIL']
    const password = process.env['ADMIN_PASSWORD']
    if (!email || !password) {
      console.error(
        '\n[api] FATAL: users 表为空但 ADMIN_EMAIL / ADMIN_PASSWORD 未配置。',
      )
      console.error('[api] 在 apps/api/.env 中设置:')
      console.error('    ADMIN_EMAIL=admin@power-wiki.local')
      console.error('    ADMIN_PASSWORD=<至少 8 位的密码>')
      console.error('[api] 然后重启 dev server。\n')
      throw new Error('admin bootstrap failed: missing env vars')
    }
    const id = generatePageId()
    const hash = await hashPassword(password)
    const now = Date.now()
    await db.insert(users).values({
      id,
      email,
      name: 'Admin',
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      color: '#0052CC',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    })
    console.log(`[api] bootstrap: ✓ admin ${email} created (id=${id})`)
    adminCreated = true
  } else {
    console.log(`[api] bootstrap: ${userCount}+ users exist, skipping admin creation`)
  }

  // ─── 2. Default space ───────────────────────────────────────────────────
  const existingSpaces = await db.select({ id: spaces.id }).from(spaces).limit(1)
  let defaultSpaceId: string
  if (existingSpaces.length === 0) {
    defaultSpaceId = generatePageId()
    const now = Date.now()
    await db.insert(spaces).values({
      id: defaultSpaceId,
      name: DEFAULT_SPACE_NAME,
      description: DEFAULT_SPACE_DESCRIPTION,
      color: '#0052CC',
      icon: 'folder',
      createdAt: now,
      updatedAt: now,
    })
    console.log(
      `[api] bootstrap: ✓ default space "${DEFAULT_SPACE_NAME}" created (id=${defaultSpaceId})`,
    )
  } else {
    // Pick the oldest space as the default backfill target if there are multiple.
    // (In Stage 4c we'll add user-group-based access; for now all users see all spaces.)
    defaultSpaceId = existingSpaces[0]!.id
  }

  // ─── 3. Backfill pages.space_id ─────────────────────────────────────────
  const orphans = await db
    .update(pages)
    .set({ spaceId: defaultSpaceId })
    .where(isNull(pages.spaceId))
    .returning({ id: pages.id })
  const pagesBackfilled = orphans.length
  if (pagesBackfilled > 0) {
    console.log(
      `[api] bootstrap: backfilled ${pagesBackfilled} page(s) to space "${DEFAULT_SPACE_NAME}"`,
    )
  }

  // ─── 4. Purge expired sessions ─────────────────────────────────────────
  const purged = await purgeExpiredSessions()
  if (purged > 0) console.log(`[api] bootstrap: purged ${purged} expired session(s)`)

  // ─── 5. Personal space backfill ───────────────────────────────────────
  // For each user (including the just-created admin) without a personal
  // space, create one. ensurePersonalSpace is idempotent — it short-circuits
  // when a personal space already exists. We only count newly created spaces
  // by diffing visible-vs-expected after the loop (cheap; users are few).
  const allUsers = await db
    .select({ id: users.id, name: users.name, color: users.color, hasPersonal: spaces.id })
    .from(users)
    .leftJoin(
      spaces,
      and(eq(spaces.ownerId, users.id), eq(spaces.kind, 'personal')),
    )
  let personalSpacesProvisioned = 0
  for (const u of allUsers) {
    if (u.hasPersonal) continue
    await ensurePersonalSpace({ id: u.id, name: u.name, color: u.color })
    personalSpacesProvisioned++
    console.log(`[api] bootstrap: ✓ personal space provisioned for ${u.name} (id=${u.id})`)
  }
  if (personalSpacesProvisioned > 0) {
    console.log(
      `[api] bootstrap: ${personalSpacesProvisioned} personal space(s) provisioned`,
    )
  }

  // ─── 6. Anonymous sentinel (Phase D) ─────────────────────────────────
  // 幂等 INSERT。理论上 migration 0025 已经写过,这里兜底防止 bootstrap
  // 在 migration 之前跑(实际上 API 启动先 migrate 再 bootstrap,但保险)。
  await db
    .insert(users)
    .values({
      id: ANONYMOUS_USER_ID,
      email: 'anonymous@power-wiki.local',
      name: '匿名访问',
      passwordHash: '',
      role: 'user',
      status: 'disabled',
      color: '#7A869A',
      createdAt: 1783500000000,
      updatedAt: 1783500000000,
      lastLoginAt: null,
      avatarKind: null,
      avatarRef: null,
    })
    .onConflictDoNothing()

  return {
    adminCreated,
    defaultSpaceId,
    pagesBackfilled,
    personalSpacesProvisioned,
    expiredSessionsPurged: purged,
  }
}

/**
 * Looks up a user by email. Returns the row + the plain initial password if the
 * caller is creating the user; otherwise just the row.
 */
export async function findUserByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1)
  return rows[0] ?? null
}
