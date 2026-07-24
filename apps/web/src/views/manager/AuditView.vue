<script setup lang="ts">
/**
 * AuditView — Phase C 权限变更审计日志。
 *
 * Admin only。Append-only 日志,GET 是唯一入口;无 POST/PATCH/DELETE 暴露给
 * HTTP 层。列表按 created_at DESC 排序,actor 通过后端 LEFT JOIN 平铺展示
 * 字段(denormalize),不再二次拉取 user 信息。
 *
 * 顶 toolbar:
 *   - targetKind select('space' | 'page' | 'page_share' | 'group' | 'user';空 = 全部)
 *   - kind select(11 个事件类型;空 = 全部) — 与 targetKind 软联动
 *   - 刷新
 *
 * 主区:单行活动流 —— 操作人头像 + 一句自然语言动作 + 相对时间 + 展开箭头。
 * 默认行高约 56px,字段变化、目标 ID 与原始 JSON 仅在点击展开时出现,展开
 * 互斥(同屏仅 1 行)。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { api, ApiError } from '@/lib/api'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { formatRelativeTime } from '@/lib/relativeTime'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import type {
  AuditEntry,
  AuditKind,
  AuditTargetKind,
} from '@power-wiki/shared'

useDocumentTitle(() => '审计日志')

/* ─── Filters ─────────────────────────────────────────────────────── */

const KIND_OPTIONS: { value: '' | AuditKind; label: string }[] = [
  { value: '', label: '全部事件' },
  { value: 'space_grant_set', label: '空间角色 - 全量更新' },
  { value: 'space_grant_add', label: '空间角色 - 授予' },
  { value: 'space_grant_remove', label: '空间角色 - 移除' },
  { value: 'page_restriction_set', label: '页面限制 - 全量更新' },
  { value: 'page_restriction_add', label: '页面限制 - 添加' },
  { value: 'page_restriction_remove', label: '页面限制 - 移除' },
  { value: 'page_share_create', label: '公开链接 - 创建' },
  { value: 'page_share_revoke', label: '公开链接 - 撤销' },
  { value: 'space_deleted', label: '空间 - 删除' },
  { value: 'group_deleted', label: '用户组 - 删除' },
  { value: 'user_anonymized', label: '用户 - 注销' },
]

const TARGET_KIND_OPTIONS: { value: '' | AuditTargetKind; label: string }[] = [
  { value: '', label: '全部目标' },
  { value: 'space', label: '空间' },
  { value: 'page', label: '页面' },
  { value: 'page_share', label: '公开链接' },
  { value: 'group', label: '用户组' },
  { value: 'user', label: '用户' },
]

const EVENT_TARGET_KIND: Record<AuditKind, AuditTargetKind> = {
  space_grant_set: 'space',
  space_grant_add: 'space',
  space_grant_remove: 'space',
  page_restriction_set: 'page',
  page_restriction_add: 'page',
  page_restriction_remove: 'page',
  page_share_create: 'page_share',
  page_share_revoke: 'page_share',
  space_deleted: 'space',
  group_deleted: 'group',
  user_anonymized: 'user',
}

const filterKind = ref<'' | AuditKind>('')
const filterTargetKind = ref<'' | AuditTargetKind>('')
const filterText = ref<string>('')

const visibleKindOptions = computed(() => {
  if (filterTargetKind.value === '') return KIND_OPTIONS
  return KIND_OPTIONS.filter(
    (option) => option.value === '' || EVENT_TARGET_KIND[option.value] === filterTargetKind.value,
  )
})

/* 单行展开 + 展开区内 JSON toggle。 */
const expandedEntryId = ref<string | null>(null)
const rawOpenId = ref<string | null>(null)

function toggleRow(id: string) {
  if (expandedEntryId.value === id) {
    expandedEntryId.value = null
    rawOpenId.value = null
  } else {
    expandedEntryId.value = id
    rawOpenId.value = null
  }
}

function toggleRaw(id: string) {
  rawOpenId.value = rawOpenId.value === id ? null : id
}

