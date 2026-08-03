<script setup lang="ts">
/**
 * SpaceInfoTab — 空间元信息 + 主页 + 危险操作(info tab 内容)。
 *
 * 从 SpaceEditView 拆出:之前整个 info tab 都嵌在 2600 行单文件里,
 * 现在薄到只剩 form fields、homepage row、danger zone 三块。
 *
 * 行为:
 *  - 基本信息表单(name / desc / color)由本组件本地管,save 调用对应
 *    API 端点,成功后 emit('updated', newSpace) 通知 shell 同步 ref。
 *  - 主页 picker 也走单独 PATCH(单字段原子操作),同样 emit('updated')。
 *  - 危险操作(归档/恢复/删除)只对 isGlobalAdmin 显示,确认走 useConfirm
 *    composable,删除后 emit('deleted') 让 shell 跳回列表。
 *
 * 不依赖 grants / allUsers / allGroups —— adminUserIds 的展示在 shell
 * header 里,这里只需要 space 本身的元信息。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PickPageDialog from '@/components/layout/PickPageDialog.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useSpacesStore } from '@/stores/spaces'
import { useAuthStore } from '@/stores/auth'
import { api, ApiError } from '@/lib/api'
import { SPACE_COLOR_PALETTE } from '@/lib/colorPalettes'
import type { Space } from '@power-wiki/shared'

const props = defineProps<{
  space: Space
  isGlobalAdmin: boolean
}>()

const emit = defineEmits<{
  (e: 'updated', space: Space): void
  (e: 'deleted'): void
}>()

const router = useRouter()
const uiStore = useUiStore()
const pagesStore = usePagesStore()
const spacesStore = useSpacesStore()
const authStore = useAuthStore()
const { confirm: askConfirm } = useConfirm()

const canEditMetadata = computed(
  () => props.isGlobalAdmin || props.space.viewerRole === 'admin',
)

/* ─── 基本信息 state ─────────────────────────────────────────── */
const editName = ref('')
const editDesc = ref('')
const editColor = ref<string>(SPACE_COLOR_PALETTE[0].value as string)
const saving = ref(false)
const formDirty = ref(false)

function syncFormFromSpace() {
  editName.value = props.space.name
  editDesc.value = props.space.description ?? ''
  editColor.value = props.space.color
  formDirty.value = false
}

// 父 space 变化时(如 shell 拉到了新数据)同步 form,但只在非 dirty 态
// 覆盖 —— 避免覆盖用户未保存的编辑。
watch(
  () => props.space,
  () => {
    if (!formDirty.value) syncFormFromSpace()
  },
  { immediate: true },
)

function markFormDirty() {
  formDirty.value = true
}

