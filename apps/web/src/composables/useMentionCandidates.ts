/**
 * useMentionCandidates — Stage 7.
 *
 * Shared state for the Tiptap @mention suggestion popover. Lives at
 * module scope so every consumer (the editor's `MentionList.vue` +
 * `mentionExtension.ts` `items` callback) sees the same cache and
 * the same `pageId` cursor context. A factory-style composable would
 * be wrong here: the Suggestion plugin instantiates its `items`
 * callback per editor mount, and the popover itself is a singleton
 * Tippy instance — both need to point at the SAME cache.
 *
 * Lifecycle:
 *   - `bindPage(pageId)` is called by the popover's `open()` with the
 *     active editor's pageId. Setting a new pageId invalidates the
 *     candidate list so the next `fetchCandidates` repopulates.
 *   - `fetchCandidates(query)` debounced 150ms; uses an internal
 *     `fetchSeq` counter so an in-flight slow response can't clobber
 *     a newer one (race-safe).
 *   - `reset()` clears all state — called by `MentionList.close()`.
 *
 * Why a separate file: this state is genuinely cross-cutting (the
 * editor's items callback + the popover both need it). Keeping it
 * inlined in `MentionList.vue` worked but made the Vue file a
 * double-purpose module (a Tippy driver AND a state singleton),
 * which is the kind of thing that bites you the next time someone
 * reads the file to understand either half in isolation.
 */
import { ref, type Ref } from 'vue'
import { api } from '@/lib/api'

export interface MentionItem {
  id: string
  name: string
  color: string
  email: string
}

/* ─── module-scope singleton state ────────────────────────────────── */

const candidatesRef: Ref<MentionItem[]> = ref([])
let pageIdRef: string | null = null
const loadingRef: Ref<boolean> = ref(false)
let fetchSeq = 0

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

async function fetchCandidates(query: string): Promise<void> {
  if (!pageIdRef) return
  const seq = ++fetchSeq
  loadingRef.value = true
  try {
    const raw = await api.comments.mentionCandidates(pageIdRef, query)
    if (seq !== fetchSeq) return
    candidatesRef.value = raw.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      email: c.email,
    }))
  } catch {
    if (seq !== fetchSeq) return
    candidatesRef.value = []
  } finally {
    if (seq === fetchSeq) {
      loadingRef.value = false
    }
  }
}

const debouncedFetch = debounce(fetchCandidates, 150)

/**
 * Bind the singleton to a pageId (called by `MentionList.open`).
 * Resets the candidate list so the next fetch starts from a known
 * empty state — otherwise a fast user (open + close + open) would
 * see the previous page's candidates flicker in.
 */
function bindPage(pageId: string): void {
  pageIdRef = pageId
  candidatesRef.value = []
  // bump seq so any in-flight request from the previous page is dropped
  fetchSeq++
}

/**
 * Drop the binding and the cache. Called by `MentionList.close`.
 * Matches the inverse of `bindPage` — we leave fetchSeq incremented
 * but that's a no-op since the next `bindPage` will bump it again.
 */
function reset(): void {
  pageIdRef = null
  candidatesRef.value = []
  loadingRef.value = false
  fetchSeq++
}

export const useMentionCandidates = () => ({
  candidatesRef,
  pageIdRef,
  loadingRef,
  fetchCandidates: debouncedFetch,
  fetchCandidatesImmediate: fetchCandidates,
  bindPage,
  reset,
})
