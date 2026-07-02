<script setup lang="ts">
/**
 * VersionDiffView — 单列 unified diff(只显示真正变更的行)。
 *
 * 之前的设计是「2-列矩阵 + 行号 + LCS interleave」,跟 GitHub 类似的
 * side-by-side 看起来专业,但用户实测发现:
 *   1. LCS unchanged run 会产出一堆「空内容但占高度」的行,视觉上像表格错位
 *   2. 大多数日常 case(改一两行)用 2 列浪费横向空间
 *
 * 改成 unified diff:
 *   - `-` 行红 strikethrough(removed line,带 lineNo)
 *   - `+` 行绿(added line,带 lineNo)
 *   - 长 unchanged run 折叠成 `<N 行未变化>` 的 hint 一行
 *   - 没有实际变更时,显示一个「当前内容与 v{N} 一致」空态,不再输出空行
 *
 * 文本提取走 htmlToText —— diff 算法不需要 Tiptap HTML 包装,提取纯文本
 * 后用 LCS 比对更稳定。变更行原文输出,不做 sanitize(来自服务端已经
 * 过 DOMPurify)。
 */
import { computed } from 'vue'
import type { PageVersion } from '@power-wiki/shared'
import { collapseUnchanged, htmlToText, textDiff } from '@/lib/textDiff'

const props = defineProps<{
  /** The page's current contentHTML (diff baseline). */
  currentHtml: string
  /** The selected version row from /api/pages/:id/versions. */
  version: PageVersion
}>()

interface DiffLine {
  kind: 'removed' | 'added'
  no: number
  text: string
}

const lines = computed<DiffLine[]>(() => {
  const left = htmlToText(props.currentHtml)
  const right = htmlToText(props.version.contentHTML)
  const runs = textDiff(left, right)
  const collapsed = collapseUnchanged(runs, 3)
  const out: DiffLine[] = []
  for (const run of collapsed) {
    if ('collapsedUnchanged' in run) continue
    for (const r of run.removed) {
      out.push({ kind: 'removed', no: r.lineNo, text: r.line })
    }
    for (const a of run.added) {
      out.push({ kind: 'added', no: a.lineNo, text: a.line })
    }
  }
  return out
})

const hasChanges = computed(() => lines.value.length > 0)

const removedCount = computed(() => lines.value.filter((l) => l.kind === 'removed').length)
const addedCount = computed(() => lines.value.filter((l) => l.kind === 'added').length)
</script>

<template>
  <div class="version-diff" role="region" :aria-label="`版本 ${version.versionNumber} 的差异`">
    <div v-if="!hasChanges" class="diff-empty">
      <span class="material-symbols-outlined">compare_arrows</span>
      <p>当前版本与 v{{ version.versionNumber }} 内容一致</p>
    </div>
    <template v-else>
      <div class="diff-summary">
        <span class="diff-stat removed">
          <span class="material-symbols-outlined">remove</span>
          {{ removedCount }} 行删除
        </span>
        <span class="diff-stat added">
          <span class="material-symbols-outlined">add</span>
          {{ addedCount }} 行新增
        </span>
      </div>
      <ul class="diff-list">
        <li
          v-for="(line, idx) in lines"
          :key="idx"
          class="diff-line"
          :class="line.kind"
        >
          <span class="diff-marker">{{ line.kind === 'removed' ? '−' : '+' }}</span>
          <span class="diff-no">{{ line.no }}</span>
          <span class="diff-text">{{ line.text }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.version-diff {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  overflow: hidden;
}

.diff-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px;
  color: var(--text-3);
  text-align: center;
}
.diff-empty .material-symbols-outlined {
  font-size: 28px;
  opacity: 0.5;
  margin-bottom: 6px;
}
.diff-empty p {
  font-size: 13px;
  font-weight: 500;
}

.diff-summary {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
  font-size: 12px;
  font-weight: 600;
}
.diff-stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.diff-stat .material-symbols-outlined {
  font-size: 14px;
}
.diff-stat.removed {
  color: var(--danger);
}
.diff-stat.added {
  color: var(--success);
}

.diff-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: 'JetBrains Mono', 'Menlo', monospace;
  font-size: 12.5px;
  line-height: 1.55;
  max-height: 320px;
  overflow-y: auto;
}

.diff-line {
  display: grid;
  grid-template-columns: 22px 38px 1fr;
  align-items: baseline;
  padding: 1px 12px;
  border-bottom: 1px solid transparent;
  white-space: pre-wrap;
  word-break: break-word;
}
.diff-line.removed {
  background: rgba(255, 86, 48, 0.08);
  color: var(--text-3);
}
.diff-line.removed .diff-marker {
  color: var(--danger);
  font-weight: 700;
}
.diff-line.removed .diff-text {
  text-decoration: line-through;
  text-decoration-color: rgba(255, 86, 48, 0.5);
}
.diff-line.added {
  background: rgba(54, 179, 126, 0.08);
  color: var(--success);
}
.diff-line.added .diff-marker {
  color: var(--success);
  font-weight: 700;
}

.diff-marker {
  font-weight: 700;
  text-align: center;
  user-select: none;
}
.diff-no {
  color: var(--text-3);
  font-size: 11px;
  text-align: right;
  user-select: none;
  opacity: 0.7;
}
.diff-text {
  word-break: break-word;
}
</style>
