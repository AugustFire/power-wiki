<script setup lang="ts">
/**
 * ShareDialog — Phase D 公开链接分享弹窗。
 *
 * 模式:
 *   - 「创建新分享」:选 expiresInDays(7d / 30d / 90d / 永不过期)→ POST
 *     → 弹一次性「明文 token + 复制 URL」提示。明文 token **只此一次**,
 *     丢失即失效(再 create 新的 / revoke 旧的)。
 *   - 「现有分享列表」:每行显示创建人 / 创建时间 / 过期 / 撤销状态 / 撤销
 *     按钮。撤销后 share 行还在(append-only 审计 + 历史可查),只是
 *     revokedAt 非 null → GET /public 拒绝。
 *
 * 鉴权:edit-access on page(page 作者 / 空间 admin / global admin / 空间
 * editor)。后端 404 时 dialog 显示「页面不可分享」,与现有 canReadPage
 * 404-not-403 政策一致。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Modal from '@/components/ui/Modal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { api, ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useToast } from '@/composables/useToast'
import type { CreateShareResponse, ShareRow } from '@power-wiki/shared'

const props = defineProps<{
  open: boolean
  pageId: string
  pageTitle?: string
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
}>()

type ExpiryOption = 7 | 30 | 90 | 'never'
const EXPIRY_OPTIONS: { value: ExpiryOption; label: string }[] = [
  { value: 7, label: '7 天后过期' },
  { value: 30, label: '30 天后过期' },
  { value: 90, label: '90 天后过期' },
  { value: 'never', label: '永不过期' },
]

const shares = ref<ShareRow[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const creating = ref(false)
const createError = ref<string | null>(null)
const revokingId = ref<string | null>(null)

const toast = useToast()

const expiryChoice = ref<ExpiryOption>(30)

/** 最近一次创建的结果,展示「一次性明文 + 复制 URL」banner。 */
const justCreated = ref<CreateShareResponse | null>(null)
const justCreatedCopied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

async function load() {
  loading.value = true
  loadError.value = null
  try {
    shares.value = await api.pages.shares.list(props.pageId)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      loadError.value = '该页面不可分享(可能在个人空间,或您没有权限)'
    } else {
      loadError.value = e instanceof ApiError ? humanizeApiError(e) : '加载失败'
    }
    shares.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      justCreated.value = null
      justCreatedCopied.value = false
      createError.value = null
      void load()
    }
  },
)

const activeShares = computed(() => shares.value.filter((s) => s.revokedAt === null))
const revokedShares = computed(() => shares.value.filter((s) => s.revokedAt !== null))

async function onCreate() {
  if (creating.value) return
  creating.value = true
  createError.value = null
  try {
    const expiresInDays = expiryChoice.value === 'never' ? null : expiryChoice.value
    const resp = await api.pages.shares.create(props.pageId, { expiresInDays })
    justCreated.value = resp
    justCreatedCopied.value = false
    // 自动选中文本框方便用户复制
    setTimeout(() => {
      const el = document.getElementById('share-just-created-url') as HTMLInputElement | null
      if (el) el.select()
    }, 50)
    await load()
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      // 可能是 share_forbidden(personal / view-restricted)或 invalid_input
      createError.value = humanizeApiError(e)
    } else {
      createError.value = e instanceof ApiError ? humanizeApiError(e) : '创建失败'
    }
  } finally {
    creating.value = false
  }
}

async function onRevoke(s: ShareRow) {
  if (revokingId.value) return
  // 直接撤销 —— ShareDialog 自身是 Modal,再叠一层 ConfirmDialog 会跟
  // Modal 的 backdrop / z-index / useBodyLock 打架(实测被遮挡)。
  // 撤销是 append-only 操作,被撤销的 share 行仍在列表里展示状态,
  // 不提供 undo 但保留可观测性;误点成本很低。
  revokingId.value = s.id
  try {
    await api.pages.shares.revoke(props.pageId, s.id)
    await load()
    // 成功不弹 toast:列表里 status pill 从「有效」变「已撤销」+ 行尾显示撤销人,
    // 反馈已经够强。再弹 toast 反而打扰。
  } catch (e) {
    toast.error(e instanceof ApiError ? humanizeApiError(e) : '撤销失败')
  } finally {
    revokingId.value = null
  }
}

