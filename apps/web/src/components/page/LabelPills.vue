<script setup lang="ts">
/**
 * LabelPills — Stage 8 page-label chip row.
 *
 * Renders the page's `labels` array as `.label-chip` pills, with:
 *   - A `+` trigger chip that opens LabelAddPopover.
 *   - A `×` on each existing pill for removal (any reader can remove —
 *     Notion-style; matches the backend permission model).
 *
 * Empty-state policy: if `labels.length === 0` we still render the `+`
 * chip so the row exists in the layout (prevents the subheader height
 * from collapsing when labels get added/removed). When in `compact` mode
 * (the EditView header) the row hides itself entirely when empty.
 *
 * Mutations follow the snapshot/push/restore pattern: optimistic insert,
 * API call, on failure pop and re-render with the original list. The
 * pagesStore already owns the page row, so labels live on `page.labels`
 * — we mutate the array in place (Vue reactivity picks it up).
 */
import { computed, ref } from 'vue'
import type { PageNode } from '@power-wiki/shared'
import { api } from '@/lib/api'
import { labelColorVars } from '@/lib/labelColor'
import LabelAddPopover from '@/components/page/LabelAddPopover.vue'

const props = withDefaults(
  defineProps<{
    page: PageNode
    /** When true, hide the row entirely if there are no labels AND no
     *  popover trigger (EditView header bar). Read view always shows
     *  the + trigger even when empty. */
    compact?: boolean
  }>(),
  { compact: false },
)

const popoverOpen = ref(false)
const popoverAnchor = ref<{ x: number; y: number } | null>(null)

const labels = computed(() => props.page.labels ?? [])

/** 每个标签按名字哈希取一组固定配色(bg/fg),inline style 应用到 chip。 */
function chipStyle(label: string) {
  const { bg, fg } = labelColorVars(label)
  return { background: bg, color: fg }
}

const showRow = computed(() => !props.compact || labels.value.length > 0 || popoverOpen.value)

function openPopover(e: MouseEvent) {
  popoverAnchor.value = { x: e.clientX, y: e.clientY }
  popoverOpen.value = true
}

function closePopover() {
  popoverOpen.value = false
  popoverAnchor.value = null
}

async function addLabel(label: string) {
  const normalized = label.trim().toLowerCase()
  if (!normalized) return
  // Optimistic insert — dedup against existing labels.
  if (labels.value.includes(normalized)) {
    closePopover()
    return
  }
  const snapshot = labels.value.slice()
  props.page.labels = [...snapshot, normalized]
  try {
    await api.pageLabels.add(props.page.id, normalized)
  } catch (e) {
    props.page.labels = snapshot
    throw e
  } finally {
    closePopover()
  }
}

async function removeLabel(label: string) {
  if (!labels.value.includes(label)) return
  const snapshot = labels.value.slice()
  props.page.labels = snapshot.filter((l) => l !== label)
  try {
    await api.pageLabels.remove(props.page.id, label)
  } catch (e) {
    props.page.labels = snapshot
    throw e
  }
}
</script>

<template>
  <div v-if="showRow" class="labels" @click.stop>
    <!-- 左侧 sell icon — 标签牌形状,比 label 像「tag」一点 -->
    <span
      class="material-symbols-outlined label-leading-icon"
      aria-hidden="true"
    >sell</span>
    <span
      v-for="l in labels"
      :key="l"
      class="label-chip label-chip-removable"
      :style="chipStyle(l)"
    >
      {{ l }}
      <button
        class="label-remove"
        type="button"
        :aria-label="`移除标签 ${l}`"
        :title="`移除标签 ${l}`"
        @click.stop="removeLabel(l)"
      >
        <span class="material-symbols-outlined icon-xs">close</span>
      </button>
    </span>
    <!-- 文字按钮触发 popover — 跟 design 一致,用 accent 文字而不是 dashed chip -->
    <button
      class="label-add-text"
      type="button"
      @click="openPopover"
    >
      {{ labels.length > 0 ? '编辑标签' : '添加标签' }}
    </button>
    <LabelAddPopover
      v-if="popoverOpen && popoverAnchor"
      :anchor="popoverAnchor"
      @pick="addLabel"
      @close="closePopover"
    />
  </div>
</template>

<style scoped>
/* Match design/wiki-read.html line 297 + 320-324 + 418:
 *   bg-subtle background, text-2 color, 2px 6px padding, 3px radius,
 *   12px font, weight 600, leading 18px label icon. */
.labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 32px 0;
  align-items: center;
}

.label-leading-icon {
  font-size: 18px;
  color: var(--text-3);
  margin-right: 4px;
}

/* 覆盖全局 .label-chip(799 行)的固定 22px 高度和 weight 500 —— design
 * chips 高度自动 + weight 600。 */
.label-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  height: auto;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  cursor: default;
}

.label-chip-removable:hover {
  /* hover 时透出 × —— 静态态隐藏。 */
}

.label-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 0;
  background: transparent;
  color: currentColor;
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity 0.1s;
}
.label-chip-removable:hover .label-remove {
  opacity: 1;
}
.label-remove:hover {
  background: rgba(9, 30, 66, 0.1);
  color: var(--text-1);
}
.label-remove .material-symbols-outlined {
  font-size: 11px;
}

.label-add-text {
  background: transparent;
  border: 0;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  padding: 2px 6px;
  cursor: pointer;
  font-family: inherit;
  margin-left: 4px;
  border-radius: 3px;
}
.label-add-text:hover {
  background: var(--bg-subtle);
}
</style>