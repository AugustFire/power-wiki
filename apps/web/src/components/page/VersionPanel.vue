<script setup lang="ts">
/**
 * VersionPanel — Stage 8 right-side panel for page history.
 *
 * Mirrors the layout of TocPanel (vertical list, header + close), with
 * vertical version rows: `v{N} · 相对时间 · 作者`. Click a row → expands
 * inline to show a line-level diff against the current page content, with
 * a "恢复此版本" button that fires `restore()`.
 *
 * Loads via `usePageVersions().ensureLoaded(pageId)` (promise cache — no
 * duplicate fetches if panel reopens quickly).
 *
 * B.3 rules respected:
 *   - topbar / breadcrumb / subheader / sidebar stay mounted; only the
 *     panel content flips to <Skeleton> while loading
 *   - chrome-during-load: skeleton shows immediately (panel is empty when
 *     `versions.length === 0 && loading`), no blank flash
 */
import { computed, onMounted, ref, watch } from 'vue'
import { usePageVersions } from '@/composables/usePageVersions'
import { usePagesStore } from '@/stores/pages'
import { useUiStore } from '@/stores/ui'
import Skeleton from '@/components/ui/Skeleton.vue'
import VersionDiffView from '@/components/page/VersionDiffView.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { formatRelativeTime } from '@/lib/relativeTime'
import type { PageVersion } from '@power-wiki/shared'

const props = defineProps<{
  pageId: string
}>()
const emit = defineEmits<{
  close: []
}>()

const pagesStore = usePagesStore()
const ui = useUiStore()
const versionsComposable = usePageVersions()

const state = computed(() => versionsComposable.state(props.pageId))
const page = computed(() => pagesStore.getPage(props.pageId))

const expandedId = ref<string | null>(null)
const restoringId = ref<string | null>(null)

onMounted(() => {
  void versionsComposable.ensureLoaded(props.pageId)
})

watch(
  () => props.pageId,
  async (id) => {
    expandedId.value = null
    await versionsComposable.ensureLoaded(id)
  },
)

async function loadMore() {
  await versionsComposable.loadMore(props.pageId)
}

function toggleExpand(v: PageVersion) {
  expandedId.value = expandedId.value === v.id ? null : v.id
}

async function restore(v: PageVersion) {
  if (restoringId.value) return
  restoringId.value = v.id
  try {
    const updated = await versionsComposable.restore(props.pageId, v.id)
    // Sync the pages store with the restored snapshot so the read view
    // re-renders immediately. The composable dropped its cache above so
    // the next panel open re-fetches the list (now with the new "restored
    // from vN" row at the top).
    if (page.value) {
      page.value.title = updated.title
      page.value.contentJSON = updated.contentJSON
      page.value.contentHTML = updated.contentHTML
      page.value.icon = updated.icon
      page.value.updatedAt = updated.updatedAt
    }
    expandedId.value = null
  } catch (e) {
    ui.setError(`恢复失败: ${e instanceof Error ? e.message : '未知错误'}`)
  } finally {
    restoringId.value = null
  }
}
</script>

<template>
  <aside class="version-panel">
    <header class="vp-header">
      <h3 class="vp-title">
        <span class="material-symbols-outlined icon-sm">history</span>
        版本历史
      </h3>
      <button
        class="icon-btn small"
        type="button"
        title="关闭"
        aria-label="关闭版本历史"
        @click="emit('close')"
      >
        <span class="material-symbols-outlined">close</span>
      </button>
    </header>

    <div class="vp-body">
      <template v-if="state.loading && state.versions.length === 0">
        <div class="vp-skeleton">
          <Skeleton v-for="i in 5" :key="i" height="36px" radius="4px" />
        </div>
      </template>
      <template v-else-if="state.versions.length === 0">
        <div class="vp-empty">
          <span class="material-symbols-outlined icon-lg">history_toggle_off</span>
          <p>暂无历史版本</p>
          <small>编辑页面后会自动创建第一个版本快照。</small>
        </div>
      </template>
      <template v-else>
        <ul class="vp-list">
          <li
            v-for="v in state.versions"
            :key="v.id"
            class="vp-item"
            :class="{ expanded: expandedId === v.id }"
          >
            <button class="vp-row" type="button" @click="toggleExpand(v)">
              <span class="vp-version">v{{ v.versionNumber }}</span>
              <UserAvatar
                :size="20"
                :color="v.editedByColor ?? 'var(--text-3)'"
                :label="v.editedByName ?? v.editedBy"
              />
              <span class="vp-author">{{ v.editedByName ?? '未知作者' }}</span>
              <span class="vp-time">{{ formatRelativeTime(v.editedAt) }}</span>
              <span
                class="material-symbols-outlined vp-caret"
                :class="{ open: expandedId === v.id }"
                >expand_more</span
              >
            </button>
            <div v-if="expandedId === v.id && page" class="vp-detail">
              <VersionDiffView :current-html="page.contentHTML" :version="v" />
              <div class="vp-actions">
                <button
                  class="btn primary small"
                  type="button"
                  :disabled="restoringId === v.id"
                  @click="restore(v)"
                >
                  <span class="material-symbols-outlined icon-sm">restore</span>
                  恢复此版本
                </button>
              </div>
            </div>
          </li>
        </ul>
        <div v-if="state.hasMore" class="vp-load-more">
          <button
            class="btn ghost small"
            type="button"
            :disabled="state.loading"
            @click="loadMore"
          >
            {{ state.loading ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.version-panel {
  width: 320px;
  flex-shrink: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - var(--topbar-h) - 48px);
  position: sticky;
  top: calc(var(--topbar-h) + 24px);
  align-self: flex-start;
}
.vp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.vp-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.icon-btn.small {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-btn.small:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.icon-btn.small .material-symbols-outlined {
  font-size: 18px;
}
.vp-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 6px;
}
.vp-skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px;
}
.vp-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-3);
}
.vp-empty .material-symbols-outlined {
  font-size: 32px;
  color: var(--text-3);
  opacity: 0.5;
}
.vp-empty p {
  margin: 8px 0 4px;
  font-weight: 600;
}
.vp-empty small {
  font-size: 12px;
  line-height: 1.5;
}
.vp-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.vp-item {
  border-radius: var(--radius-sm);
  margin: 0 4px 2px;
}
.vp-item.expanded {
  background: var(--bg-subtle);
}
.vp-row {
  display: grid;
  grid-template-columns: 36px 20px 1fr auto auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: var(--text-1);
}
.vp-row:hover {
  background: var(--bg-subtle);
}
.vp-version {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 2px 6px;
  border-radius: 3px;
  text-align: center;
}
.vp-author {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vp-time {
  font-size: 11px;
  color: var(--text-3);
}
.vp-caret {
  font-size: 18px;
  color: var(--text-3);
  transition: transform 120ms ease;
}
.vp-caret.open {
  transform: rotate(180deg);
}
.vp-detail {
  padding: 8px 12px 12px;
}
.vp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.vp-load-more {
  padding: 8px 12px;
  text-align: center;
}
</style>