const limit = 50
const offset = ref(0)
const entries = ref<AuditEntry[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const r = await api.admin.audit.list({
      kind: filterKind.value === '' ? undefined : filterKind.value,
      targetKind: filterTargetKind.value === '' ? undefined : filterTargetKind.value,
      limit,
      offset: offset.value,
    })
    entries.value = r.entries
    total.value = r.total
    expandedEntryId.value = null
    rawOpenId.value = null
  } catch (e) {
    if (e instanceof ApiError) {
      error.value = e.status === 403 ? '没有权限(仅管理员可访问)' : `加载失败: HTTP ${e.status}`
    } else {
      error.value = '加载失败:网络错误'
    }
    entries.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

onMounted(load)

function onKindChange() {
  if (filterKind.value !== '') {
    filterTargetKind.value = EVENT_TARGET_KIND[filterKind.value]
  }
}

function onTargetKindChange() {
  if (
    filterKind.value !== '' &&
    filterTargetKind.value !== '' &&
    EVENT_TARGET_KIND[filterKind.value] !== filterTargetKind.value
  ) {
    filterKind.value = ''
  }
}

watch([filterKind, filterTargetKind], () => {
  offset.value = 0
  load()
})
watch(offset, load)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)))
const currentPage = computed(() => Math.floor(offset.value / limit) + 1)

function goPage(p: number) {
  if (p < 1 || p > totalPages.value) return
  offset.value = (p - 1) * limit
}

function refresh() {
  load()
}

/* ─── Render helpers ──────────────────────────────────────────────── */

function kindLabel(k: AuditKind): string {
  return KIND_OPTIONS.find((o) => o.value === k)?.label ?? k
}

type AuditPayload = Record<string, unknown>
type DetailRow = { label: string; before?: string; after?: string; value?: string }

function asRecord(value: unknown): AuditPayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as AuditPayload
    : {}
}

function displayValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'number' && value > 1_000_000_000_000) {
    return new Date(value).toLocaleString('zh-CN')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

function roleLabel(value: unknown): string {
  if (value === 'viewer') return '只读'
  if (value === 'editor') return '编辑'
  if (value === 'admin') return '管理'
  return displayValue(value)
}

function principalLabel(payload: AuditPayload): string {
  const kind = payload.principalKind === 'group' ? '用户组' : '用户'
  return `${kind} ${shortId(displayValue(payload.principalId))}`
}

function restrictionLabel(value: unknown): string {
  return value === 'view' ? '查看限制' : value === 'edit' ? '编辑限制' : displayValue(value)
}

function targetLabel(entry: AuditEntry): string {
  const payload = asRecord(entry.payload)
  const before = asRecord(payload.before)
  const short = shortId(entry.targetId)
  if (entry.kind === 'space_deleted' && before.name) return `空间「${displayValue(before.name)}」`
  if (entry.kind === 'group_deleted' && before.name) return `用户组「${displayValue(before.name)}」`
  if (entry.kind === 'user_anonymized' && before.name) return `用户「${displayValue(before.name)}」`
  switch (entry.targetKind) {
    case 'space': return `空间 ${short}`
    case 'page': return `页面 ${short}`
    case 'page_share': return `公开链接 ${short}`
    case 'group': return `用户组 ${short}`
    case 'user': return `用户 ${short}`
  }
}

function targetIcon(t: AuditTargetKind): string {
  switch (t) {
    case 'space': return 'folder'
    case 'page': return 'description'
    case 'page_share': return 'link'
    case 'group': return 'groups'
    case 'user': return 'person'
  }
}

function auditSummary(entry: AuditEntry): string {
  const payload = asRecord(entry.payload)
  const before = asRecord(payload.before)
  const after = asRecord(payload.after)
  switch (entry.kind) {
    case 'space_grant_set': return '全量更新了空间成员角色'
    case 'space_grant_add': return `向${principalLabel(after)}授予了「${roleLabel(after.role)}」角色`
    case 'space_grant_remove': return `移除了${principalLabel(before)}的「${roleLabel(before.role)}」角色`
    case 'page_restriction_set': return '全量更新了页面访问限制'
    case 'page_restriction_add': return `将${principalLabel(after)}加入了${restrictionLabel(after.kind)}`
    case 'page_restriction_remove': return `将${principalLabel(before)}移出了${restrictionLabel(before.kind)}`
    case 'page_share_create': return after.expiresAt == null ? '创建了永久公开链接' : '创建了限时公开链接'
    case 'page_share_revoke': return '撤销了公开链接'
    case 'space_deleted': return `删除了空间「${displayValue(before.name)}」`
    case 'group_deleted': return `删除了用户组「${displayValue(before.name)}」`
    case 'user_anonymized': return `注销了用户「${displayValue(before.name)}」`
  }
}

function collectionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length
  const record = asRecord(value)
  return Object.values(record).reduce<number>(
    (sum, item) => sum + (Array.isArray(item) ? item.length : 0),
    0,
  )
}

