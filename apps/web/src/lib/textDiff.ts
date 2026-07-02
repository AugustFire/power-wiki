/**
 * Line-level plain-text diff — Stage 8 page history compare.
 *
 * Algorithm: classical O(N×M) LCS DP over the line lists, then a single
 * back-walk to emit `added` / `removed` / `unchanged` runs. No deps — the
 * input sizes here are tiny (a few hundred lines at most), so a hand-rolled
 * LCS is more than fast enough and avoids dragging in a 30KB diff library
 * for what's effectively a compare panel.
 *
 * Output shape:
 *   added:     lines present in `b` but not `a` (in `b`'s order, with their
 *              1-based line numbers in `b`)
 *   removed:   lines present in `a` but not `b` (in `a`'s order, with their
 *              1-based line numbers in `a`)
 *   unchanged: number of consecutive unchanged lines in the run. The diff
 *              view collapses long unchanged runs into "… N lines unchanged …"
 *              so the panel stays scannable.
 *
 * The diff is rendered as alternating runs:
 *   [unchanged N]  [removed X lines]  [added Y lines]  [unchanged N]  ...
 *
 * HTML pipeline: callers strip tags + decode entities + split on `\n`. We
 * keep that out of this module so the same routine can be reused with
 * any text source (not just HTML).
 */
export interface DiffRun {
  added: { line: string; lineNo: number }[]
  removed: { line: string; lineNo: number }[]
  /** Length of the consecutive unchanged run between the two diff hunks.
   *  Used by the view to collapse long stretches. */
  unchanged: number
}

export function textDiff(a: string, b: string): DiffRun[] {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  // dp[i][j] = LCS length of aLines[0..i) and bLines[0..j).
  const n = aLines.length
  const m = bLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = 1; i <= n; i++) {
    const aLine = aLines[i - 1]!
    for (let j = 1; j <= m; j++) {
      const bLine = bLines[j - 1]!
      dp[i]![j] =
        aLine === bLine
          ? (dp[i - 1]![j - 1] ?? 0) + 1
          : Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0)
    }
  }
  // Back-walk: emit runs. We keep a per-run buffer; when the run type
  // changes we flush and start a new run.
  const runs: DiffRun[] = []
  let cur: DiffRun = { added: [], removed: [], unchanged: 0 }
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) {
      flushIfTypeChange('unchanged')
      cur.unchanged++
      i--
      j--
    } else if ((dp[i - 1]![j] ?? 0) >= (dp[i]![j - 1] ?? 0)) {
      flushIfTypeChange('removed')
      cur.removed.unshift({ line: aLines[i - 1]!, lineNo: i })
      i--
    } else {
      flushIfTypeChange('added')
      cur.added.unshift({ line: bLines[j - 1]!, lineNo: j })
      j--
    }
  }
  while (i > 0) {
    flushIfTypeChange('removed')
    cur.removed.unshift({ line: aLines[i - 1]!, lineNo: i })
    i--
  }
  while (j > 0) {
    flushIfTypeChange('added')
    cur.added.unshift({ line: bLines[j - 1]!, lineNo: j })
    j--
  }
  if (
    cur.added.length > 0 ||
    cur.removed.length > 0 ||
    cur.unchanged > 0
  ) {
    runs.push(cur)
  }
  return runs

  function flushIfTypeChange(nextKind: 'added' | 'removed' | 'unchanged'): void {
    const curKind =
      cur.added.length > 0 ? 'added' : cur.removed.length > 0 ? 'removed' : cur.unchanged > 0 ? 'unchanged' : null
    if (curKind === null || curKind === nextKind) return
    runs.push(cur)
    cur = { added: [], removed: [], unchanged: 0 }
  }
}

/**
 * Collapse runs to a view-friendly shape: cap unchanged runs at `maxGap`
 * consecutive lines (default 3 on each side), let the rest become a single
 * "… N lines unchanged …" placeholder.
 */
export interface CollapsedDiffRun extends DiffRun {
  collapsedUnchanged?: number
}

export function collapseUnchanged(runs: DiffRun[], keepEachSide = 3): (DiffRun | { collapsedUnchanged: number })[] {
  const out: (DiffRun | { collapsedUnchanged: number })[] = []
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]!
    const u = run.unchanged
    if (u <= keepEachSide * 2) {
      out.push(run)
      continue
    }
    // Split into leading / collapsed / trailing chunks.
    if (keepEachSide > 0) {
      out.push({ added: [], removed: [], unchanged: keepEachSide })
    }
    const middle = u - keepEachSide * 2
    out.push({ collapsedUnchanged: middle })
    if (keepEachSide > 0) {
      out.push({ added: [], removed: [], unchanged: keepEachSide })
    }
  }
  return out
}

/**
 * Strip HTML tags + decode entities, then split on `\n`. The diff view feeds
 * the sanitized HTML through this so users see the same line breaks they
 * see in the read view.
 */
export function htmlToText(html: string): string {
  // Replace block-level tags with newlines BEFORE stripping, so we preserve
  // the natural paragraph / heading / list-item boundaries instead of
  // collapsing everything into a single line.
  const withBreaks = html
    .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div|\/tr)\s*>/gi, '\n')
    .replace(/<\s*(p|li|h[1-6]|div|tr)\b[^>]*>/gi, '')
  const noTags = withBreaks.replace(/<[^>]+>/g, '')
  return decodeEntities(noTags).replace(/\n{3,}/g, '\n\n').trimEnd()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}