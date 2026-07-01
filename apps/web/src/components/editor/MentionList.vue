<script lang="ts">
/**
 * MentionList — suggestion popover for the `mention` extension.
 *
 * Rendered by `Tippy` via the Suggestion plugin's `render().onStart`. The
 * plugin hands us `command` (to insert the chosen mention) and `items`
 * (the live candidate list). We render:
 *   - A search input on top (auto-focused on open, pre-filled with the
 *     `query` text the user already typed after `@`)
 *   - A scrollable list of candidates below, with keyboard nav (↑/↓/Enter/Esc)
 *
 * The Tiptap Suggestion `query` is used ONLY as the initial search input
 * value — once the popover is open, the search input is the source of
 * truth (matches the Confluence / Notion / 飞书 pattern). Typing in the
 * search input does not modify the document's `@query` text; the document
 * is only touched when a mention is picked (via the Suggestion `command`).
 *
 * This is a PLAIN `<script lang="ts">` (not `<script setup>`) because
 * `<script setup>` does not allow `export`. We expose imperative methods
 * (`open / update / onKeyDown / close`) for the Suggestion plugin's
 * lifecycle hooks to call.
 */
import { ref, type Ref } from 'vue'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import { useActivePageId } from '@/composables/useActivePageId'
import { useMentionCandidates, type MentionItem } from '@/composables/useMentionCandidates'

// Re-export for downstream consumers that historically imported from this file.
export type { MentionItem }

interface SuggestionProps {
  items: MentionItem[]
  command: (item: MentionItem) => void
  clientRect?: (() => DOMRect | null) | null
  /** The text the user has typed after the trigger char (`@`). Used as the
   *  initial value of the popover's search input. */
  query?: string
}

/* ─── module-level popover state ────────────────────────────────────
 * Only popover-lifecycle state stays here (Tippy instance, the latest
 * Suggestion props, the keyboard selection index). The candidate cache
 * + pageId + fetch state are owned by `useMentionCandidates` so the
 * editor's `items` callback and the popover share a single source of
 * truth.
 */

const tippyRef: { v: TippyInstance | null } = { v: null }
let propsRef: SuggestionProps | null = null
const indexRef: Ref<number> = ref(0)
const {
  candidatesRef,
  pageIdRef,
  loadingRef,
  fetchCandidatesImmediate,
  bindPage,
  reset: resetCandidates,
} = useMentionCandidates()

// Cached DOM nodes the search input writes to. Re-read on every render so
// we always operate on the live popper (Tippy rebuilds it on close/open).
function popperList(): HTMLElement | null {
  return (tippyRef.v?.popper as HTMLElement | undefined)
    ?.querySelector<HTMLElement>('.mention-suggestion-list') ?? null
}
function popperSearch(): HTMLInputElement | null {
  return (tippyRef.v?.popper as HTMLElement | undefined)
    ?.querySelector<HTMLInputElement>('.mention-search') ?? null
}
function popperSpinner(): HTMLElement | null {
  return (tippyRef.v?.popper as HTMLElement | undefined)
    ?.querySelector<HTMLElement>('.mention-spinner') ?? null
}

/** Tippy's `getReferenceClientRect` expects `() => DOMRect`, but Tiptap's
 *  Suggestion hands us `() => DOMRect | null`. Throw if null — Tippy only
 *  reads it on show, and `null` never occurs in practice because Suggestion
 *  only fires inside an active editor. */
