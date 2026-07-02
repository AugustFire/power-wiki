<script setup lang="ts">
/**
 * VersionPanel — 右抽屉式的页面历史面板。
 *
 * 数据流:
 *   - 打开 / 切换 pageId → 调 `refresh()` 强重拉,确保看到最新边界快照
 *     (EditView idle 30s / route leave 时打的 checkpoint,或在别的
 *     标签 / 同事刚写的版本)。
 *   - `loadMore` 走 pagination,server RETENTION=30 自动裁剪,UI
 *     只展示用户分页拉到的部分。
 *
 * 样式:跟 TocPanel 同款视觉 —— 280-320px 卡片式 aside,header
 * 普通 weight 的「版本历史」+ 关闭按钮。rows 是单列 list,每个
 * row 一个 24px 圆形头像居左、信息居中、caret 居右。展开时
 * `vp-detail` 区域显示 diff + 恢复按钮。
 */
import { computed, ref, watch } from 'vue'
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

/** 每个 panel 打开都强制刷新一次 —— 边界快照可能在用户切走期间产生。 */
async function refresh() {
  expandedId.value = null
  await versionsComposable.refresh(props.pageId)
}

watch(
  () => props.pageId,
  () => {
    void refresh()
  },
  { immediate: true },
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

/** 给 row 一个小标注 —— 手动 restore 的标来源,自动 snapshot 标「自动」,
 *  否则留空(只显示版本号 + 时间 + 作者)。 */
function noteFor(v: PageVersion): string {
  if (v.changeNote?.startsWith('restored from v')) return '从历史恢复'
  return '自动快照'
}
</script>

<template>
  <aside class="version-panel">
    <header class="vp-header">
      <h3 class="vp-title">
        <span class="material-symbols-outlined">history</span>
        版本历史
        <span v-if="state.versions.length > 0" class="vp-count">{{ state.versions.length }}</span>
      </h3>
      <button
        class="vp-close"
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
          <Skeleton v-for="i in 5" :key="i" height="56px" radius="6px" />
        </div>
      </template>
      <template v-else-if="state.versions.length === 0">
        <div class="vp-empty">
          <span class="material-symbols-outlined">history_toggle_off</span>
          <p>暂无历史版本</p>
          <small>编辑页面后,空闲 30 秒或离开页面会自动创建一个快照。</small>
        </div>
      </template>
      <template v-else>
        <ul class="vp-list">
          <li
            v-for="(v, idx) in state.versions"
            :key="v.id"
            class="vp-item"
            :class="{ expanded: expandedId === v.id, current: idx === 0 }"
          >
            <button class="vp-row" type="button" @click="toggleExpand(v)">
              <UserAvatar
                :size="32"
                :color="v.editedByColor ?? 'var(--text-3)'"
                :label="v.editedByName ?? v.editedBy"
              />
              <div class="vp-row-info">
                <div class="vp-row-line-1">
                  <span class="vp-version">v{{ v.versionNumber }}</span>
                  <span class="vp-author">{{ v.editedByName ?? '未知作者' }}</span>
                  <span class="vp-time">{{ formatRelativeTime(v.editedAt) }}</span>
                </div>
                <div class="vp-row-line-2">
                  <span v-if="idx === 0" class="vp-tag current">当前版本</span>
                  <span class="vp-note">{{ noteFor(v) }}</span>
                </div>
              </div>
              <span
                class="material-symbols-outlined vp-caret"
                :class="{ open: expandedId === v.id }"
              >expand_more</span>
            </button>
            <div v-if="expandedId === v.id && page" class="vp-detail">
              <VersionDiffView :current-html="page.contentHTML" :version="v" />
              <div class="vp-actions">
                <button
                  v-if="idx !== 0"
                  class="btn primary"
                  type="button"
                  :disabled="restoringId === v.id"
                  @click="restore(v)"
                >
                  <span class="material-symbols-outlined">settings_backup_restore</span>
                  {{ restoringId === v.id ? '恢复中…' : '恢复此版本' }}
                </button>
                <span v-else class="vp-current-note">这是当前在用的版本</span>
              </div>
            </div>
          </li>
        </ul>
        <div v-if="state.hasMore" class="vp-load-more">
          <button
            class="vp-load-more-btn"
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
  border-radius: var(--radius-md, 6px);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - var(--topbar-h) - 96px);
  overflow: hidden;
  /* 不 sticky —— ReadView 的 right slot 已经是 sticky 滚动容器 */
}

/* ─── Header ───────────────────────────────────────────────── */
.vp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.vp-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  letter-spacing: 0;
}
.vp-title .material-symbols-outlined {
  font-size: 18px;
  color: var(--text-2);
}
.vp-count {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-3);
  background: var(--bg-subtle);
  border-radius: 10px;
  padding: 1px 8px;
}
.vp-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  cursor: pointer;
}
.vp-close:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.vp-close .material-symbols-outlined {
  font-size: 18px;
}

/* ─── Body / list ──────────────────────────────────────────── */
.vp-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.vp-skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px;
}

.vp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 32px 16px;
  color: var(--text-3);
}
.vp-empty .material-symbols-outlined {
  font-size: 32px;
  opacity: 0.5;
  margin-bottom: 6px;
}
.vp-empty p {
  margin: 4px 0;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
}
.vp-empty small {
  font-size: 12px;
  line-height: 1.5;
}

.vp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.vp-item {
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  transition: border-color 0.1s, background 0.1s;
}
.vp-item.expanded {
  background: var(--bg-subtle);
  border-color: var(--border);
}

.vp-row {
  display: grid;
  grid-template-columns: 32px 1fr 18px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.vp-row:hover {
  background: var(--bg-subtle);
}
.vp-item.expanded .vp-row {
  background: transparent;
}

.vp-row-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0; /* 让子元素 ellipsis 生效 */
}
.vp-row-line-1 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-1);
  min-width: 0;
}
.vp-row-line-2 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}

.vp-version {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--text-3);
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: 3px;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.vp-author {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vp-time {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
  flex-shrink: 0;
}

.vp-tag {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}
.vp-tag.current {
  background: var(--accent-soft);
  color: var(--accent);
}
.vp-note {
  color: var(--text-3);
  font-size: 11px;
}

.vp-caret {
  font-size: 18px;
  color: var(--text-3);
  transition: transform 120ms ease;
}
.vp-caret.open {
  transform: rotate(180deg);
  color: var(--text-2);
}

/* ─── Detail ──────────────────────────────────────────────── */
.vp-detail {
  padding: 4px 10px 12px;
}
.vp-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.vp-actions .btn {
  font-size: 12px;
  height: 28px;
  padding: 0 12px;
  gap: 4px;
}
.vp-actions .btn .material-symbols-outlined {
  font-size: 16px;
}
.vp-current-note {
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
}

.vp-load-more {
  padding: 12px 0;
  text-align: center;
}
.vp-load-more-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  font-family: inherit;
}
.vp-load-more-btn:hover:not(:disabled) {
  background: var(--bg-subtle);
  color: var(--text-1);
  border-color: var(--border-strong);
}
.vp-load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
