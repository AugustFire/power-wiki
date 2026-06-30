<script lang="ts">
/**
 * MentionList — suggestion dropdown for the `mention` extension.
 *
 * Rendered by `Tippy` via the Suggestion plugin's `render().onStart`. The
 * plugin hands us `command` (to insert the chosen mention) and `items`
 * (the live candidate list). We render a floating card with keyboard
 * navigation (↑/↓/Enter/Esc) and click-to-select.
 *
 * This is a PLAIN `<script lang="ts">` (not `<script setup>`) because
 * `<script setup>` does not allow `export`. We expose imperative methods
 * (`open / update / onKeyDown / close`) for the Suggestion plugin's
 * lifecycle hooks to call.
 */
import { ref, type Ref } from 'vue'
import tippy, { type Instance as TippyInstance } from 'tippy.js'

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
}

/* ─── module-level refs + tippy instance ──────────────────────────── */

const tippyRef: { v: TippyInstance | null } = { v: null }
let propsRef: SuggestionProps | null = null
const indexRef: Ref<number> = ref(0)

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
      <span class="avatar" style="background:${item.color}">${escapeHtml(initials(item.name))}</span>
      <span class="meta">
        <span class="name">${escapeHtml(item.name)}</span>
        <span class="email">${escapeHtml(item.email)}</span>
      </span>`
    row.addEventListener('mousedown', (e) => {
      e.preventDefault() // don't drop editor selection
      command(item)
    })
    row.addEventListener('mouseenter', () => {
      indexRef.value = idx
      syncActiveStatesInline()
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

function syncActiveStatesInline(): void {
  const popper = tippyRef.v?.popper as HTMLElement | undefined
  const list = popper?.querySelector<HTMLElement>('.mention-suggestion-list')
  if (list) syncActiveStates(list)
}

function scrollActiveIntoView(): void {
  const popper = tippyRef.v?.popper as HTMLElement | undefined
  const list = popper?.querySelector<HTMLElement>('.mention-suggestion-list')
  const active = list?.querySelector<HTMLButtonElement>('.mention-row.is-active')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

export const MentionList = {
  open(props: SuggestionProps): void {
    propsRef = props
    indexRef.value = 0
    const host = document.createElement('div')
    host.className = 'mention-suggestion-host'
    const list = document.createElement('div')
    list.className = 'mention-suggestion-list'
    host.appendChild(list)
    renderRows(list, props.items, props.command)

    tippyRef.v = tippy(document.body as Element, {
      getReferenceClientRect: rectProvider(props.clientRect),
      appendTo: () => document.body,
      content: host,
      showOnCreate: true,
      interactive: true,
      placement: 'bottom-start',
      offset: [0, 6],
      duration: 80,
      animation: 'fade',
      trigger: 'manual',
    })
  },

  update(props: SuggestionProps): void {
    propsRef = props
    if (props.items.length === 0) {
      indexRef.value = 0
    } else {
      indexRef.value = Math.min(indexRef.value, props.items.length - 1)
    }
    const popper = tippyRef.v?.popper as HTMLElement | undefined
    const list = popper?.querySelector<HTMLElement>('.mention-suggestion-list')
    if (list) renderRows(list, props.items, props.command)
  },

  onKeyDown(props: { event: KeyboardEvent }): boolean {
    if (!propsRef) return false
    const event = props.event
    if (event.key === 'Escape') {
      MentionList.close()
      return true
    }
    if (event.key === 'ArrowDown') {
      indexRef.value = Math.min(indexRef.value + 1, propsRef.items.length - 1)
      syncActiveStatesInline()
      scrollActiveIntoView()
      return true
    }
    if (event.key === 'ArrowUp') {
      indexRef.value = Math.max(indexRef.value - 1, 0)
      syncActiveStatesInline()
      scrollActiveIntoView()
      return true
    }
    if (event.key === 'Enter') {
      const item = propsRef.items[indexRef.value]
      if (item) {
        propsRef.command(item)
        return true
      }
    }
    return false
  },

  close(): void {
    if (tippyRef.v) {
      tippyRef.v.destroy()
      tippyRef.v = null
    }
    propsRef = null
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
 * selectors here wouldn't match. Global selectors live below. */
</style>

<style>
.mention-suggestion-host {
  z-index: 1000;
}
.mention-suggestion-list {
  background: var(--bg, #fff);
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 4px;
  min-width: 240px;
  max-height: 280px;
  overflow-y: auto;
}
.mention-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
  font: inherit;
  color: inherit;
}
.mention-row:hover,
.mention-row.is-active {
  background: var(--hover-bg, #f4f5f7);
}
.mention-row .avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 11px;
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
  line-height: 1.2;
  color: var(--text-1, #172b4d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention-row .email {
  font-size: 11px;
  color: var(--text-3, #5e6c84);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention-empty {
  padding: 10px;
  color: var(--text-3, #5e6c84);
  font-size: 13px;
  text-align: center;
}
</style>
