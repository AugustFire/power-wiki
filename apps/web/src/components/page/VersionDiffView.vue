<script setup lang="ts">
/**
 * VersionDiffView — render a line-level LCS diff between the current page
 * content and a selected past version.
 *
 * Two columns side-by-side, with the diff runs weaved across them:
 *   - Unchanged lines: rendered in both columns (neutral foreground).
 *   - Removed lines:   left column only, with line-through.
 *   - Added lines:     right column only, in success-green.
 *
 * Long unchanged runs collapse to a "… N lines unchanged …" placeholder
 * to keep the panel scannable.
 *
 * Both columns run through `sanitizeAndHardenLinks` to neutralize any
 * leftover `<script>` etc. before v-html — server HTML is already trusted
 * (it comes from our own API + DOMPurify upstream) but defense in depth is
 * cheap.
 */
import { computed } from 'vue'
import type { PageVersion } from '@power-wiki/shared'
import { collapseUnchanged, htmlToText, textDiff } from '@/lib/textDiff'
import { sanitizeAndHardenLinks } from '@/lib/sanitize'

const props = defineProps<{
  /** The page's current contentHTML (left column baseline). */
  currentHtml: string
  /** The selected version row from /api/pages/:id/versions. */
  version: PageVersion
}>()

interface LineRow {
  /** 'same' | 'removed' | 'added' | 'gap' */
  kind: 'same' | 'removed' | 'added' | 'gap'
  left: { html: string; no: number } | null
  right: { html: string; no: number } | null
  /** 'gap' rows display this collapsed count instead of actual lines. */
  gapCount?: number
}

const rows = computed<LineRow[]>(() => {
  const left = htmlToText(props.currentHtml)
  const right = htmlToText(props.version.contentHTML)
  const runs = textDiff(left, right)
  const collapsed = collapseUnchanged(runs, 3)
  const out: LineRow[] = []
  for (const run of collapsed) {
    if ('collapsedUnchanged' in run) {
      out.push({ kind: 'gap', left: null, right: null, gapCount: run.collapsedUnchanged })
      continue
    }
    // Interleave unchanged / removed / added within the run as separate
    // rows so the two columns align visually. Unchanged rows display the
    // SAME line on both sides; removed rows are left-only; added rows
    // are right-only.
    const u = run.unchanged
    if (u > 0) {
      // We don't track per-line numbers for unchanged lines because
      // they aren't produced by the LCS back-walk (only run length is).
      // Render them as plain contextual lines without numbers — this is
      // also how GitHub renders collapsed unchanged runs.
      for (let k = 0; k < u; k++) {
        out.push({
          kind: 'same',
          left: { html: '', no: 0 },
          right: { html: '', no: 0 },
        })
      }
    }
    // Removed + added are paired visually but as separate rows (left-only
    // then right-only), since lines don't have to align 1:1.
    for (const r of run.removed) {
      out.push({
        kind: 'removed',
        left: { html: escape(r.line), no: r.lineNo },
        right: null,
      })
    }
    for (const a of run.added) {
      out.push({
        kind: 'added',
        left: null,
        right: { html: escape(a.line), no: a.lineNo },
      })
    }
  }
  return out
})

function escape(s: string): string {
  return sanitizeAndHardenLinks(s)
}
</script>

<template>
  <div class="version-diff" role="region" aria-label="版本差异对比">
    <div class="diff-col-head">
      <span class="col-label left">当前版本</span>
      <span class="col-label right">v{{ version.versionNumber }} · {{ version.title }}</span>
    </div>
    <div class="diff-grid">
      <template v-for="(row, idx) in rows" :key="idx">
        <div
          v-if="row.kind === 'gap'"
          class="diff-row gap"
          :style="{ gridColumn: '1 / span 2' }"
        >
          …… {{ row.gapCount }} 行未变化 ……
        </div>
        <template v-else>
          <div class="diff-cell left" :class="row.kind">
            <span v-if="row.left" class="line-no">{{ row.left.no || '' }}</span>
            <span v-if="row.left && row.left.html" class="line-text" v-html="row.left.html" />
          </div>
          <div class="diff-cell right" :class="row.kind">
            <span v-if="row.right" class="line-no">{{ row.right.no || '' }}</span>
            <span v-if="row.right && row.right.html" class="line-text" v-html="row.right.html" />
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.version-diff {
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg-subtle);
  font-family: 'JetBrains Mono', 'Menlo', monospace;
  font-size: 12px;
  overflow: hidden;
}
.diff-col-head {
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.col-label {
  padding: 6px 12px;
}
.col-label.right {
  border-left: 1px solid var(--border);
  text-align: right;
}
.diff-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: stretch;
}
.diff-cell {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 12px;
  min-height: 22px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid var(--bg);
}
.diff-cell.right {
  border-left: 1px solid var(--border);
}
.line-no {
  flex-shrink: 0;
  min-width: 28px;
  color: var(--text-3);
  font-size: 11px;
  text-align: right;
  user-select: none;
}
.line-text {
  flex: 1;
}
.diff-cell.removed {
  background: rgba(255, 86, 48, 0.08);
  color: var(--text-3);
  text-decoration: line-through;
}
.diff-cell.removed .line-text {
  text-decoration: line-through;
}
.diff-cell.added {
  background: rgba(0, 200, 83, 0.08);
  color: var(--success);
}
.diff-cell.added .line-text {
  color: var(--success);
}
.diff-row.gap {
  background: var(--bg-subtle);
  color: var(--text-3);
  text-align: center;
  font-style: italic;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  grid-column: 1 / span 2;
}
</style>