/**
 * useCommentMention — Stage 7.
 *
 * Adds an @mention Suggestion to a plain `<textarea>` (the comment
 * composer). Reuses `useMentionCandidates` for the candidate cache,
 * the `mention.css` styles for the popover, and a Tippy instance
 * mounted to `document.body` — the same pattern as the editor's
 * MentionList.vue, but driven by a textarea keymap instead of
 * Tiptap's Suggestion plugin.
 *
 * The editor popover is a different beast (Tiptap drives the
 * lifecycle, the popover edits rich doc nodes) so we don't share
 * more than the candidate state + styles. Keeping this client-
 * local lets the textarea use cases (comments, future quick
 * editors) iterate independently from the editor.
 *
 * Behavior:
 *   - Typing `@<word>` in the textarea opens the popover anchored
 *     at the `@` character. The characters typed after `@` (until
 *     the next whitespace) are the `query` string.
 *   - Deleting back past the `@` closes the popover.
 *   - Selecting a candidate inserts `@name ` at the cursor and adds
 *     `name` to the caller's `mentionedUserIds` set (the caller
 *     forwards the set on submit; the server still re-verifies).
 *   - Esc / blur closes the popover without inserting.
 */
import { type Ref, ref, watch } from 'vue'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import { useMentionCandidates, type MentionItem } from '@/composables/useMentionCandidates'

/* ─── module-scope popover state ────────────────────────────────────
 * Just like the editor's MentionList, the popover is a single
 * instance shared across all textareas (and there's only one comment
 * composer on the page at a time anyway).
 */

const tippyRef: { v: TippyInstance | null } = { v: null }
const indexRef: Ref<number> = ref(0)
const queryRef: Ref<string> = ref('')
/** Cursor offset within the textarea where the `@` lives — used to
 *  locate the anchor rect for the popover. */
const anchorOffsetRef: Ref<number> = ref(0)
let textareaRef: HTMLTextAreaElement | null = null

const {
  candidatesRef,
  fetchCandidatesImmediate: fetchCandidatesApi,
  bindPage: bindCandidatesPage,
  reset: resetCandidates,
} = useMentionCandidates()

/* ─── DOM helpers ────────────────────────────────────────────────── */

