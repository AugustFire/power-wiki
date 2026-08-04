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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Modal from '@/components/ui/Modal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { api, ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import { formatRelativeTime, formatRelativeTimeFuture } from '@/lib/relativeTime'
import { useToast } from '@/composables/useToast'
import { usePagesStore } from '@/stores/pages'
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
const pagesStore = usePagesStore()

const expiryChoice = ref<ExpiryOption>(30)

/** 最近一次创建的结果,展示「一次性明文 + 复制 URL」banner。 */
const justCreated = ref<CreateShareResponse | null>(null)
const justCreatedCopied = ref(false)
/** 行级「复制 URL」反馈:P2/4.6 — 替代 toast.success('已复制公开链接')。
 *  inline banner 挂在 share list 上方,3s 自动消失,有手动关闭按钮,
 *  附「复制链接」+「撤销分享」按钮。点击 banner 按钮直接复用 row 的
 *  copy / revoke 流程(revoke 成功后 banner 自动消失)。*/
const copyFeedback = ref<ShareRow | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null
let feedbackTimer: ReturnType<typeof setTimeout> | null = null

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
onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
  if (feedbackTimer) clearTimeout(feedbackTimer)
})
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      justCreated.value = null
      justCreatedCopied.value = false
      copyFeedback.value = null
      createError.value = null
      void load()
    } else if (copyTimer) {
      clearTimeout(copyTimer)
      copyTimer = null
    }
    if (!isOpen && feedbackTimer) {
      clearTimeout(feedbackTimer)
      feedbackTimer = null
    }
  },
)

const activeShares = computed(() => shares.value.filter((s) => s.revokedAt === null))
const revokedShares = computed(() => shares.value.filter((s) => s.revokedAt !== null))

/**
 * D-2 (2026-08-03):行级「复制 URL」按钮的可行性 —— 该 share 是否还有
 * 缓存的明文 token 可用。D-1 在 create 时把 token 落到 pagesStore,
 * 切页 / 刷新后仍存活。share 被 revoke / expire 后,invalidateShareTokens
 * 让缓存跟 active 状态严格 1:1,所以这里直接查 store 即可。
 */
function cachedTokenFor(s: ShareRow): string | undefined {
  return pagesStore.shareTokens[props.pageId]?.[s.id]
}

/** 「复制 URL」反馈 —— P2/4.6:缓存命中走 inline banner(替代旧 toast),
 *  「不可恢复」仍走 toast,因为它有教育价值(解释 token 一次性 + 下一步)。
 *  inline banner 上挂「再复制一次」+「撤销分享」按钮,免去滚回列表的来回。*/
async function onCopyShareUrl(s: ShareRow): Promise<void> {
  const token = cachedTokenFor(s)
  if (token && s.revokedAt === null && (s.expiresAt === null || s.expiresAt > Date.now())) {
    const url = `${window.location.origin}/#/public/pages/${token}`
    let ok = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        ok = true
      } else {
        throw new Error('clipboard api unavailable')
      }
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        ok = false
      }
    }
    if (ok) {
      showCopyFeedback(s)
    } else {
      toast.error('复制失败,请手动复制')
    }
    return
  }
  // 没缓存 token(创建后从未在本会话复制 / 已被 revoke / 已 expire):
  // 直说 URL 不可恢复,给出下一步建议。owner 可能以为是 UI bug,这条 toast
  // 把它转成「预期行为 + 解决方案」,跟 Confluence 的 share 列表 UX 一致。
  toast.info(
    `此分享的链接无法恢复(token 仅创建时展示一次)。如需重新分发,请撤销后创建新的分享链接。`,
  )
}

function showCopyFeedback(s: ShareRow): void {
  copyFeedback.value = s
  if (feedbackTimer) clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => {
    copyFeedback.value = null
    feedbackTimer = null
  }, 3000)
}

function dismissCopyFeedback(): void {
  copyFeedback.value = null
  if (feedbackTimer) {
    clearTimeout(feedbackTimer)
    feedbackTimer = null
  }
}

