<script setup lang="ts">
/**
 * VersionDiffView — 选中版本时右栏展示「v_{n-1} → v_n」这次提交的变更。
 *
 * Diff 范式:Confluence / Notion / 飞书风格的 **inline 字符级高亮**。
 *   - 整段文本连续渲染,变化字符就地套红删 / 绿加 span,不再拆 −/+
 *     行,也不再有行号。
 *   - 之前用 `textDiff(a, b)` 行级 LCS 时,改一行字会被显示成
 *     「删整段 + 加整段」,在 prose 场景下严重误导用户对改动量的
 *     判断。inline 字符级把"改一句话"还原成一次原子编辑。
 *
 * Diff 方向:
 *   - a = previousVersion(基线),b = selectedVersion(新版本)。
 *   - 「v_n 这次提交改了什么」关心的是这次提交本身的内容,不是
 *     「v_n 之后又改了什么」。
 *
 * 边界:
 *   - 首版(v1,无 previousVersion):不做「全段当新增」渲染 —— inline
 *     模式下整段染绿是假信号。改成走空态文案,正文在 spans 里以
 *     unchanged 形式给出(让用户能直接看到 v1 的初始内容)。
 *   - 内容完全一致:走另一支空态文案。
 *
 * 安全:渲染用 v-for + `{{ }}`(Vue text interpolation,自动 escape),
 * 不用 v-html。两侧内容来自后端 sanitize,但 escape-by-default 比
 * trust-the-server 永远安全。
 */
import { computed } from 'vue'
import type { PageVersion } from '@power-wiki/shared'
import { htmlToText, inlineCharDiff, type InlineSpan } from '@/lib/textDiff'

const props = defineProps<{
  /** The selected version row from /api/pages/:id/versions. */
  version: PageVersion
  /**
   * The version immediately preceding the selected one (i.e. v_{n-1}),
   * or null if the selected version is the first one. Used as the diff
   * baseline — showing what THIS version introduced.
   */
  previousVersion: PageVersion | null
}>()

const spans = computed<InlineSpan[]>(() => {
  if (!props.previousVersion) {
    // 首版:整段内容以 unchanged 形式直出 —— 没用 diff 颜色,但用户
    // 还是能看到 v1 当时的初始内容(而不是空白态)。
    return [{ kind: 'unchanged', text: htmlToText(props.version.contentHTML) }]
  }
  const left = htmlToText(props.previousVersion.contentHTML)
  const right = htmlToText(props.version.contentHTML)
  return inlineCharDiff(left, right)
})

const stats = computed(() => {
  let added = 0
  let removed = 0
  for (const s of spans.value) {
    if (s.kind === 'added') added += s.text.length
    else if (s.kind === 'removed') removed += s.text.length
  }
  return { added, removed }
})

const hasChanges = computed(() => stats.value.added > 0 || stats.value.removed > 0)

const emptyText = computed(() => {
  if (!props.previousVersion) {
    return `v${props.version.versionNumber} 是页面的初始版本,无可对比的上一版`
  }
  return `v${props.version.versionNumber} 与 v${props.previousVersion.versionNumber} 内容一致`
})
</script>

<template>
  <div class="version-diff" role="region" :aria-label="`版本 ${version.versionNumber} 的差异`">
    <div v-if="!hasChanges" class="diff-empty">
      <span class="material-symbols-outlined">compare_arrows</span>
      <p>{{ emptyText }}</p>
    </div>
    <template v-else>
      <div class="diff-summary">
        <span class="diff-stat added">
          <span class="material-symbols-outlined">add</span>
          {{ stats.added }} 字符新增
        </span>
        <span class="diff-stat removed">
          <span class="material-symbols-outlined">remove</span>
          {{ stats.removed }} 字符删除
        </span>
      </div>
      <!-- v-for + {{ }} 自动 escape;不变字符不套 span class,完全沿用阅读
           视图字色,视觉上跟 read view 的 prose 一致,只把变化部分高亮。 -->
      <div class="diff-inline">
        <span
          v-for="(span, i) in spans"
          :key="i"
          class="diff-char"
          :class="span.kind"
        >{{ span.text }}</span>
      </div>
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

/* Inline 渲染容器 —— Notion / Confluence / 飞书都是这种"段子里
 * 几个字符红删几个字符绿加"的形态。font-size 跟 line-height 跟
 * read view 的 prose 对齐,让用户感受是同一份文档,只是部分高亮。 */
.diff-inline {
  font-size: 14px;
  line-height: 1.7;
  padding: 14px 16px;
  max-height: 360px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-1);
}

/* 字符级高亮的视觉权重不要盖过正常文字 —— background 用 14-18%
 * 透明度 + 文字色压成 success / danger 即可,避免「整段染色」的
 * 视觉冲击让用户以为改动比实际大得多。 */
.diff-char.added {
  background: rgba(54, 179, 126, 0.18);
  color: var(--success);
  text-decoration: underline;
  text-decoration-color: rgba(54, 179, 126, 0.5);
  text-underline-offset: 2px;
  text-decoration-thickness: 1.5px;
}
.diff-char.removed {
  background: rgba(255, 86, 48, 0.14);
  color: var(--danger);
  text-decoration: line-through;
  text-decoration-color: rgba(255, 86, 48, 0.55);
  text-decoration-thickness: 1.5px;
}
</style>