const fullUrl = computed(() => {
  if (!justCreated.value) return ''
  // PublicPageView 是 /#/public/pages/:token(hash router)
  return `${window.location.origin}/#/public/pages/${justCreated.value.token}`
})

async function copyUrl() {
  if (!fullUrl.value) return
  let copied = false
  // 优先用现代 clipboard API;非 secure context 或权限被拒时降级到
  // textarea + execCommand(老方案,但所有浏览器都吃)。
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(fullUrl.value)
      copied = true
    } else {
      throw new Error('clipboard api unavailable')
    }
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = fullUrl.value
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      copied = document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      copied = false
    }
  }
  if (copied) {
    justCreatedCopied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      justCreatedCopied.value = false
    }, 3000)
  } else {
    toast.error('复制失败,请手动选中链接复制')
  }
}

function statusLabel(s: ShareRow): string {
  if (s.revokedAt !== null) return '已撤销'
  if (s.expiresAt !== null && s.expiresAt <= Date.now()) return '已过期'
  return '有效'
}
function statusKind(s: ShareRow): 'active' | 'expired' | 'revoked' {
  if (s.revokedAt !== null) return 'revoked'
  if (s.expiresAt !== null && s.expiresAt <= Date.now()) return 'expired'
  return 'active'
}
</script>

<template>
  <Modal :open="open" title="分享页面" size="md" @update:open="emit('update:open', $event)">
    <div class="share-dialog">
      <p class="share-intro">
        创建公开链接,任何拿到 URL 的人都能<strong>只读</strong>查看本页面(无需登录)。
        <br />
        仅 <strong>共享空间</strong> 且 <strong>无查看限制</strong> 的页面可分享。
      </p>

      <!-- 一次性明文 banner(创建成功) -->
      <div v-if="justCreated" class="just-created">
        <div class="jc-title">
          <span class="material-symbols-outlined">link</span>
          分享链接已创建
        </div>
        <div class="jc-warn">
          这是明文 token 的<strong>唯一一次</strong>展示 —— 关闭后无法再查看,丢失即失效。
        </div>
        <div class="jc-row">
          <input
            id="share-just-created-url"
            class="jc-url"
            :class="{ copied: justCreatedCopied }"
            type="text"
            readonly
            :value="fullUrl"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button
            class="btn primary"
            :class="{ copied: justCreatedCopied }"
            type="button"
            @click="copyUrl"
          >
            <span class="material-symbols-outlined">{{ justCreatedCopied ? 'check' : 'content_copy' }}</span>
            {{ justCreatedCopied ? '已复制' : '复制' }}
          </button>
        </div>
        <div class="jc-meta">
          过期:{{ justCreated.expiresAt ? new Date(justCreated.expiresAt).toLocaleString() : '永不过期' }}
        </div>
      </div>

      <!-- 创建表单 -->
      <section class="create-section">
        <h3 class="section-title">创建新分享</h3>
        <div class="create-row">
          <label class="select-label" for="share-expiry">过期时间</label>
          <select id="share-expiry" v-model="expiryChoice" class="share-select">
            <option v-for="o in EXPIRY_OPTIONS" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
          <button class="btn primary" type="button" :disabled="creating" @click="onCreate">
            <span class="material-symbols-outlined" v-if="!creating">add_link</span>
            <span class="material-symbols-outlined spinning" v-else>progress_activity</span>
            创建
          </button>
        </div>
        <div v-if="createError" class="error-line">{{ createError }}</div>
      </section>

      <!-- 现有分享列表 -->
      <section class="list-section">
        <h3 class="section-title">
          分享链接
          <span class="count">{{ shares.length }}</span>
        </h3>

        <div v-if="loadError" class="error-line">{{ loadError }}</div>
        <div v-else-if="loading" class="loading">
          <span class="material-symbols-outlined spinning">progress_activity</span>
          加载中…
        </div>
        <EmptyState
          v-else-if="shares.length === 0"
          icon="link_off"
          title="还没有分享链接"
          hint="在上方选一个过期时间,然后点「创建」"
          size="sm"
        />
        <table v-else class="share-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>创建人</th>
              <th>创建时间</th>
              <th>过期</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in shares" :key="s.id">
              <td>
                <span class="status-pill" :class="statusKind(s)">{{ statusLabel(s) }}</span>
              </td>
              <td>{{ s.createdByName ?? s.createdBy }}</td>
              <td :title="new Date(s.createdAt).toLocaleString()">
                {{ formatRelativeTime(s.createdAt) }}
              </td>
              <td>
                <span v-if="s.expiresAt" :title="new Date(s.expiresAt).toLocaleString()">
                  {{ formatRelativeTime(s.expiresAt) }}
                </span>
                <span v-else class="muted">永不过期</span>
              </td>
              <td class="actions">
                <button
                  v-if="s.revokedAt === null"
                  class="btn ghost danger-text"
                  type="button"
                  :disabled="revokingId === s.id"
                  @click="onRevoke(s)"
                >
                  <span class="material-symbols-outlined">link_off</span>
                  撤销
                </button>
                <span v-else class="muted small">
                  撤销人:{{ s.revokedByName ?? s.revokedBy }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </Modal>
</template>

<style scoped>
.share-dialog {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.share-intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}

.share-intro strong {
  color: var(--text-1);
  font-weight: 600;
}

.muted {
  color: var(--text-3);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}

.count {
  display: inline-block;
  padding: 1px 8px;
  background: var(--bg-subtle);
  color: var(--text-3);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
}

/* ── just-created banner ── */
.just-created {
  padding: 14px 16px;
  background: var(--warning-soft);
  color: var(--warning-text);
  border: 1px solid var(--warning);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.jc-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--text-1);
  font-size: 14px;
}

