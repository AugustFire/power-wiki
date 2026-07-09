/**
 * Page events helper — P1-3 v2 workspace-wide 活动流数据源。
 *
 * Single point of entry for writing `page_events` rows. Route handlers
 * (POST /pages, PATCH /pages/:id, PATCH /move, POST /restore, POST /duplicate,
 * POST /publish, DELETE /:id) MUST go through this rather than `db.insert(pageEvents)`
 * directly so:
 *   - id generation is consistent (single nanoid source)
 *   - kind enum is whitelist-enforced (no typo'd string slips into the table)
 *   - error handling is uniform: a failed event INSERT does NOT roll back
 *     the originating page mutation (events are metadata, not the source
 *     of truth — the page row is). We log the failure and move on.
 *
 * Why fire-and-forget: the page mutation is the user-visible operation;
 * the event is just a row in the activity feed. Coupling the two in a
 * transaction would mean a transient event-INSERT failure (deadlock, FK
 * race, etc.) would roll back the user's actual edit. That tradeoff is
 * wrong — we'd rather show "no entry in the activity feed" than "your
 * edit didn't go through". The same pattern as Stage 6 `enqueueNotifications`.
 *
 * Idempotency: events are not idempotent (each call inserts a new row).
 * Callers that need idempotency wrap their mutation in a transaction
 * and pass the same `tx` so the event INSERT shares the tx.
 */
import { nanoid } from 'nanoid'
import { pageEvents } from '../db/schema'
import { db } from '../db/client'
import type { AuthenticatedUser } from '../auth/session'

/**
 * Event kinds — keep in sync with frontend verb mapping
 * (apps/web/src/views/ActivityView.vue:verbMap) and with the SQL
 * column comment in 0014_page_events.sql.
 */
export type PageEventKind =
  | 'created'
  | 'edited'
  | 'moved'
  | 'restored'
  | 'duplicated'
  | 'published'
  | 'trashed'
  | 'purged'

export const SUPPORTED_KINDS: ReadonlySet<PageEventKind> = new Set<PageEventKind>([
  'created',
  'edited',
  'moved',
  'restored',
  'duplicated',
  'published',
  'trashed',
  'purged',
])

export interface RecordEventArgs {
  pageId: string
  spaceId: string
  kind: PageEventKind
  actor: AuthenticatedUser
  /**
   * Optional context. Move: { fromSpaceId, toSpaceId }. Duplicate/publish:
   * { sourcePageId }. Frontend v0 ignores the field; reserved for future
   * click-to-source affordances.
   */
  payload?: Record<string, unknown>
}

export async function recordPageEvent(
  args: RecordEventArgs,
  client: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): Promise<void> {
  if (!SUPPORTED_KINDS.has(args.kind)) {
    // Defensive — should be a TS error at call site, but don't crash on
    // a typo from a refactor.
    console.warn(`[pageEvents] unknown kind: ${args.kind}`)
    return
  }
  try {
    await client.insert(pageEvents).values({
      id: nanoid(10),
      pageId: args.pageId,
      spaceId: args.spaceId,
      kind: args.kind,
      actorId: args.actor.id,
      payload: args.payload ?? null,
      createdAt: Date.now(),
    })
  } catch (err) {
    // Activity feed is best-effort. Page mutation is the source of truth.
    console.error('[pageEvents] insert failed', err)
  }
}