function auditDetails(entry: AuditEntry): DetailRow[] {
  const payload = asRecord(entry.payload)
  const before = asRecord(payload.before)
  const after = asRecord(payload.after)
  switch (entry.kind) {
    case 'space_grant_set':
    case 'page_restriction_set':
      return [{ label: '条目数量', before: String(collectionCount(before)), after: String(collectionCount(after)) }]
    case 'space_grant_add':
      return [
        { label: '授权对象', value: principalLabel(after) },
        { label: '空间角色', value: roleLabel(after.role) },
      ]
    case 'space_grant_remove':
      return [
        { label: '授权对象', value: principalLabel(before) },
        { label: '原空间角色', value: roleLabel(before.role) },
      ]
    case 'page_restriction_add':
      return [
        { label: '限制对象', value: principalLabel(after) },
        { label: '限制类型', value: restrictionLabel(after.kind) },
      ]
    case 'page_restriction_remove':
      return [
        { label: '限制对象', value: principalLabel(before) },
        { label: '原限制类型', value: restrictionLabel(before.kind) },
      ]
    case 'page_share_create':
      return [
        { label: '页面 ID', value: displayValue(after.pageId) },
        { label: '到期时间', value: after.expiresAt == null ? '永不过期' : displayValue(after.expiresAt) },
      ]
    case 'page_share_revoke':
      return [
        { label: '页面 ID', value: displayValue(before.pageId) },
        { label: '创建时间', value: displayValue(before.createdAt) },
      ]
    case 'space_deleted':
      return [{ label: '空间类型', value: before.kind === 'shared' ? '团队空间' : displayValue(before.kind) }]
    case 'group_deleted':
      return []
    case 'user_anonymized':
      return [
        { label: '姓名', before: displayValue(before.name), after: displayValue(after.name) },
        { label: '邮箱', before: displayValue(before.email), after: displayValue(after.email) },
        { label: '状态', before: displayValue(before.status), after: displayValue(after.status) },
      ]
  }
}

function formatPayload(p: unknown): string {
  if (p == null) return '(无 diff)'
  try {
    const s = JSON.stringify(p, null, 2)
    if (s.length > 2000) return s.slice(0, 2000) + '\n…(已截断)'
    return s
  } catch {
    return String(p)
  }
}
</script>