.jc-title .material-symbols-outlined {
  font-size: 18px;
}

.jc-warn {
  font-size: 12px;
  line-height: 1.5;
}

.jc-warn strong {
  color: var(--text-1);
}

.jc-row {
  display: flex;
  gap: 8px;
}

.jc-url {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text-1);
  font-size: 12px;
  font-family: var(--font-mono);
  outline: none;
}

.jc-url:focus {
  border-color: var(--accent);
}

.jc-url.copied {
  border-color: var(--success);
  background: var(--success-soft);
  color: var(--success-text);
}

.btn.copied,
.btn.copied:hover {
  background: var(--success);
  border-color: var(--success);
  color: #fff;
}

/* ── create section ── */
.create-section {
  display: flex;
  flex-direction: column;
}

.create-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.select-label {
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
}

.share-select {
  flex: 1;
  height: 32px;
  padding: 0 28px 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  color: var(--text-1);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M2 4l4 4 4-4' fill='none' stroke='%23725B7B' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.share-select:focus {
  background-color: var(--bg);
  border-color: var(--accent);
}

/* ── list section ── */
.list-section {
  display: flex;
  flex-direction: column;
}

.share-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.share-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-canvas);
}

.share-table th:first-child {
  border-top-left-radius: var(--radius);
}

.share-table th:last-child {
  border-top-right-radius: var(--radius);
}

.share-table td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-1);
  vertical-align: middle;
}

.share-table tbody tr:last-child td {
  border-bottom: none;
}

.share-table tbody tr:hover {
  background: var(--bg-canvas);
}

.actions {
  text-align: right;
}

.status-pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
}

.status-pill.active {
  background: var(--success-soft);
  color: var(--success-text);
}

.status-pill.expired {
  background: var(--warning-soft);
  color: var(--warning-text);
}

.status-pill.revoked {
  background: var(--bg-subtle);
  color: var(--text-3);
}

.small {
  font-size: 12px;
}

.btn.danger-text {
  color: var(--danger);
}

.btn.danger-text:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger-hover);
}

.btn .material-symbols-outlined {
  font-size: 16px;
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-line {
  font-size: 13px;
  color: var(--danger);
  padding: 8px 12px;
  background: var(--danger-soft);
  border-radius: var(--radius);
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 0;
  color: var(--text-3);
  font-size: 13px;
}
</style>