async function onCreate() {
  if (creating.value) return
  creating.value = true
  createError.value = null
  try {
    const expiresInDays = expiryChoice.value === 'never' ? null : expiryChoice.value
    const resp = await api.pages.shares.create(props.pageId, { expiresInDays })
    justCreated.value = resp
    justCreatedCopied.value = false
    // D-1 (2026-08-03):把明文 token 缓存到 store,让 ReadView 顶栏「复制链
    // 接」按 pageId 查到 → 复制公开 URL 而不是内部 URL。缓存命中与否不影响
    // banner 的 1.2s 自动收起;ShareDialog 自己不依赖这个 token。
    pagesStore.cacheShareToken(props.pageId, resp.id, resp.token)
    // P2/4.6 — banner 3s 自动消失(从创建时起算,不依赖是否点过复制)。
    // 旧实现只在 copyUrl() 启动定时器 → 用户不复制就常驻,违反 spec。
    startJustCreatedTimer()
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
    // D-1 (2026-08-03):撤销后该 share 变非 active,缓存的 token 让
    // firstActiveShareToken 自然跳过(它会再查 list 过滤 active 状态),
    // 但同 page 下其它 active share 的 token 也连带失去可达入口
    // —— invalidate 整页缓存让缓存语义跟 active 列表严格 1:1。
    pagesStore.invalidateShareTokens(props.pageId)
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
    // P2/4.6:复制成功 → 视觉反馈「已复制」+ 重置 3s 自动消失计时。
    // 这样用户复制完后还有完整 3s 看清反馈 / 决定是否撤销;旧的 1.2s
    // 太短,看完一眼就消失,用户来不及反应。
    justCreatedCopied.value = true
    startJustCreatedTimer()
  } else {
    toast.error('复制失败,请手动选中链接复制')
  }
}

/** P2/4.6 — 启动 / 重置 justCreated banner 的 3s 自动消失定时器。
 * onCreate 调一次(从出现开始 3s 必消失),copyUrl 调一次(用户复制后
 * 还想有时间决定要不要撤销,把 3s 窗口从复制瞬间重新算起)。 */
function startJustCreatedTimer(): void {
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    justCreated.value = null
    justCreatedCopied.value = false
    copyTimer = null
  }, 3000)
}

function dismissJustCreated(): void {
  justCreated.value = null
  justCreatedCopied.value = false
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
}