<template>
  <div class="audit-view">
    <header class="page-head">
      <h1>审计日志</h1>
      <p class="muted">权限变更与资源生命周期的完整历史(append-only)。仅管理员可见。</p>
    </header>

    <!-- Toolbar -->
    <div class="toolbar card">
      <div class="filter-group">
        <label class="filter-label">目标类型</label>
        <select v-model="filterTargetKind" class="select" @change="onTargetKindChange">
          <option v-for="o in TARGET_KIND_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">事件类型</label>
        <select v-model="filterKind" class="select" @change="onKindChange">
          <option v-for="o in visibleKindOptions" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
      </div>
      <div class="filter-group grow">
        <label class="filter-label">搜索(targetId 精确)</label>
        <input
          v-model="filterText"
          class="input"
          type="text"
          placeholder="暂未启用 — 留作 v2(actor 名字 / targetId 模糊)"
          disabled
        />
      </div>
      <button class="btn ghost" :disabled="loading" @click="refresh">
        <span class="material-symbols-outlined">refresh</span>
        刷新
      </button>
    </div>

    <!-- Body -->
    <div v-if="error" class="card error-card">
      <span class="material-symbols-outlined">error</span>
      <span>{{ error }}</span>
    </div>

    <div v-else-if="!loading && entries.length === 0">
      <EmptyState
        icon="history"
        title="还没有审计记录"
        :hint="filterKind || filterTargetKind ? '当前过滤条件下没有匹配项' : 'Phase C 上线后第一次权限变更会产生第一条记录'"
      />
    </div>

    <div v-else class="card list-card">
      <div v-if="loading" class="loading-overlay">
        <span class="material-symbols-outlined spinning">progress_activity</span>
        加载中…
      </div>

      <ul class="audit-list">
        <li
          v-for="e in entries"
          :key="e.id"
          class="audit-item"
          :class="{ 'is-open': expandedEntryId === e.id }"
        >
          <button
            type="button"
            class="audit-row"
            :aria-expanded="expandedEntryId === e.id"
            @click="toggleRow(e.id)"
          >
            <UserAvatar
              class="row-avatar"
              :size="28"
              :label="e.actorName ?? '?'"
              :color="e.actorColor ?? ''"
              :avatar-kind="e.actorAvatarKind ?? null"
              :avatar-ref="e.actorAvatarRef ?? null"
              :user-id="e.actorId"
            />
            <span class="actor-name" :title="e.actorName ?? e.actorId">
              {{ e.actorName ?? e.actorId }}
            </span>
            <span class="audit-summary" :title="auditSummary(e)">
              {{ auditSummary(e) }}
            </span>
            <time
              class="row-time"
              :datetime="new Date(e.createdAt).toISOString()"
              :title="new Date(e.createdAt).toLocaleString()"
            >
              {{ formatRelativeTime(e.createdAt) }}
            </time>
            <span
              class="row-arrow material-symbols-outlined"
              :class="{ 'is-open': expandedEntryId === e.id }"
            >expand_more</span>
          </button>

          <!-- 展开区:目标 + 字段变化 + 原始 JSON 二级入口 -->
          <div v-if="expandedEntryId === e.id" class="audit-expand">
            <div class="expand-inner">
              <div class="expand-target">
                <span class="target-chip">
                  <span class="material-symbols-outlined target-icon">
                    {{ targetIcon(e.targetKind) }}
                  </span>
                  {{ targetLabel(e) }}
                </span>
                <span class="target-id" :title="e.targetId">{{ e.targetId }}</span>
              </div>

              <div v-if="auditDetails(e).length > 0" class="detail-rows">
                <div v-for="row in auditDetails(e)" :key="row.label" class="detail-row">
                  <span class="detail-label">{{ row.label }}</span>
                  <template v-if="row.before !== undefined || row.after !== undefined">
                    <span class="detail-before" :title="row.before">{{ row.before ?? '—' }}</span>
                    <span class="material-symbols-outlined detail-arrow">arrow_forward</span>
                    <span class="detail-after" :title="row.after">{{ row.after ?? '—' }}</span>
                  </template>
                  <span v-else class="detail-value" :title="row.value">{{ row.value }}</span>
                </div>
              </div>

              <button
                type="button"
                class="raw-toggle"
                :class="{ 'is-open': rawOpenId === e.id }"
                @click="toggleRaw(e.id)"
              >
                <span class="material-symbols-outlined">data_object</span>
                {{ rawOpenId === e.id ? '隐藏原始 JSON' : '查看原始 JSON' }}
              </button>

              <pre v-if="rawOpenId === e.id" class="payload-block">{{ formatPayload(e.payload) }}</pre>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <!-- Pagination -->
    <div v-if="!loading && entries.length > 0" class="pager">
      <button
        class="btn ghost"
        :disabled="currentPage <= 1"
        @click="goPage(currentPage - 1)"
      >
        <span class="material-symbols-outlined">chevron_left</span>
        上一页
      </button>
      <span class="pager-info">
        第 {{ currentPage }} / {{ totalPages }} 页 · 共 {{ total }} 条
      </span>
      <button
        class="btn ghost"
        :disabled="currentPage >= totalPages"
        @click="goPage(currentPage + 1)"
      >
        下一页
        <span class="material-symbols-outlined">chevron_right</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.audit-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* max-width: 1680 + margin auto 对齐 .content-inner(components.css:485)
     —— 2K 屏下表格列宽自然撑开,小屏也不强行居中挤压。 */
  max-width: 1680px;
  margin: 0 auto;
  width: 100%;
}

