/**
 * Minimal markdown → plain-text transform for the `comments.content_text`
 * snapshot column.
 *
 * Why this exists:
 *   - The notifications panel renders `preview` slices of the comment body.
 *   - Re-parsing the full markdown every render is wasteful and would require
 *     pulling a markdown library into the read path.
 *   - We store `content_md` AND `content_text` at write time so the read path
 *     can use `content_text` directly without re-stripping.
 *
 * Scope (v0 — comments have no toolbar, just plain markdown):
 *   - Strip heading hashes (`# `), bullets (`- `, `* `), blockquotes (`> `)
 *   - Strip inline emphasis (`**bold**` → `bold`, `_italic_` → `italic`,
 *     `*emphasis*` → `emphasis`)
 *   - Strip inline code backticks (`` `code` `` → `code`)
 *   - Strip links — keep label only (`[label](url)` → `label`)
 *   - Collapse all remaining whitespace to single spaces; trim.
 *
 * Out of scope:
 *   - Tables, fenced code blocks, list nesting — comments are short.
 *   - HTML escaping — the preview is rendered as text on a notification card
 *     using `text-overflow: ellipsis`, NOT inserted as HTML.
 *
 * Heuristic / regex-only — robust against malformed markdown without throwing.
 */
export function stripMarkdown(input: string): string {
  let s = input

  // Headings / bullets / blockquote prefixes at line start.
  s = s.replace(/^\s*#{1,6}\s+/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')

  // Fenced code blocks — keep the inner text, drop the fence.
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, ''))

  // Inline code — keep inner text.
  s = s.replace(/`([^`]+)`/g, '$1')

  // Bold + italic — order matters (longest first).
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')

  // Links: [label](url) → label. (Images ![alt](url) → alt — strip the !)
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim()

  return s
}
