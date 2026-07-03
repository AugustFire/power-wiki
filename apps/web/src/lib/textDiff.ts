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

// ─────────────────────────────────────────────────────────────────
//  Inline 字符级 diff(Confluence / Notion / 飞书的「行内红删绿加」)
//
//  之前的行级 LCS(`textDiff` + `collapseUnchanged`)在 prose 场景下
//  有结构性问题:用户改一段里的一句话,LCS 看不到行内变化,只能
//  把整段标记成「删 + 加」。读起来像"这次提交动了大段",实际只是
//  改了几个字 —— 用户对版本历史量的判断会被误导。
//
//  字符级 Myers diff + 连续同类合并,输出渲染就绪的 inline span 序列,
//  让 UI 直接套 `<span class="diff-char added|removed">{{ text }}</span>`
//  就能拿到 Confluence 那种"段子里几个字符红删几个字符绿加"的体验。
//
//  字符级而非词级:CJK 没有空格分词,词级边界不清晰;字符级统一、简单,
//  跟 Notion 的实际渲染策略一致(Notion 中文段落也是字符级高亮)。
//
//  算法:经典 Myers O((N+M)·D),D = edit distance。前向走 V 数组 +
//  trace 快照,后向回溯 edit script。同类连续 edit 合并成一个 span。
// ─────────────────────────────────────────────────────────────────

export interface InlineSpan {
  kind: 'unchanged' | 'added' | 'removed'
  text: string
}

export function inlineCharDiff(a: string, b: string): InlineSpan[] {
  const N = a.length
  const M = b.length
  // V indexed by (k + max) where k = x - y.
  // k 的范围 [-N..+M],所以 size = N+M+1,偏移 max=N+M 让所有索引非负。
  const max = N + M
  const size = max * 2 + 1
  const v: number[] = new Array<number>(size).fill(0)
  const trace: number[][] = []

  // 前向:找最短编辑路径。D 上限 N+M(全部删 + 全部加)。
  let found = false
  for (let d = 0; d <= max; d++) {
    // 拍快照 —— 回溯时要查 d-1 步之前的 V。
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + max
      let x: number
      // Myers 转移规则:
      //   k === -d 时只能 down(插入,坐标 (k+1) 走下来)
      //   k === +d 时只能 right(删除,坐标 (k-1) 走过去 +1)
      //   中间情况:V[k-1] < V[k+1] 选 down(取更大 x),否则 right
      if (k === -d || (k !== d && (v[kIdx - 1] ?? 0) < (v[kIdx + 1] ?? 0))) {
        x = v[kIdx + 1] ?? 0
      } else {
        x = (v[kIdx - 1] ?? 0) + 1
      }
      let y = x - k
      // 沿对角线一直走,直到字符不等或撞到边界 —— 这段是 unchanged snake。
      while (x < N && y < M && a[x] === b[y]) {
        x++
        y++
      }
      v[kIdx] = x
      if (x >= N && y >= M) {
        found = true
        break
      }
    }
    if (found) break
  }

  // 反向:从 (N, M) 走到 (0, 0),每一步产生一个 edit。
  // trace[d] 是 d 迭代开始时 V 的快照,所以回溯 d 这一步时用它作为
  // "d 修改之前的 V" —— 决定从哪条对角线走过来。
  const edits: Array<'unchanged' | 'added' | 'removed'> = []
  let x = N
  let y = M
  for (let d = trace.length - 1; d >= 1; d--) {
    const vPrev = trace[d]!
    const k = x - y
    const kIdx = k + max
    // 复算 prev_k —— 必须跟正向用同一规则,否则回溯走错对角线。
    const prevK =
      k === -d || (k !== d && (vPrev[kIdx - 1] ?? 0) < (vPrev[kIdx + 1] ?? 0))
        ? k + 1
        : k - 1
    const prevX = vPrev[prevK + max] ?? 0
    const prevY = prevX - prevK
    // 先把 snake 上的 unchanged 全部吐出来。
    while (x > prevX && y > prevY) {
      edits.push('unchanged')
      x--
      y--
    }
    // 最后一格是 edit step:x 没变 = down = added;y 没变 = right = removed。
    if (x === prevX) {
      edits.push('added')
      y--
    } else {
      edits.push('removed')
      x--
    }
  }
  // d=0 没有任何 edit step,剩下的全是 unchanged snake(从 (x,y) 回到 (0,0))。
  while (x > 0 && y > 0) {
    edits.push('unchanged')
    x--
    y--
  }
  edits.reverse()

  // 走 edit script,把对应字符塞进 spans,连续同类合并。
  const spans: InlineSpan[] = []
  let xi = 0
  let yi = 0
  for (const edit of edits) {
    if (edit === 'unchanged') {
      pushChar(spans, 'unchanged', a[xi]!)
      xi++
      yi++
    } else if (edit === 'added') {
      pushChar(spans, 'added', b[yi]!)
      yi++
    } else {
      pushChar(spans, 'removed', a[xi]!)
      xi++
    }
  }
  return spans
}

function pushChar(spans: InlineSpan[], kind: InlineSpan['kind'], ch: string): void {
  const last = spans[spans.length - 1]
  if (last && last.kind === kind) {
    last.text += ch
  } else {
    spans.push({ kind, text: ch })
  }
}