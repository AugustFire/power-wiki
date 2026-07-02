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
    <span v-for="l in labels" :key="l" class="label-chip label-chip-removable">
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
    <button
      class="label-chip label-add"
      type="button"
      title="添加标签"
      aria-label="添加标签"
      @click="openPopover"
    >
      <span class="material-symbols-outlined icon-xs">add</span>
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
.labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 16px;
  align-items: center;
}

.label-chip-removable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
}
.label-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
}
.label-remove:hover {
  background: rgba(9, 30, 66, 0.1);
  color: var(--text-1);
}
.label-remove .material-symbols-outlined {
  font-size: 12px;
}

.label-add {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--text-3);
  cursor: pointer;
  width: 24px;
  padding: 0;
  justify-content: center;
}
.label-add:hover {
  background: var(--bg-subtle);
  color: var(--accent);
  border-color: var(--accent);
}
</style>