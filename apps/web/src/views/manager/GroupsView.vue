<script setup lang="ts">
/**
 * GroupsView — admin user-group list + create. P1-15 重构:
 *
 * 原版卡片全量加载,既无服务端搜索也无分页。一个 100+ 用户组的团队
 * 下,首屏要拉全部数据卡片网格,P95 不动但 page / tile 都重得离谱。
 *
 * 现版跟 UsersView / TrashView 节奏对齐:
 *   - 服务端搜索 (name / description ILIKE)
 *   - 服务端排序 (name / memberCount / createdAt + asc / desc)
 *   - 服务端分页 (PAGE_SIZE = 50,上一页 / 下一页 + 跳页 input)
 *   - 复用 uiStore.toggleSection 做「创建面板」折叠(可选)
 *
 * 创建 / 删除 / 跳转 GroupEditView 的 UX 保留。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { api, ApiError } from '@/lib/api'
import { useConfirm } from '@/composables/useConfirm'
import { useManagerActions } from '@/composables/useManagerActions'
import EmptyState from '@/components/ui/EmptyState.vue'
import type { UserGroup } from '@power-wiki/shared'
import { useDocumentTitle } from '@/composables/useDocumentTitle'

const router = useRouter()
const uiStore = useUiStore()
const { confirm: askConfirm } = useConfirm()
const { showCreateGroup: showCreate } = useManagerActions()

useDocumentTitle(() => '用户组')

type SortKey = 'name' | 'memberCount' | 'createdAt'

interface GroupFilters {
  q: string
  sort: SortKey
  dir: 'asc' | 'desc'
}

const PAGE_SIZE = 50
const groups = ref<UserGroup[]>([])
const total = ref(0)
const page = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const loadError = ref<string | null>(null)

const filters = reactive<GroupFilters>({ q: '', sort: 'createdAt', dir: 'desc' })

const createName = ref('')
const createDesc = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const currentPage = computed(() => page.value + 1)
const pageStart = computed(() => (total.value === 0 ? 0 : page.value * PAGE_SIZE + 1))
const pageEnd = computed(() =>
  total.value === 0 ? 0 : Math.min((page.value + 1) * PAGE_SIZE, total.value),
)
const hasPrevPage = computed(() => page.value > 0)
const hasNextPage = computed(() => page.value + 1 < totalPages.value)

// 300ms debounce 让搜索框在打字过程中不发请求,跟 UsersView 一致。
import { debounce } from '@/lib/debounce'
const debouncedLoadFirst = debounce(() => {
  page.value = 0
  void load(true)
}, 300)

onMounted(() => { showCreate.value = false })

// filter watcher — q 走 debounce,sort/dir 立刻触发
watch(() => filters.q, () => debouncedLoadFirst())
watch([() => filters.sort, () => filters.dir], () => {
  page.value = 0
  void load(true)
})

watch(showCreate, (next, prev) => {
  if (next && !prev) {
    createName.value = ''
    createDesc.value = ''
    createError.value = null
  }
})

async function load(replace: boolean): Promise<void> {
  if (replace) refreshing.value = true
  else loading.value = true
  loadError.value = null
  try {
    const result = await api.admin.groups.list({
      limit: PAGE_SIZE,
      offset: page.value * PAGE_SIZE,
      q: filters.q || undefined,
      sort: filters.sort,
      dir: filters.dir,
    })
    groups.value = result.items
    hasMore.value = result.hasMore
    total.value = result.total
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '加载用户组失败'
    uiStore.setError(loadError.value)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

onMounted(() => { void load(true) })

function gotoPage(target: number): void {
  if (target < 0 || target >= totalPages.value) return
  page.value = target
  void load(false)
}

function openCreate(): void { showCreate.value = true }
function closeCreate(): void {
  showCreate.value = false
  createError.value = null
}

async function onSubmitCreate(): Promise<void> {
  if (creating.value) return
  if (!createName.value.trim()) {
    createError.value = '名称不能为空'
    return
  }
  creating.value = true
  createError.value = null
  try {
    const created = await api.admin.groups.create({
      name: createName.value.trim(),
      description: createDesc.value.trim() || undefined,
    })
    // 乐观插入到结果第一行;后端 total 已加,UI 重置到第一页以保证一致
    total.value += 1
    groups.value = [created, ...groups.value]
    showCreate.value = false
    if (page.value !== 0) {
      page.value = 0
      void load(true)
    }
  } catch (e) {
    createError.value = e instanceof ApiError ? e.message : '创建失败'
  } finally {
    creating.value = false
  }
}

async function onDelete(g: UserGroup): Promise<void> {
  let details: string[] = []
  try {
    const impact = await api.admin.groups.impact(g.id)
    if (impact.memberCount) details.push(`${impact.memberCount} 个成员关系`)
    if (impact.legacyGrantCount) details.push(`${impact.legacyGrantCount} 个旧授权关系`)
    if (impact.roleGrantCount) details.push(`${impact.roleGrantCount} 个角色授权`)
    if (impact.restrictionCount) details.push(`${impact.restrictionCount} 个页面限制`)
  } catch {
    details = []
  }
  const ok = await askConfirm({
    title: '删除用户组',
    message: `确定要删除用户组「${g.name}」吗?组内用户不会被删除。`,
    details,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.admin.groups.delete(g.id)
    groups.value = groups.value.filter((x) => x.id !== g.id)
    total.value = Math.max(0, total.value - 1)
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '删除失败')
  }
}

function openGroup(g: UserGroup): void {
  void router.push(`/manager/groups/${g.id}`)
}

const jumpPageInput = ref('')
watch(currentPage, (p) => {
  if (document.activeElement?.id !== 'gv-jump-page') jumpPageInput.value = String(p)
}, { immediate: true })
function submitJump(): void {
  const target = Math.max(1, Math.min(Number.parseInt(jumpPageInput.value, 10) || 1, totalPages.value))
  if (Number.isNaN(target)) {
    jumpPageInput.value = String(currentPage.value)
    return
  }
  jumpPageInput.value = String(target)
  if (target !== currentPage.value) gotoPage(target - 1)
}
</script>

<template>
  <div class="groups-view">
    <header class="gv-header">
      <div>
        <h1 class="gv-title">用户组</h1>
        <p class="gv-sub">用于批量管理用户对空间的访问权限</p>
      </div>
    </header>

    <div v-if="loadError" class="gv-error">{{ loadError }}</div>

    <div v-if="showCreate" class="create-panel">
      <h2 class="cp-title">创建用户组</h2>
      <div v-if="createError" class="cp-error">{{ createError }}</div>
      <div class="cp-grid">
        <label class="field">
          <span class="field-label">名称</span>
          <input
            v-model="createName"
            type="text"
            class="field-input"
            placeholder="例如:工程组"
            :disabled="creating"
            maxlength="64"
            autofocus
          />
        </label>
        <label class="field">
          <span class="field-label">描述(可选)</span>
          <input
            v-model="createDesc"
            type="text"
            class="field-input"
            placeholder="一句话说明这个组的用途"
            :disabled="creating"
            maxlength="200"
          />
        </label>
      </div>
      <div class="cp-actions">
        <button type="button" class="btn ghost" :disabled="creating" @click="closeCreate">取消</button>
        <button type="button" class="btn primary" :disabled="creating" @click="onSubmitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </div>
    </div>

    <!-- 工具栏 + 表格合并成一个 shell,跟 UsersView / TrashView 节奏一致。-->
    <div class="groups-shell">
      <div class="gv-toolbar">
        <div class="gv-search">
          <span class="material-symbols-outlined gv-search-icon">search</span>
          <input
            id="gv-search"
            v-model="filters.q"
            type="text"
            class="gv-search-input"
            placeholder="按名称 / 描述搜索…"
            autocomplete="off"
          />
          <button
            v-if="filters.q"
            type="button"
            class="gv-search-clear"
            title="清空搜索"
            @click="filters.q = ''"
          >
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <label class="gv-sort">
          <span>排序</span>
          <select v-model="filters.sort">
            <option value="createdAt">创建时间</option>
            <option value="name">名称</option>
            <option value="memberCount">成员数</option>
          </select>
          <select v-model="filters.dir" aria-label="排序方向" class="gv-dir">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </label>
      </div>

      <div v-if="loading && groups.length === 0" class="gv-loading">加载中…</div>
      <EmptyState
        v-else-if="!loading && groups.length === 0"
        class="gv-empty"
        :icon="filters.q ? 'search_off' : 'workspaces'"
        :title="filters.q ? '没有匹配的用户组' : '还没有用户组'"
        :hint="filters.q ? '试试调整搜索关键词。' : '创建用户组以批量管理用户的空间访问权限。'"
        size="md"
      />
      <table v-else class="gv-table">
        <thead>
          <tr>
            <th class="col-name">名称</th>
            <th>成员数</th>
            <th>创建时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in groups" :key="g.id">
            <td>
              <button type="button" class="gv-name-link" :title="`打开「${g.name}」详情`" @click="openGroup(g)">
                <span class="gv-name-text">{{ g.name }}</span>
                <span v-if="g.description" class="gv-name-desc">{{ g.description }}</span>
              </button>
            </td>
            <td>
              <span class="gv-count">{{ g.memberCount ?? 0 }}</span>
            </td>
            <td class="gv-date">{{ new Date(g.createdAt).toLocaleDateString('zh-CN') }}</td>
            <td class="col-actions">
              <button type="button" class="ra-btn" title="删除" @click="onDelete(g)">
                <span class="material-symbols-outlined">delete</span>
              </button>
              <button type="button" class="ra-btn ra-btn-ghost" title="查看详情" @click="openGroup(g)">
                <span class="material-symbols-outlined">arrow_forward</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- P1-15 · 分页 footer:counter + 翻页按钮 + 跳页 input。
           UI 跟 UsersView 分页 footer 节奏统一。-->
      <div v-if="total > 0 || loading" class="gv-pagination">
        <div class="gv-counter">
          <template v-if="loading && groups.length === 0">加载中…</template>
          <template v-else-if="total === 0">共 0 项</template>
          <template v-else>
            显示 <strong>{{ pageStart }}-{{ pageEnd }}</strong> · 共 <strong>{{ total }}</strong> 个
          </template>
        </div>
        <div class="gv-jump">
          <button type="button" class="pag-btn" :disabled="!hasPrevPage || loading" @click="gotoPage(page - 1)">
            <span class="material-symbols-outlined">chevron_left</span>
          </button>
          <label class="pag-jump-label">
            第
            <input
              id="gv-jump-page"
              v-model="jumpPageInput"
              type="text"
              inputmode="numeric"
              class="pag-jump-input"
              :disabled="loading"
              @keydown.enter="submitJump"
              @blur="submitJump"
            />
            页 · 共 <strong>{{ totalPages }}</strong> 页
          </label>
          <button type="button" class="pag-btn" :disabled="!hasNextPage || loading" @click="gotoPage(page + 1)">
            <span class="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.groups-view { max-width: 1400px; }
.gv-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.gv-title { font-size: 22px; font-weight: 700; color: var(--text-1); margin: 0; }
.gv-sub { font-size: 13px; color: var(--text-3); margin: 4px 0 0 0; }

.gv-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius-md, 4px);
  font-size: 14px;
  margin-bottom: 16px;
}

/* 创建面板 */
.create-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 20px 24px;
  margin-bottom: 16px;
}
.cp-title { font-size: 16px; font-weight: 600; color: var(--text-1); margin: 0; }
.cp-error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 8px 12px;
  border-radius: var(--radius-md, 4px);
  font-size: 13px;
  margin: 12px 0;
}
.cp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
.field-input {
  height: 36px;
  padding: 0 10px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: var(--bg);
  border: 2px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.field-input:focus { border-color: var(--accent); }
.cp-actions { display: flex; gap: 8px; justify-content: flex-end; }

/* shell — toolbar + table 包在一起,跟 UsersView 同款卡片感 */
.groups-shell {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  overflow: hidden;
}
.gv-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.gv-search {
  position: relative;
  display: flex;
  align-items: center;
  width: 360px;
  flex-shrink: 0;
}
.gv-search-icon {
  position: absolute;
  left: 10px;
  font-size: 18px;
  color: var(--text-3);
  pointer-events: none;
}
.gv-search-input {
  width: 100%;
  height: 32px;
  padding: 0 28px 0 34px;
  font: inherit;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.gv-search-input:hover { border-color: var(--border-strong); }
.gv-search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.gv-search-clear {
  position: absolute;
  right: 4px;
  width: 22px;
  height: 22px;
  border: 0;
  background: transparent;
  border-radius: var(--radius-sm, 3px);
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.gv-search-clear:hover { background: var(--bg-subtle); color: var(--text-1); }
.gv-search-clear .material-symbols-outlined { font-size: 14px !important; }

.gv-sort {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
}
.gv-sort select {
  height: 32px;
  padding: 0 24px 0 8px;
  font: inherit;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  cursor: pointer;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.gv-sort select:hover { border-color: var(--border-strong); }
.gv-sort select:focus { border-color: var(--accent); }
.gv-dir { min-width: 70px; }

/* 表格 */
.gv-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: var(--bg);
  font-size: 14px;
}
.gv-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 10px 16px;
  background: var(--bg-canvas);
  border-bottom: 1px solid var(--border);
}
.gv-table td {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
  vertical-align: middle;
}
.gv-table tr:last-child td { border-bottom: 0; }
.col-name { min-width: 240px; }
.col-actions { width: 1%; white-space: nowrap; text-align: right; }

.gv-name-link {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 0;
  background: transparent;
  border: 0;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}
.gv-name-text {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-1);
}
.gv-name-link:hover .gv-name-text { color: var(--accent); }
.gv-name-desc {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.4;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gv-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 22px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  background: var(--bg-canvas);
  border-radius: var(--radius-pill, 999px);
  font-variant-numeric: tabular-nums;
}
.gv-date { color: var(--text-3); font-size: 13px; }

.ra-btn {
  width: 28px;
  height: 28px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  cursor: pointer;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.ra-btn:hover { background: var(--danger-soft); color: var(--danger); }
.ra-btn-ghost:hover { background: var(--bg-canvas); color: var(--text-1); }
.ra-btn .material-symbols-outlined { font-size: 18px; }

/* 分页 footer — 跟 UsersView / TrashView 一致 */
.gv-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-canvas);
  font-size: 13px;
  color: var(--text-2);
}
.gv-counter strong,
.gv-jump strong {
  color: var(--text-1);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.gv-jump {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pag-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 3px);
  background: var(--bg);
  color: var(--text-2);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.pag-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-1);
}
.pag-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pag-btn .material-symbols-outlined { font-size: 18px !important; }
.pag-jump-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 13px;
}
.pag-jump-input {
  width: 44px;
  height: 28px;
  padding: 0 6px;
  text-align: center;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 3px);
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.pag-jump-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.pag-jump-input:disabled { opacity: 0.4; cursor: not-allowed; }

.gv-loading {
  padding: 60px 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 14px;
}
.gv-empty {
  padding: 60px 24px !important;
}
</style>