async function onSaveForm() {
  if (!formDirty.value || saving.value) return
  saving.value = true
  try {
    const input = {
      name: editName.value.trim(),
      description: editDesc.value.trim() || null,
      color: editColor.value,
    }
    const updated = props.isGlobalAdmin
      ? await api.admin.spaces.update(props.space.id, input)
      : await api.spaces.update(props.space.id, input)
    const merged = { ...props.space, ...updated }
    emit('updated', merged)
    syncFormFromSpace()
    uiStore.notify('空间信息已保存', 'success')
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function onResetForm() {
  syncFormFromSpace()
}

/* ─── 空间主页 state ─────────────────────────────────────────── */
/**
 * Confluence space homepage 同构能力。选一篇本空间内的页面,`/` 路由
 * 自动跳转过去。homepagePageId 是后端字段,事实来源;这里只维护 picker
 * modal 的开/关和 saving 状态。
 *
 * Lazy-fetch:homepagePageId 指向的页面不一定已经载入 pagesStore(用户
 * 可能从主仪表盘或外部链接直接深链到 manager 页面)。光看 store 命中
 * 会误判为「不可访问」并显示删除警告 —— 实际页面存在,只是没被前端
 * 拉过。这里按需 `api.pages.get` 一次拉进 store,失败(404 / 权限)
 * 才真的标 missing。fetchToken 用于在用户快速切换时丢弃过期响应。
 */
const homepagePickerOpen = ref(false)
const homepageSaving = ref(false)

const homepagePage = computed(() => {
  const id = props.space.homepagePageId
  if (!id) return null
  return pagesStore.getPage(id) ?? null
})

type HomepageFetchState = 'idle' | 'loading' | 'loaded' | 'missing'
const homepageFetchState = ref<HomepageFetchState>('idle')
let homepageFetchToken = 0

async function ensureHomepageLoaded(pageId: string): Promise<void> {
  const myToken = ++homepageFetchToken
  homepageFetchState.value = 'loading'
  try {
    const page = await api.pages.get(pageId)
    if (myToken !== homepageFetchToken) return
    pagesStore.syncPageFromServer(page)
    homepageFetchState.value = 'loaded'
  } catch (e) {
    if (myToken !== homepageFetchToken) return
    if (e instanceof ApiError && e.status === 404) {
      homepageFetchState.value = 'missing'
    } else {
      // 权限拒绝 / 5xx 等不确定的情况 —— 保守地当作可见,不再提醒「删除」,
      // 这样既不会吓到用户,也不会显示「加载中…」一直转。
      homepageFetchState.value = 'loaded'
    }
  }
}

watch(
  () => props.space.homepagePageId,
  (id) => {
    if (!id) {
      homepageFetchToken++
      homepageFetchState.value = 'idle'
      return
    }
    if (pagesStore.getPage(id)) {
      homepageFetchToken++
      homepageFetchState.value = 'loaded'
      return
    }
    void ensureHomepageLoaded(id)
  },
  { immediate: true },
)

onUnmounted(() => {
  // 丢掉任何 in-flight 响应,防止 set state on unmounted 警告
  homepageFetchToken++
})

async function onPickHomepage(pageId: string | null): Promise<void> {
  if (pageId === props.space.homepagePageId) {
    homepagePickerOpen.value = false
    return
  }
  homepageSaving.value = true
  try {
    const updated = await api.spaces.update(props.space.id, { homepagePageId: pageId })
    const merged = { ...props.space, ...updated }
    emit('updated', merged)
    spacesStore.upsert(merged)
    homepagePickerOpen.value = false
    uiStore.notify(
      pageId ? '已设置空间主页' : '已清除空间主页',
      'success',
    )
  } catch (e) {
    uiStore.notify(e instanceof ApiError ? e.message : '保存失败', 'error')
  } finally {
    homepageSaving.value = false
  }
}

/* ─── 危险操作(全局 admin only) ─────────────────────────────── */
async function onArchive() {
  const ok = await askConfirm({
    title: '归档空间',
    message: `确定要归档空间「${props.space.name}」吗?归档后该空间将从切换器中隐藏,页面仍可读但禁止新增和编辑。管理员可随时恢复。`,
    confirmText: '归档',
    danger: false,
  })
  if (!ok) return
  try {
    const updated = await api.admin.spaces.archive(props.space.id)
    const merged = { ...props.space, ...updated }
    emit('updated', merged)
    await spacesStore.refresh()
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '归档失败')
  }
}

async function onUnarchive() {
  try {
    const updated = await api.admin.spaces.unarchive(props.space.id)
    const merged = { ...props.space, ...updated }
    emit('updated', merged)
    await spacesStore.refresh()
  } catch (e) {
    uiStore.setError(e instanceof ApiError ? e.message : '恢复失败')
  }
}

async function onDelete() {
  let pageCount: number | null = null
  try {
    pageCount = (await api.admin.spaces.deleteImpact(props.space.id)).pageCount
  } catch {
    pageCount = null
  }
  const ok = await askConfirm({
    title: '删除空间',
    message: `确定要删除空间「${props.space.name}」吗?该操作不可撤销。`,
    details: [
      pageCount === null
        ? '空间必须为空(没有页面)才能删除。'
        : pageCount > 0
        ? `当前空间还有 ${pageCount} 个页面,请先删除或移动。`
        : '当前空间没有未删除页面。',
    ],
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.admin.spaces.delete(props.space.id)
    void pagesStore.refresh()
    emit('deleted')
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.code === 'space_not_empty') {
      const body = e.body as { pageCount?: number } | null
      uiStore.setError(`该空间下还有 ${body?.pageCount ?? ''} 个页面,请先删除或移动这些页面`)
    } else {
      uiStore.setError(e instanceof ApiError ? e.message : '删除失败')
    }
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short' })
}
</script>

<template>
  <div class="sit-stack">
    <!-- ─── 基本信息 ─── -->
    <section v-if="canEditMetadata" class="se-card">
      <h2 class="se-card-title">基本信息</h2>
      <div class="se-fields">
        <label class="field field-name">
          <span class="field-label">名称</span>
          <input
            v-model="editName"
            type="text"
            class="field-input"
            :disabled="saving"
            maxlength="64"
            @input="markFormDirty"
          />
        </label>
        <label class="field field-desc">
          <span class="field-label">描述</span>
          <input
            v-model="editDesc"
            type="text"
            class="field-input"
            :disabled="saving"
            maxlength="200"
            placeholder="可选 — 出现在侧边栏空间名下方"
            @input="markFormDirty"
          />
        </label>
        <div class="field field-color">
          <span class="field-label">颜色</span>
          <div class="color-swatches">
            <button
              v-for="c in SPACE_COLOR_PALETTE"
              :key="c.value as string"
              type="button"
              class="cs-swatch"
              :class="{ 'cs-swatch-active': editColor === c.value }"
              :style="{ background: c.value as string }"
              :title="c.name"
              :disabled="saving"
              @click="editColor = c.value!; markFormDirty()"
            >
              <span
                v-if="editColor === c.value"
                class="material-symbols-outlined cs-swatch-check"
                aria-hidden="true"
              >check</span>
            </button>
          </div>
        </div>
      </div>
      <div class="se-card-actions">
        <button type="button" class="btn ghost" :disabled="!formDirty || saving" @click="onResetForm">取消</button>
        <button type="button" class="btn primary" :disabled="!formDirty || saving" @click="onSaveForm">
          <span v-if="saving" class="se-spinner" aria-hidden="true"></span>
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>

      <!-- ─── 危险操作(全局 admin only) ─── -->
      <div v-if="isGlobalAdmin" class="se-danger-zone">
        <div class="se-danger-row se-danger-row-muted">
          <div class="se-danger-text">
            <h3 class="se-danger-title">归档空间</h3>
            <p class="se-danger-desc">
              {{
                space?.archivedAt
                  ? '空间已归档 — 从切换器隐藏,成员仍可读,禁止新增和编辑。'
                  : '归档后从切换器隐藏,页面保留可读,禁止新增和编辑。随时可恢复。'
              }}
            </p>
          </div>
          <button
            v-if="!space?.archivedAt"
            type="button"
            class="btn ghost-secondary"
            @click="onArchive"
          >
            <span class="material-symbols-outlined btn-icon">archive</span>
            <span>归档</span>
          </button>
          <button
            v-if="space?.archivedAt"
            type="button"
            class="btn ghost-secondary"
            @click="onUnarchive"
          >
            <span class="material-symbols-outlined btn-icon">unarchive</span>
            <span>恢复</span>
          </button>
        </div>

        <div class="se-danger-divider" />

        <div class="se-danger-row se-danger-row-destructive">
          <div class="se-danger-text">
            <h3 class="se-danger-title se-danger-title-destructive">
              <span class="material-symbols-outlined se-danger-icon">warning</span>
              删除空间
            </h3>
            <p class="se-danger-desc">
              永久删除此空间及其下所有页面,操作不可撤销。空间必须为空才能删除,否则请先归档。
            </p>
          </div>
          <button type="button" class="btn danger" @click="onDelete">
            <span class="material-symbols-outlined btn-icon">delete</span>
            <span>删除空间</span>
          </button>
        </div>
      </div>
    </section>

    <!-- ─── 空间主页(全局 admin 或 space-admin;仅团队空间) ─── -->
    <section v-if="canEditMetadata && space.kind !== 'personal'" class="se-card">
      <h2 class="se-card-title">空间主页</h2>
      <p class="se-card-desc">
        选一篇本空间内的页面作为主页 —— 所有进入此空间的人会直接看到它(类似 Confluence 的 space homepage)。不设置时,`/` 路由继续渲染系统仪表盘。
      </p>

      <div v-if="homepagePage" class="se-homepage-row">
        <span class="material-symbols-outlined se-homepage-icon">description</span>
        <div class="se-homepage-meta">
          <RouterLink :to="`/p/${homepagePage.id}`" class="se-homepage-title">
            {{ homepagePage.title || '(无标题)' }}
          </RouterLink>
          <span v-if="homepagePage.deletedAt" class="se-homepage-warn">
            <span class="material-symbols-outlined se-homepage-warn-icon">error</span>
            该页面已被移入回收站 —— 团队成员现在无法访问主页,建议更换或恢复。
          </span>
        </div>
      </div>
      <div v-else-if="space.homepagePageId && homepageFetchState === 'loading'" class="se-homepage-row">
        <span class="se-spinner se-spinner-lg" aria-hidden="true"></span>
        <div class="se-homepage-meta">
          <span class="se-homepage-title se-homepage-title--muted">正在加载主页…</span>
        </div>
      </div>
      <div v-else-if="space.homepagePageId && homepageFetchState === 'missing'" class="se-homepage-row se-homepage-row--stale">
        <span class="material-symbols-outlined se-homepage-icon">help</span>
        <div class="se-homepage-meta">
          <span class="se-homepage-title">已配置主页 ID:<code>{{ space.homepagePageId }}</code></span>
          <span class="se-homepage-warn">该页面已不可访问(可能被永久删除),建议清除或更换。</span>
        </div>
      </div>
      <div v-else class="se-homepage-empty">
        <span class="material-symbols-outlined se-homepage-empty-icon">push_pin</span>
        <span class="se-homepage-empty-text">当前未设置主页,`/` 路由展示系统仪表盘。</span>
      </div>

      <div class="se-card-actions">
        <button
          v-if="homepagePage || space.homepagePageId"
          type="button"
          class="btn ghost"
          :disabled="homepageSaving"
          @click="onPickHomepage(null)"
        >
          <span class="material-symbols-outlined btn-icon">delete</span>
          清除主页
        </button>
        <button
          type="button"
          class="btn"
          :disabled="homepageSaving"
          @click="homepagePickerOpen = true"
        >
          <span class="material-symbols-outlined btn-icon">{{ homepagePage || space.homepagePageId ? 'edit' : 'add' }}</span>
          {{ homepagePage || space.homepagePageId ? '更换页面' : '选择页面' }}
        </button>
      </div>
    </section>

    <PickPageDialog
      v-if="homepagePickerOpen && space"
      :space-id="space.id"
      :selected-id="space.homepagePageId ?? null"
      title="选择主页页面"
      @close="homepagePickerOpen = false"
      @select="onPickHomepage"
    />
  </div>
</template>

<style scoped>
.sit-stack { display: flex; flex-direction: column; gap: 12px; }

.se-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  padding: 16px 20px;
}
.se-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 12px 0;
}
.se-fields {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) 2fr;
  column-gap: 16px;
  row-gap: 14px;
}
.field-color { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
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
.se-color-row { display: flex; flex-direction: column; gap: 6px; }
.color-swatches { display: flex; gap: 6px; }
.cs-swatch {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 0;
  cursor: pointer;
  padding: 0;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--duration-fast) var(--ease-out);
}
.cs-swatch:hover:not(:disabled) { transform: scale(1.06); }
.cs-swatch-check {
  font-size: 18px;
  color: white;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
  line-height: 1;
  pointer-events: none;
}
.se-card-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.se-card-actions:has(button:not(:disabled)) {
  border-top-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}