.page-head h1 {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
}

.page-head .muted {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
}

.card {
  background: var(--bg-card, #fff);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  padding: 16px 20px;
}

.toolbar {
  display: flex;
  align-items: end;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 20px;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 160px;
}

.filter-group.grow {
  flex: 1;
  min-width: 220px;
}

.filter-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.select,
.input {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg-canvas);
  color: var(--text-1);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.select:focus,
.input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.input:disabled {
  color: var(--text-3);
  background: var(--bg-subtle);
  cursor: not-allowed;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg-card, #fff);
  color: var(--text-1);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--duration-fast) var(--ease-out);
}

.btn:hover:not(:disabled) {
  background: var(--bg-canvas);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn .material-symbols-outlined {
  font-size: 18px;
}

.btn.ghost {
  background: transparent;
  border-color: var(--border);
}

.error-card {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--danger, #d6443c);
  background: var(--danger-soft, #fdeceb);
  border-color: var(--danger-soft, #fdeceb);
}

.list-card {
  position: relative;
  padding: 0;
  overflow: hidden;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.7);
  color: var(--text-2);
  font-size: 13px;
  z-index: 2;
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ─── 单行活动流 ────────────────────────────────────────────────── */

.audit-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.audit-item {
  border-bottom: 1px solid var(--border);
}
.audit-item:last-child {
  border-bottom: none;
}
.audit-item.is-open {
  background: var(--bg-subtle);
}

.audit-row {
  width: 100%;
  display: grid;
  /* 32px avatar | actor + summary 自适应 | 时间右对齐 | 20px chevron */
  grid-template-columns: 32px auto minmax(0, 1fr) auto 20px;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out);
}
.audit-row:hover { background: var(--bg-subtle); }
.audit-row:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
  border-radius: var(--radius-sm, 3px);
}
.audit-item.is-open .audit-row {
  background: var(--bg-subtle);
}

.row-avatar {
  flex-shrink: 0;
}

.actor-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
}

.audit-summary {
  font-size: 13px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-time {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.row-arrow {
  font-size: 20px;
  color: var(--text-3);
  transition: transform var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.audit-row:hover .row-arrow,
.row-arrow.is-open {
  color: var(--accent);
}
.row-arrow.is-open {
  transform: rotate(180deg);
}

/* ─── 展开区 ────────────────────────────────────────────────────── */

.audit-expand {
  background: var(--bg-subtle);
  border-top: 1px solid var(--border);
  animation: audit-expand 160ms var(--ease-out);
}

@keyframes audit-expand {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .audit-expand { animation: none; }
  .row-arrow { transition: none; }
}

.expand-inner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 20px 16px 64px;
}

.expand-target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.target-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 10px;
  background: var(--bg-card, #fff);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill, 999px);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.target-icon {
  font-size: 14px;
  color: var(--text-3);
}

.target-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  min-width: 0;
}

.detail-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.detail-row {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.detail-row:has(.detail-arrow) {
  grid-template-columns: 84px minmax(0, 1fr) 16px minmax(0, 1fr);
}

.detail-label {
  color: var(--text-3);
  font-size: 12px;
}

.detail-value,
.detail-before,
.detail-after {
  overflow: hidden;
  color: var(--text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.detail-after {
  color: var(--text-1);
  font-weight: 500;
}

.detail-arrow {
  font-size: 14px;
  color: var(--text-3);
}

/* ─── JSON toggle ───────────────────────────────────────────────── */

.raw-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  background: var(--bg-card, #fff);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}

.raw-toggle:hover,
.raw-toggle.is-open {
  border-color: var(--border);
  background: var(--bg-canvas);
  color: var(--accent);
}

.raw-toggle .material-symbols-outlined {
  font-size: 16px;
}

.payload-block {
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-card, #fff);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 280px;
  overflow: auto;
  color: var(--text-2);
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 8px 0;
}

.pager-info {
  font-size: 13px;
  color: var(--text-2);
  min-width: 200px;
  text-align: center;
}
</style>