async function revokeJustCreated(): Promise<void> {
  if (!justCreated.value || revokingId.value) return
  // onCreate() 后调过 load(),shares 列表已经包含刚创建的 row —
  // 这里查 ShareRow 而不是用 justCreated 拼,避免字段缺失。
  const row = shares.value.find((s) => s.id === justCreated.value!.id)
  if (!row) {
    // 理论上不会发生(load 已跑过);保护一下,撤销按钮 graceful no-op。
    justCreated.value = null
    justCreatedCopied.value = false
    return
  }
  await onRevoke(row)
  // 撤销成功后 banner 已经在 onRevoke 内被 load() 刷新,justCreated 仍
  // 指向旧值 —— 显式清掉避免残留 input 显示已撤销 share 的 URL。
  justCreated.value = null
  justCreatedCopied.value = false
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
/** 过期列:future → 「N 天后过期」;已过期 → 绝对日期(muted,跟 pill 状态互补);
 *  永不(已撤销 / 已过期但又想看时间轴)→ 落到 status pill 之外的安静显示。 */
function expiresLabel(s: ShareRow): string {
  if (s.expiresAt === null) return ''
  if (s.expiresAt <= Date.now()) {
    return new Date(s.expiresAt).toLocaleDateString('zh-CN')
  }
  return formatRelativeTimeFuture(s.expiresAt) + '后过期'
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

      <!-- P2/4.6 — 一次性明文 banner(创建成功)。3s 自动消失,挂「复制链
           接」+「撤销分享」两个按钮,免去滚回列表操作的来回。手动 × 关
           闭 = 立即清掉(banner 上的 URL 是一次性敏感信息,不留冗余)。-->
      <div v-if="justCreated" class="just-created">
        <button
          type="button"
          class="banner-close"
          aria-label="关闭提示"
          @click="dismissJustCreated"
        >
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
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
            {{ justCreatedCopied ? '已复制' : '复制链接' }}
          </button>
        </div>
        <div class="jc-meta">
          过期:{{ justCreated.expiresAt ? new Date(justCreated.expiresAt).toLocaleString() : '永不过期' }}
        </div>
        <div class="banner-actions">
          <button
            class="btn ghost danger-text"
            type="button"
            :disabled="revokingId !== null"
            @click="revokeJustCreated"
          >
            <span class="material-symbols-outlined">link_off</span>
            撤销分享
          </button>
        </div>
      </div>

      <!-- P2/4.6 — 行级「复制 URL」成功反馈 inline banner。3s 自动消失,
           有「复制链接」+「撤销分享」按钮 + 手动 × 关闭。
           替代旧的 toast.success('已复制公开链接')。-->
      <div v-if="copyFeedback" class="copy-feedback">
        <button
          type="button"
          class="banner-close"
          aria-label="关闭提示"
          @click="dismissCopyFeedback"
        >
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
        <div class="cf-icon">
          <span class="material-symbols-outlined">check_circle</span>
        </div>
        <div class="cf-text">
          公开链接已复制到剪贴板
          <span v-if="copyFeedback.expiresAt" class="cf-meta">
            · {{ expiresLabel(copyFeedback) }}
          </span>
        </div>
        <div class="banner-actions">
          <button
            class="btn ghost"
            type="button"
            @click="onCopyShareUrl(copyFeedback)"
          >
            <span class="material-symbols-outlined">content_copy</span>
            复制链接
          </button>
          <button
            class="btn ghost danger-text"
            type="button"
            :disabled="revokingId !== null"
            @click="onRevoke(copyFeedback)"
          >
            <span class="material-symbols-outlined">link_off</span>
            撤销分享
          </button>
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
              <th>标识</th>
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
                  {{ expiresLabel(s) }}
                </span>
                <span v-else class="muted">永不过期</span>
              </td>
              <!-- D-2 (2026-08-03):tokenPrefix 列 —— sha256 前 8 位作为非敏感
                   行级标识,owner 凭印象「我记得是 …a3b9 那个」定位哪条。
                   用等宽字体 + muted 色,跟「过期」/「撤销」同视觉权重。 -->
              <td>
                <code class="token-prefix" :title="`分享链接标识:${s.tokenPrefix}`">…{{ s.tokenPrefix }}</code>
              </td>
              <td class="actions">
                <!-- 行级「复制 URL」:有缓存 token → 复制公开 URL → inline
                     banner;无缓存 → toast 告知 URL 不可恢复。active 才显
                     示,已撤销 / 过期的 share 复制无意义。 -->
                <button
                  v-if="s.revokedAt === null && (s.expiresAt === null || s.expiresAt > Date.now())"
                  class="btn ghost"
                  type="button"
                  :title="cachedTokenFor(s) ? '复制公开链接' : 'URL 已无法恢复,请撤销并重建'"
                  @click="onCopyShareUrl(s)"
                >
                  <span class="material-symbols-outlined">link</span>
                  复制 URL
                </button>
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

/* D-2 (2026-08-03):tokenPrefix 列 —— 等宽字体 + muted 色,跟前缀的
   「非敏感标识」语义对齐;hover 时整行 cursor 给默认 + tooltip 显示
   完整标识(slice 后的 8 位)。 */
.token-prefix {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
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
  position: relative;
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
  color: var(--text-invert);
}

/* P2/4.6 — banner 关闭按钮 + banner 底部 action 区:
   两个 banner(just-created + copy-feedback)共用同一组 affordance —
   右上角 × 关闭,底部「复制链接 / 撤销分享」row。
   just-created 的 URL 是一次性敏感信息,允许用户立刻 × 关掉;copy-feedback
   没有敏感信息,但 × 关掉能让用户提前清屏。 */
.banner-close {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: 0;
  padding: 4px;
  border-radius: 3px;
  cursor: pointer;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.banner-close:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.banner-close .material-symbols-outlined {
  font-size: 16px;
}

.banner-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.banner-actions .btn {
  font-size: 12px;
  height: 28px;
  padding: 0 10px;
}

/* P2/4.6 — copy-feedback banner:行级「复制 URL」成功后展示的 inline banner,
   替代 toast.success。3s 自动消失,有手动 × 关闭 + 「再复制一次 / 撤销分享」按钮。
   走 success-soft 配色,跟 just-created 的 warning-soft 区分语义。 */
.copy-feedback {
  position: relative;
  padding: 10px 16px 12px 16px;
  background: var(--success-soft);
  color: var(--success-text);
  border: 1px solid var(--success);
  border-radius: var(--radius);
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
}
.cf-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--success);
}
.cf-icon .material-symbols-outlined {
  font-size: 22px;
}
.cf-text {
  color: var(--text-1);
  font-size: 13px;
  font-weight: 500;
  min-width: 0;
}
.cf-meta {
  margin-left: 6px;
  color: var(--text-3);
  font-weight: 400;
  font-size: 12px;
}
.copy-feedback .banner-actions {
  margin-top: 0;
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