function popperList(): HTMLElement | null {
  return (tippyRef.v?.popper as HTMLElement | undefined)
    ?.querySelector<HTMLElement>('.mention-suggestion-list') ?? null
}
function popperSearch(): HTMLInputElement | null {
  return (tippyRef.v?.popper as HTMLElement | undefined)
    ?.querySelector<HTMLInputElement>('.mention-search') ?? null
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

function renderRows(list: HTMLElement, items: MentionItem[]): void {
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
    row.innerHTML = `
      <span class="avatar" style="background:${escapeHtml(item.color)}">${escapeHtml(initials(item.name))}</span>
      <span class="meta">
        <span class="name">${escapeHtml(item.name)}</span>
        <span class="email">${escapeHtml(item.email)}</span>
      </span>`
    row.addEventListener('mousedown', (e) => {
      // mousedown (not click) so we beat the textarea's blur and keep
      // the focus on the textarea after insertion.
      e.preventDefault()
      selectItem(item)
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

function renderList(): void {
  const list = popperList()
  if (!list) return
  renderRows(list, candidatesRef.value)
}

function scrollActiveIntoView(): void {
  const list = popperList()
  const active = list?.querySelector<HTMLButtonElement>('.mention-row.is-active')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

/* ─── popover lifecycle ──────────────────────────────────────────── */

function openAt(ta: HTMLTextAreaElement, atOffset: number, query: string): void {
  textareaRef = ta
  anchorOffsetRef.value = atOffset
  queryRef.value = query
  indexRef.value = 0
  candidatesRef.value = []

  // Compute the `@` character's pixel position for the popover anchor.
  // We do this by inserting a temporary mirror div that inherits the
  // textarea's font + padding, then measuring where the @ would land.
  const rect = computeCaretRect(ta, atOffset)

  // Reuse the same popover DOM as the editor — the CSS classes are
  // identical. We omit the search input here (comment mention picks
  // happen quickly; if the user needs to search, they can keep typing
  // to refine the query, which re-fetches via the live `@xxx` text).
  const host = document.createElement('div')
  host.className = 'mention-suggestion-host'
  const list = document.createElement('div')
  list.className = 'mention-suggestion-list'
  host.appendChild(list)
  const footer = document.createElement('div')
  footer.className = 'mention-footer'
  footer.innerHTML =
    '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>' +
    '<span><kbd>Enter</kbd> 选中</span>' +
    '<span><kbd>Esc</kbd> 关闭</span>'
  host.appendChild(footer)

  tippyRef.v = tippy(document.body as Element, {
    getReferenceClientRect: () => rect,
    appendTo: () => document.body,
    content: host,
    showOnCreate: true,
    interactive: true,
    trigger: 'manual',
    arrow: false,
    theme: 'pw-mention',
    placement: 'bottom-start',
    offset: [0, 8],
    duration: 100,
    animation: 'shift-away-subtle',
    hideOnClick: false, // we manage close on insert / Esc / blur
  })

  void fetchCandidatesApi(query).then(() => {
    if (indexRef.value >= candidatesRef.value.length) indexRef.value = 0
    renderList()
  })
}

function close(): void {
  if (tippyRef.v) {
    tippyRef.v.destroy()
    tippyRef.v = null
  }
  textareaRef = null
  queryRef.value = ''
  anchorOffsetRef.value = 0
  indexRef.value = 0
  candidatesRef.value = []
  resetCandidates()
}

/* ─── selection ──────────────────────────────────────────────────── */

function selectItem(item: MentionItem): void {
  if (!textareaRef) return
  const ta = textareaRef
  const at = anchorOffsetRef.value
  const queryLen = queryRef.value.length
  // Replace `@<query>` (the typed text) with `@<name>`. Trailing
  // space lets the user keep typing without a manual space.
  const before = ta.value.slice(0, at)
  const after = ta.value.slice(at + 1 + queryLen)
  const insertion = `@${item.name} `
  const newValue = `${before}${insertion}${after}`
  ta.value = newValue
  const newCursor = at + insertion.length
  // Restore cursor + dispatch input so v-model picks it up.
  ta.setSelectionRange(newCursor, newCursor)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  close()
  // Re-focus the textarea (Tippy.destroy() may have shifted focus).
  ta.focus()
}

/* ─── caret position computation ─────────────────────────────────── */

/**
 * Return a `DOMRect` for the position of the character at `offset` in
 * the textarea. We can't measure a textarea's caret directly, so we
 * mirror the text up to `offset` into a hidden div that inherits the
 * textarea's font + padding, then take the bounding rect of the last
 * span (which represents the caret's position).
 */
function computeCaretRect(ta: HTMLTextAreaElement, offset: number): DOMRect {
  const taRect = ta.getBoundingClientRect()
  // Build the mirror.
  const mirror = document.createElement('div')
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  const cs = getComputedStyle(ta)
  for (const prop of [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom',
    'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'textTransform', 'lineHeight', 'tabSize',
  ] as const) {
    mirror.style[prop] = cs[prop]
  }
  mirror.style.top = '0'
  mirror.style.left = '0'
  const text = ta.value.slice(0, offset)
  mirror.textContent = text
  // Mark the caret position with a marker span.
  const marker = document.createElement('span')
  marker.textContent = '​' // zero-width space
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const markerRect = marker.getBoundingClientRect()
  // Mirror is positioned at (0, 0) within its offset parent. The
  // textarea's content area starts at taRect.top + paddingTop +
  // borderTop, but the mirror is at viewport (0, 0) plus the marker
  // offset. We need the offset of the mirror relative to the viewport.
  const mirrorRect = mirror.getBoundingClientRect()
  document.body.removeChild(mirror)
  // Adjust for scroll inside the textarea (the textarea content can
  // be scrolled by the user, but a plain textarea without a scroll
  // event handler won't tell us this — we approximate with
  // ta.scrollTop).
  const top = taRect.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
    - ta.scrollTop + (markerRect.top - mirrorRect.top)
  const left = taRect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)
    - ta.scrollLeft + (markerRect.left - mirrorRect.left)
  // Default DOMRect constructor
  return new DOMRect(left, top, 0, parseFloat(cs.lineHeight) || 16)
}

/* ─── public API ─────────────────────────────────────────────────── */

export interface UseCommentMentionReturn {
  /** Handle `@`-keypress events on the textarea. The composable
   *  decides whether to open / update / close the popover. */
  onTextareaKeydown: (e: KeyboardEvent) => boolean
  /** Re-position the popover when the textarea content changes
   *  (text typed, deletion, paste) while the popover is open. */
  onTextareaInput: () => void
  /** Re-position the popover when the textarea scrolls. */
  onTextareaScroll: () => void
  /** Force-close the popover (e.g. on submit / cancel). */
  close: () => void
  /** Bind the candidate query to a pageId. */
  bindPage: (pageId: string) => void
}

/**
 * Find the @-trigger position: walk back from the cursor and return
 * { at, query } where `at` is the offset of the `@` and `query` is
 * the text from `@+1` to cursor. Returns null if no trigger.
 *
 * Trigger rules: the character immediately before the cursor (or the
 * start of input) is `@`, and the text from `@` to cursor contains
 * no whitespace (so a single `@foo bar` doesn't activate — the space
 * closes the trigger).
 */
function findAtTrigger(value: string, cursor: number): { at: number; query: string } | null {
  if (cursor === 0) return null
  // Walk back to the most recent whitespace or start of input.
  let i = cursor - 1
  while (i >= 0 && !/\s/.test(value[i]!)) i--
  const start = i + 1
  if (start >= cursor) return null
  if (value[start] !== '@') return null
  return { at: start, query: value.slice(start + 1, cursor) }
}

export function useCommentMention(
  ta: Ref<HTMLTextAreaElement | null>,
  mentionedUserIds: Ref<Set<string>>,
  pageId: Ref<string>,
): UseCommentMentionReturn {
  // Keep the candidate composable in sync with the active page.
  watch(
    pageId,
    (id) => {
      if (id) bindCandidatesPage(id)
    },
    { immediate: true },
  )

  function handleKeydown(e: KeyboardEvent): boolean {
    // If popover is open, intercept ↑/↓/Enter/Esc.
    if (tippyRef.v) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (candidatesRef.value.length === 0) return true
        indexRef.value = Math.min(indexRef.value + 1, candidatesRef.value.length - 1)
        const list = popperList()
        if (list) syncActiveStates(list)
        scrollActiveIntoView()
        return true
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (candidatesRef.value.length === 0) return true
        indexRef.value = Math.max(indexRef.value - 1, 0)
        const list = popperList()
        if (list) syncActiveStates(list)
        scrollActiveIntoView()
        return true
      } else if (e.key === 'Enter') {
        // Only intercept Enter on its own — Cmd/Ctrl+Enter is the
        // submit shortcut (handled by the composer).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
        e.preventDefault()
        const item = candidatesRef.value[indexRef.value]
        if (item) {
          selectItem(item)
          mentionedUserIds.value.add(item.id)
        }
        return true
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return true
      }
      // For all other keys, let the textarea handle them but also
      // re-evaluate the trigger (so deleting the @ closes the popover).
      // We return false to allow the keystroke to proceed; the input
      // event handler will then close/update the popover.
      return false
    }

    // Popover is closed. Open it on `@` (or update if cursor is already
    // in a `@xxx` segment).
    if (e.key === '@' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = ta.value
      if (!el) return false
      const cursor = el.selectionStart
      if (cursor === null) return false
      // Don't trigger if `@` is part of an email — i.e. preceded by a non-space,
      // non-start char. Standard rule: `@` is only a trigger if it's at
      // start of input or preceded by whitespace.
      const before = el.value.slice(0, cursor)
      if (before.length > 0 && !/\s/.test(before[before.length - 1]!)) {
        return false
      }
      // Defer the open to the input event (which fires after the @ is
      // inserted) so we have the right cursor offset.
      return false
    }
    return false
  }

  function handleInput(): void {
    const el = ta.value
    if (!el) return
    const cursor = el.selectionStart
    if (cursor === null) {
      close()
      return
    }
    const trigger = findAtTrigger(el.value, cursor)
    if (trigger) {
      if (tippyRef.v) {
        // Already open: update query and refetch.
        queryRef.value = trigger.query
        anchorOffsetRef.value = trigger.at
        // Reposition the popover to the new @ location (text may have
        // shifted the @ to a different line / column).
        const rect = computeCaretRect(el, trigger.at + 1)
        tippyRef.v.setProps({ getReferenceClientRect: () => rect })
        void fetchCandidatesApi(trigger.query).then(() => {
          if (indexRef.value >= candidatesRef.value.length) indexRef.value = 0
          renderList()
        })
      } else {
        openAt(el, trigger.at, trigger.query)
      }
    } else if (tippyRef.v) {
      close()
    }
  }

  function handleScroll(): void {
    // If the textarea scrolls, the @-character moves. Reposition.
    if (!tippyRef.v || !textareaRef) return
    const cursor = textareaRef.selectionStart
    if (cursor === null) return
    const trigger = findAtTrigger(textareaRef.value, cursor)
    if (!trigger) {
      close()
      return
    }
    const rect = computeCaretRect(textareaRef, trigger.at + 1)
    tippyRef.v.setProps({ getReferenceClientRect: () => rect })
  }

  return {
    onTextareaKeydown: handleKeydown,
    onTextareaInput: handleInput,
    onTextareaScroll: handleScroll,
    close,
    bindPage: bindCandidatesPage,
  }
}
