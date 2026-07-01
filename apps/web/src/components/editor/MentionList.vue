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
import { api } from '@/lib/api'
import { useActivePageId } from '@/composables/useActivePageId'

export interface MentionItem {
  id: string
  name: string
  color: string
  email: string
}

interface SuggestionProps {
  items: MentionItem[]
  command: (item: MentionItem) => void
  clientRect?: (() => DOMRect | null) | null
  /** The text the user has typed after the trigger char (`@`). Used as the
   *  initial value of the popover's search input. */
  query?: string
}

/* ─── module-level refs + tippy instance ──────────────────────────── */

const tippyRef: { v: TippyInstance | null } = { v: null }
let propsRef: SuggestionProps | null = null
const indexRef: Ref<number> = ref(0)
export const candidatesRef: Ref<MentionItem[]> = ref([])
const loadingRef: Ref<boolean> = ref(false)
export let pageIdRef: string | null = null
let fetchSeq = 0

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

/* ─── search-driven refetch ───────────────────────────────────────── */

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

export async function fetchCandidates(query: string): Promise<void> {
  if (!pageIdRef) return
  const seq = ++fetchSeq
  loadingRef.value = true
  const spinner = popperSpinner()
  if (spinner) spinner.classList.add('is-active')
  try {
    const raw = await api.comments.mentionCandidates(pageIdRef, query)
    if (seq !== fetchSeq) return
    candidatesRef.value = raw.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      email: c.email,
    }))
    if (indexRef.value >= candidatesRef.value.length) {
      indexRef.value = 0
    }
    renderList()
  } catch {
    if (seq !== fetchSeq) return
    candidatesRef.value = []
    renderList()
  } finally {
    if (seq === fetchSeq) {
      loadingRef.value = false
      const s = popperSpinner()
      if (s) s.classList.remove('is-active')
    }
  }
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
    pageIdRef = useActivePageId().activePageId.value
    indexRef.value = 0
    candidatesRef.value = []
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
    pageIdRef = null
    indexRef.value = 0
    candidatesRef.value = []
    loadingRef.value = false
    fetchSeq++
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
 * selectors here wouldn't match. Global selectors live below. */
</style>

<style>
/* ─── Tippy chrome override ──────────────────────────────────────── */
/* Tippy's default `light-border` theme paints a hard 1px dark border and
 * a dark arrow. We use a custom theme and reset the chrome here so the
 * popover is a clean white card with a soft shadow. */
.tippy-box[data-theme~='pw-mention'] {
  background: transparent;
  color: inherit;
  box-shadow: none;
}
.tippy-box[data-theme~='pw-mention'] > .tippy-content {
  padding: 0;
}

/* ─── popover container ──────────────────────────────────────────── */
.mention-suggestion-host {
  width: 280px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 8px;
  box-shadow: var(--shadow-lg, 0 16px 48px rgba(9, 30, 66, 0.2));
  overflow: hidden;
  font-family: var(--font-sans, 'Plus Jakarta Sans', system-ui, sans-serif);
  color: var(--text-1, #172b4d);
}

/* ─── search header ──────────────────────────────────────────────── */
.mention-header {
  position: relative;
  display: flex;
  align-items: center;
  padding: 8px 10px;
}
.mention-search-icon {
  position: absolute;
  left: 18px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 16px;
  color: var(--text-3, #6b778c);
  pointer-events: none;
}
.mention-search {
  flex: 1;
  height: 32px;
  padding: 0 32px 0 30px;
  border: 0;
  background: var(--bg-canvas, #f4f5f7);
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  color: var(--text-1, #172b4d);
  outline: none;
  transition: background 80ms ease, box-shadow 80ms ease;
}
.mention-search::placeholder {
  color: var(--text-3, #6b778c);
}
.mention-search:focus {
  background: var(--bg, #fff);
  box-shadow: 0 0 0 2px var(--accent-soft, #deebff);
}
.mention-spinner {
  position: absolute;
  right: 18px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 16px;
  color: var(--text-3, #6b778c);
  opacity: 0;
  pointer-events: none;
}
.mention-spinner.is-active {
  opacity: 1;
  animation: mention-spin 0.8s linear infinite;
}
@keyframes mention-spin {
  to {
    transform: translateY(-50%) rotate(360deg);
  }
}

/* ─── separator ──────────────────────────────────────────────────── */
.mention-sep {
  height: 1px;
  background: var(--border, #dfe1e6);
}

/* ─── candidate list ─────────────────────────────────────────────── */
.mention-suggestion-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
}
.mention-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-radius: 5px;
  font: inherit;
  color: inherit;
  transition: background 60ms ease;
}
.mention-row:hover,
.mention-row.is-active {
  background: var(--accent-softer, #f4f8ff);
}
.mention-row .avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.mention-row .meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mention-row .name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-1, #172b4d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention-row .email {
  font-size: 11px;
  color: var(--text-3, #6b778c);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention-empty {
  padding: 14px 10px;
  color: var(--text-3, #6b778c);
  font-size: 13px;
  text-align: center;
}

/* ─── footer hint ────────────────────────────────────────────────── */
.mention-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-top: 1px solid var(--border, #dfe1e6);
  background: var(--bg-canvas, #f4f5f7);
  font-size: 11px;
  color: var(--text-3, #6b778c);
}
.mention-footer kbd {
  display: inline-block;
  padding: 0 5px;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  background: var(--bg, #fff);
  border: 1px solid var(--border-strong, #c1c7d0);
  border-radius: 3px;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 10px;
  color: var(--text-2, #44546f);
  margin-right: 2px;
}
</style>
