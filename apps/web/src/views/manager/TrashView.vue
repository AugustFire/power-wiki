<script setup lang="ts">
/**
 * TrashView — Stage 5 admin trash view.
 *
 * Lists trashed pages for a chosen space with restore / permanent-delete
 * actions. Single-component (no right-side context panel) because the
 * list IS the action surface — every row needs two prominent buttons.
 *
 * Source of truth: `pagesStore.trashed` (refreshed by `loadTrash(spaceId)`
 * on mount and after every mutation). Space selector is a vanilla <select>
 * over the admin's visible spaces (everyone is admin to reach this view).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useUiStore } from '@/stores/ui'
import { useConfirm } from '@/composables/useConfirm'
import { ApiError } from '@/lib/api'

const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const uiStore = useUiStore()
const { confirm } = useConfirm()

const selectedSpaceId = ref<string>(spacesStore.activeSpaceId.value ?? '')
const busy = ref<string | null>(null)

// Hydrate spaces on first mount — admin /manager layout already required
// auth, but spaces might not be loaded yet if user deep-linked here.
onMounted(async () => {
  if (!spacesStore.loaded) await spacesStore.init()
  if (!selectedSpaceId.value && spacesStore.spaces.value.length > 0) {
    selectedSpaceId.value = spacesStore.spaces.value[0]!.id
  }
  if (selectedSpaceId.value) await pagesStore.loadTrash(selectedSpaceId.value)
})

watch(selectedSpaceId, async (id) => {
  if (id) await pagesStore.loadTrash(id)
})

const rows = computed(() => pagesStore.trashed)

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

function deletedByLabel(id: string | null | undefined): string {
  if (!id) return '未知'
  if (id === 'me') return '旧数据'
  return id
}

async function onRestore(id: string) {
  busy.value = id
  try {
    await pagesStore.restorePage(id)
    uiStore.clearError()
  } catch {
    // banner handled by store
  } finally {
    busy.value = null
  }
}

async function onPurge(id: string, title: string) {
  const ok = await confirm({
    title: `永久删除「${title}」?`,
    message: '此操作不可恢复,将从数据库中物理删除该页面及其所有已删除的子页面。',
    danger: true,
    confirmText: '永久删除',
    cancelText: '取消',
  })
  if (!ok) return
  busy.value = id
  try {
    await pagesStore.purgePage(id)
  } catch {
    // banner handled by store
  } finally {
    busy.value = null
  }
}

/**
 * Inspect the parent of a trashed row to decide whether `Restore` is
 * allowed. We don't preload parents; just call into the existing pages
 * cache (the trash listing already left the parent in `pages.value`).
 */
function parentIsTrashed(node: { parentId: string | null }): boolean {
  if (node.parentId == null) return false
  const parent = pagesStore.getPage(node.parentId)
  return parent != null && parent.deletedAt != null
}
</script>

<template>
  <div class="trash-view">
    <header class="trash-header">
      <div class="title-block">
        <h1 class="title">回收站</h1>
        <p class="subtitle">软删除的页面。恢复会按原父级放回;父级也已被删除时,需要先恢复父级。</p>
      </div>
      <div class="controls">
        <label class="select-wrap">
          <span>空间</span>
          <select v-model="selectedSpaceId">
            <option v-for="s in spacesStore.spaces.value" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </label>
        <button class="refresh-btn" @click="pagesStore.loadTrash(selectedSpaceId)">
          <span class="material-symbols-outlined icon-md">refresh</span>
          刷新
        </button>
      </div>
    </header>

    <div v-if="rows.length === 0" class="empty">
      <span class="material-symbols-outlined empty-icon">delete_sweep</span>
      <h2>该空间没有已删除的页面</h2>
      <p>用户删除的页面会出现在这里。</p>
    </div>

    <table v-else class="trash-table">
      <thead>
        <tr>
          <th class="col-title">页面</th>
          <th class="col-by">删除者</th>
          <th class="col-when">删除时间</th>
          <th class="col-actions">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ busy: busy === row.id }">
          <td class="col-title">
            <div class="title-cell">
              <span class="material-symbols-outlined doc-icon" style="font-size:18px">description</span>
              <span class="title-text">{{ row.title || '未命名' }}</span>
              <span v-if="row.parentId" class="parent-hint" :title="row.parentId">
                <span class="material-symbols-outlined" style="font-size:14px">subdirectory_arrow_right</span>
                <span v-if="parentIsTrashed(row)" class="parent-trashed">父级已删除</span>
                <span v-else>已挂载</span>
              </span>
            </div>
          </td>
          <td class="col-by">{{ deletedByLabel(row.deletedBy) }}</td>
          <td class="col-when">{{ row.deletedAt ? relativeTime(row.deletedAt) : '—' }}</td>
          <td class="col-actions">
            <button
              class="row-btn restore"
              :disabled="busy === row.id || parentIsTrashed(row)"
              :title="parentIsTrashed(row) ? '请先恢复父级' : '恢复到原位置'"
              @click="onRestore(row.id)"
            >
              <span class="material-symbols-outlined icon-sm">restore</span>
              恢复
            </button>
            <button
              class="row-btn danger"
              :disabled="busy === row.id"
              title="永久删除(不可恢复)"
              @click="onPurge(row.id, row.title)"
            >
              <span class="material-symbols-outlined icon-sm">delete_forever</span>
              永久删除
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.trash-view { max-width: 1100px; }

.trash-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}

.title-block .title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 4px;
}
.title-block .subtitle {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
}

.controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.select-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
}
.select-wrap select {
  height: 28px;
  padding: 0 24px 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  cursor: pointer;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
}
.refresh-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}

.empty {
  padding: 80px 0;
  text-align: center;
  color: var(--text-3);
}
.empty-icon {
  font-size: 56px;
  display: block;
  margin-bottom: 12px;
  color: var(--text-3);
}
.empty h2 {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-2);
  margin: 0 0 6px;
}
.empty p {
  font-size: 13px;
  margin: 0;
}

.trash-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.trash-table th,
.trash-table td {
  padding: 10px 12px;
  text-align: left;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.trash-table th {
  background: var(--bg-subtle);
  color: var(--text-3);
  font-weight: 500;
  font-size: 12px;
  text-transform: none;
  letter-spacing: 0;
}
.trash-table tr:last-child td { border-bottom: none; }
.trash-table tr.busy { opacity: 0.6; }

.col-title { width: 50%; }
.col-by { width: 15%; color: var(--text-2); }
.col-when { width: 15%; color: var(--text-2); }
.col-actions { width: 20%; text-align: right; white-space: nowrap; }

.title-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-1);
  font-weight: 500;
}
.title-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.parent-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}
.parent-trashed { color: var(--danger, #DE350B); font-weight: 500; }

.row-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  margin-left: 6px;
}
.row-btn:hover:not(:disabled) {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.row-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.row-btn.danger { color: var(--danger, #DE350B); border-color: var(--danger, #DE350B); }
.row-btn.danger:hover:not(:disabled) {
  background: var(--danger, #DE350B);
  color: white;
}
.row-btn.restore { color: var(--accent); border-color: var(--accent); }
.row-btn.restore:hover:not(:disabled) {
  background: var(--accent-soft);
}
</style>