.se-card-desc {
  margin: 0 0 14px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
.se-homepage-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}
.se-homepage-row--stale {
  border-color: var(--warning);
  background: var(--warning-soft);
}
.se-homepage-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--text-2);
  font-size: 22px !important;
}
.se-homepage-title--muted {
  font-weight: 500;
  color: var(--text-2);
}
.se-spinner-lg {
  width: 22px;
  height: 22px;
  border-width: 3px;
  flex-shrink: 0;
  margin-top: 2px;
  margin-right: 0;
  animation: se-spin 0.6s linear infinite;
  color: var(--text-2);
  display: inline-block;
  vertical-align: middle;
  border-style: solid;
  border-color: currentColor;
  border-right-color: transparent;
  border-radius: 50%;
}
.se-homepage-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.se-homepage-title {
  color: var(--text-1);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.se-homepage-title:hover {
  color: var(--accent);
  text-decoration: underline;
}
.se-homepage-title code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background: var(--bg);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
}
.se-homepage-warn {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  margin-top: 2px;
  color: var(--warning);
  font-size: 12px;
  line-height: 1.5;
}
.se-homepage-warn-icon {
  font-size: 16px !important;
  flex-shrink: 0;
  margin-top: 1px;
}
.se-homepage-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 13px;
}
.se-homepage-empty-icon {
  color: var(--text-3);
  font-size: 20px !important;
}
.se-homepage-empty-text { line-height: 1.5; }
.se-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: se-spin 0.6s linear infinite;
  vertical-align: -2px;
  margin-right: 4px;
}
@keyframes se-spin {
  to { transform: rotate(360deg); }
}

.se-danger-zone {
  margin-top: 24px;
  padding-top: 0;
  border-top: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.se-danger-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border-radius: var(--radius-md, 4px);
}
.se-danger-row-muted { background: var(--bg-subtle); }
.se-danger-row-destructive {
  background: #fff5f5;
  border: 1px solid #ffcdd2;
  margin-top: 12px;
}
.se-danger-text { flex: 1; min-width: 0; }
.se-danger-text p { margin: 0; }
.se-danger-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0 0 4px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.se-danger-title-destructive { color: var(--danger); }
.se-danger-icon { font-size: 16px !important; color: var(--danger); }
.se-danger-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; }
.se-danger-divider { height: 1px; background: transparent; }
</style>