function rectProvider(fn: (() => DOMRect | null) | null | undefined): () => DOMRect {
  return () => {
    const r = fn?.()
    if (!r) throw new Error('MentionList: no cursor rect (called outside editor?)')
    return r
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

function initials(name: string): string {
  if (!name) return '?'
  const trimmed = name.trim()
  if (trimmed.length <= 1) return trimmed
  return trimmed[0]!
}

/* ─── search-driven refetch ─────────────────────────────────────────
 * The composable owns the API call + candidate cache + loading state.
 * This wrapper layers the popover-specific UI side effects on top
 * (spinner toggle, index clamp, list re-render). Debounced 150ms so
 * the search input doesn't fire a request on every keystroke.
 */

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

async function fetchCandidates(query: string): Promise<void> {
  const spinner = popperSpinner()
  if (spinner) spinner.classList.add('is-active')
  try {
    await fetchCandidatesImmediate(query)
  } finally {
    // Composable's `loadingRef` tracks the API request, but the
    // spinner also needs to be hidden on error paths.
    if (spinner) spinner.classList.remove('is-active')
  }
  if (indexRef.value >= candidatesRef.value.length) {
    indexRef.value = 0
  }
  renderList()
}

const debouncedFetch = debounce(fetchCandidates, 150)

/* ─── DOM rendering ───────────────────────────────────────────────── */

/** Build (or rebuild) the candidate rows inside the supplied list container. */
function renderRows(
  list: HTMLElement,
  items: MentionItem[],
  command: (item: MentionItem) => void,
): void {
  list.innerHTML = ''
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'mention-empty'
    empty.textContent = '没有匹配的成员'
    list.appendChild(empty)
    return
  }
  items.forEach((item, idx) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'mention-row'
    if (idx === indexRef.value) row.classList.add('is-active')
    row.dataset['userId'] = item.id
    row.innerHTML = `
      <span class="avatar" style="background:${escapeHtml(item.color)}">${escapeHtml(initials(item.name))}</span>
      <span class="meta">
        <span class="name">${escapeHtml(item.name)}</span>
        <span class="email">${escapeHtml(item.email)}</span>
      </span>`
    row.addEventListener('mousedown', (e) => {
      // mousedown (not click) so we beat the editor's blur and keep the
      // suggestion chain alive long enough for `command` to run.
      e.preventDefault()
      command(item)
    })
    row.addEventListener('mouseenter', () => {
      indexRef.value = idx
      syncActiveStates(list)
    })
    list.appendChild(row)
  })
}

function syncActiveStates(list: Element): void {
  const rows = list.querySelectorAll<HTMLButtonElement>('.mention-row')
  rows.forEach((row, idx) => {
    row.classList.toggle('is-active', idx === indexRef.value)
  })
}

function scrollActiveIntoView(): void {
  const list = popperList()
  const active = list?.querySelector<HTMLButtonElement>('.mention-row.is-active')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

function renderList(): void {
  const list = popperList()
  if (!list || !propsRef) return
  renderRows(list, candidatesRef.value, propsRef.command)
}

function selectActive(): void {
  if (!propsRef) return
  const item = candidatesRef.value[indexRef.value]
  if (item) propsRef.command(item)
}

/* ─── search input wiring ─────────────────────────────────────────── */

function onSearchInput(): void {
  const search = popperSearch()
  if (!search) return
  // Each keystroke refetches (debounced 150ms). The Tiptap `query` is NOT
  // updated — the document's `@query` text and the search input are
  // independent once the popover is open.
  debouncedFetch(search.value)
}

function onSearchKeyDown(ev: KeyboardEvent): void {
  if (!propsRef) return
  if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    if (candidatesRef.value.length === 0) return
    indexRef.value = Math.min(indexRef.value + 1, candidatesRef.value.length - 1)
    const list = popperList()
    if (list) syncActiveStates(list)
    scrollActiveIntoView()
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    if (candidatesRef.value.length === 0) return
    indexRef.value = Math.max(indexRef.value - 1, 0)
    const list = popperList()
    if (list) syncActiveStates(list)
    scrollActiveIntoView()
  } else if (ev.key === 'Enter') {
    ev.preventDefault()
    selectActive()
  } else if (ev.key === 'Escape') {
    ev.preventDefault()
    MentionList.close()
  }
}

/* ─── public surface (called by Mention extension) ────────────────── */

export const MentionList = {
  open(props: SuggestionProps): void {
    propsRef = props
    bindPage(useActivePageId().activePageId.value ?? '')
    indexRef.value = 0
    const initialQuery = props.query ?? ''

    const host = document.createElement('div')
    host.className = 'mention-suggestion-host'

    // Search header
    const header = document.createElement('div')
    header.className = 'mention-header'
    const search = document.createElement('input')
    search.type = 'text'
    search.className = 'mention-search'
    search.placeholder = '搜索成员或粘贴邮箱…'
    search.value = initialQuery
    search.autocomplete = 'off'
    search.spellcheck = false
    search.setAttribute('aria-label', '搜索成员')
    search.addEventListener('input', onSearchInput)
    search.addEventListener('keydown', onSearchKeyDown)
    const icon = document.createElement('span')
    icon.className = 'material-symbols-outlined mention-search-icon'
    icon.textContent = 'search'
    const spinner = document.createElement('span')
    spinner.className = 'material-symbols-outlined mention-spinner'
    spinner.textContent = 'progress_activity'
    header.append(icon, search, spinner)
    host.appendChild(header)

    // Separator
    const sep = document.createElement('div')
    sep.className = 'mention-sep'
    host.appendChild(sep)

    // List
    const list = document.createElement('div')
    list.className = 'mention-suggestion-list'
    host.appendChild(list)

    // Footer hint
    const footer = document.createElement('div')
    footer.className = 'mention-footer'
    footer.innerHTML =
      '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>' +
      '<span><kbd>Enter</kbd> 选中</span>' +
      '<span><kbd>Esc</kbd> 关闭</span>'
    host.appendChild(footer)

    tippyRef.v = tippy(document.body as Element, {
      getReferenceClientRect: rectProvider(props.clientRect),
      appendTo: () => document.body,
      content: host,
      showOnCreate: true,
      interactive: true,
      trigger: 'manual',
      arrow: false,
      // Custom theme — see global CSS below. Without this, Tippy injects a
      // hard `border-radius: 4px` + the "light-border" theme's 1px border
      // which is what users see as the "黑框".
      theme: 'pw-mention',
      placement: 'bottom-start',
      offset: [0, 8],
      duration: 100,
      animation: 'shift-away-subtle',
      // Hide on any click outside the popper — covers the user clicking
      // back into the editor or anywhere else. Picking a mention closes via
      // the Tiptap `onExit` lifecycle, not via outside-click.
      hideOnClick: true,
    })

    // Initial fetch drives the list. The Tiptap `items` callback returns
    // `candidatesRef.value` synchronously, so the list might briefly be
    // empty (~50–100ms) until this resolves.
    void fetchCandidates(initialQuery)

    // Focus the search input on the next frame so the user can start
    // refining without an extra click. requestAnimationFrame is needed
    // because Tippy's positioning runs after `showOnCreate` resolves.
    requestAnimationFrame(() => {
      const s = popperSearch()
      if (s) {
        s.focus()
        // Cursor at end of prefill so the user can keep typing.
        const len = s.value.length
        s.setSelectionRange(len, len)
      }
    })
  },

  update(props: SuggestionProps): void {
    propsRef = props
    // The document's `@query` text changed (e.g. user typed more after the
    // popover opened). The search input is the source of truth now, so we
    // don't refetch — just re-clamp the index in case the list shrank.
    if (indexRef.value >= candidatesRef.value.length) {
      indexRef.value = 0
    }
    const list = popperList()
    if (list) syncActiveStates(list)
  },

  onKeyDown(props: { event: KeyboardEvent }): boolean {
    // Called for editor-focused events only. The search input has its own
    // keydown handler, so we only handle Esc here (in case the editor is
    // refocused and the user wants to bail).
    if (!propsRef) return false
    if (props.event.key === 'Escape') {
      MentionList.close()
      return true
    }
    return false
  },

  close(): void {
    if (tippyRef.v) {
      tippyRef.v.destroy()
      tippyRef.v = null
    }
    propsRef = null
    resetCandidates()
    indexRef.value = 0
  },
}
</script>

<script setup lang="ts">
/**
 * Empty setup script. The component is a side-effect-only module — no
 * Vue-mounted DOM is needed (Tippy appends to document.body and our
 * rendering goes through `renderRows`). Keeping this stub makes the file
 * a valid SFC.
 */
</script>

<style scoped>
/* No scoped styles — the host element lives outside Vue's subtree, so
 * selectors here wouldn't match. All global @mention visuals (chip,
 * popover, search input, candidate rows, footer kbd) live in
 * `apps/web/src/styles/mention.css`, imported once from main.ts. */
</style>

