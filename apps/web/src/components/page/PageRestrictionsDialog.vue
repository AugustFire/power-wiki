<script setup lang="ts">
/**
 * PageRestrictionsDialog — Phase B 页面级 view / edit 限制编辑弹窗。
 *
 * 语义(Confluence 风格,后端 permissions.ts 实现):
 *   - 查看限制(view):沿父链继承 —— 任一祖先设了 view 限制,子页也被收紧
 *   - 编辑限制(edit):不继承 —— 只作用于本页
 *   - 两个 allow-list 都空 = 无限制(回退到空间角色)
 *
 * 数据流:打开时并行拉 restrictions(当前状态)+ candidates(可选主体)。
 * candidates 走限制路由自带端点(非 admin 页面作者也能用,不依赖
 * admin.users.list)。Save 是 full-replace PUT;清空全部也走 PUT(view:[]+edit:[])。
 */
import { computed, ref, watch } from 'vue'
import Modal from '@/components/ui/Modal.vue'
import { api, ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import type {
  PageRestriction,
  RestrictionCandidateGroup,
  RestrictionCandidateUser,
} from '@power-wiki/shared'

const props = defineProps<{
  open: boolean
  pageId: string
  pageTitle?: string
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  /** Save 成功后回传最新「是否有限制」标记,便于父层更新 chip 而不重拉。 */
  saved: [flags: { hasViewRestriction: boolean; hasEditRestriction: boolean }]
}>()

/** 本地可编辑项 —— 只保留 principalKind + principalId(grantedBy/At 由后端补)。 */
type LocalItem = { principalKind: 'user' | 'group'; principalId: string }

const loading = ref(false)
const loadError = ref<string | null>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)

const viewItems = ref<LocalItem[]>([])
const editItems = ref<LocalItem[]>([])
const original = ref<string>('')

const allUsers = ref<RestrictionCandidateUser[]>([])
const allGroups = ref<RestrictionCandidateGroup[]>([])

// 每个 section 的「添加」popover 开关 + 搜索词
const addOpen = ref<{ view: boolean; edit: boolean }>({ view: false, edit: false })
const addSearch = ref<{ view: string; edit: string }>({ view: '', edit: '' })

function snapshot(): string {
  return JSON.stringify({ view: viewItems.value, edit: editItems.value })
}
const dirty = computed(() => snapshot() !== original.value)

async function load() {
  loading.value = true
  loadError.value = null
  saveError.value = null
  try {
    const [r, cand] = await Promise.all([
      api.pages.restrictions.get(props.pageId),
      api.pages.restrictions.candidates(props.pageId),
    ])
    viewItems.value = r.view.map((x) => ({ principalKind: x.principalKind, principalId: x.principalId }))
    editItems.value = r.edit.map((x) => ({ principalKind: x.principalKind, principalId: x.principalId }))
    allUsers.value = cand.users
    allGroups.value = cand.groups
    original.value = snapshot()
  } catch (e) {
    loadError.value = e instanceof ApiError ? humanizeApiError(e) : '加载失败'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      addOpen.value = { view: false, edit: false }
      addSearch.value = { view: '', edit: '' }
      void load()
    }
  },
)

/* ─── 展示 helpers ─────────────────────────────────────────────────── */

function userNameOf(id: string): string {
  return allUsers.value.find((u) => u.id === id)?.name ?? id
}
function userEmailOf(id: string): string | undefined {
  return allUsers.value.find((u) => u.id === id)?.email
}
function userColorOf(id: string): string {
  return allUsers.value.find((u) => u.id === id)?.color ?? '#888'
}
function groupNameOf(id: string): string {
  return allGroups.value.find((g) => g.id === id)?.name ?? id
}
function groupDescOf(id: string): string | null | undefined {
  return allGroups.value.find((g) => g.id === id)?.description
}

function itemsFor(kind: 'view' | 'edit') {
  return kind === 'view' ? viewItems : editItems
}

/* ─── 候选(排除已选) ─────────────────────────────────────────────── */

function candidateUsers(kind: 'view' | 'edit'): RestrictionCandidateUser[] {
  const q = addSearch.value[kind].trim().toLowerCase()
  const taken = new Set(
    itemsFor(kind).value.filter((i) => i.principalKind === 'user').map((i) => i.principalId),
  )
  let list = allUsers.value.filter((u) => !taken.has(u.id))
  if (q) list = list.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  return list
}
function candidateGroups(kind: 'view' | 'edit'): RestrictionCandidateGroup[] {
  const q = addSearch.value[kind].trim().toLowerCase()
  const taken = new Set(
    itemsFor(kind).value.filter((i) => i.principalKind === 'group').map((i) => i.principalId),
  )
  let list = allGroups.value.filter((g) => !taken.has(g.id))
  if (q) list = list.filter((g) => g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q))
  return list
}

/* ─── 增删 ─────────────────────────────────────────────────────────── */

function addUser(kind: 'view' | 'edit', userId: string) {
  const ref_ = itemsFor(kind)
  ref_.value = [...ref_.value, { principalKind: 'user', principalId: userId }]
}
function addGroup(kind: 'view' | 'edit', groupId: string) {
  const ref_ = itemsFor(kind)
  ref_.value = [...ref_.value, { principalKind: 'group', principalId: groupId }]
}
function removeItem(kind: 'view' | 'edit', idx: number) {
  const ref_ = itemsFor(kind)
  ref_.value = ref_.value.filter((_, i) => i !== idx)
}

/* ─── Save / Cancel ────────────────────────────────────────────────── */

async function onSave() {
  if (!dirty.value || saving.value) return
  saving.value = true
  saveError.value = null
  try {
    const toDto = (items: LocalItem[]): PageRestriction[] =>
      items.map((i) => ({
        principalKind: i.principalKind,
        principalId: i.principalId,
        grantedBy: null,
        grantedAt: 0,
      }))
    const updated = await api.pages.restrictions.set(props.pageId, {
      view: toDto(viewItems.value),
      edit: toDto(editItems.value),
    })
    viewItems.value = updated.view.map((x) => ({ principalKind: x.principalKind, principalId: x.principalId }))
    editItems.value = updated.edit.map((x) => ({ principalKind: x.principalKind, principalId: x.principalId }))
    original.value = snapshot()
    emit('saved', {
      hasViewRestriction: updated.view.length > 0,
      hasEditRestriction: updated.edit.length > 0,
    })
    emit('update:open', false)
  } catch (e) {
    saveError.value = e instanceof ApiError ? humanizeApiError(e) : '保存失败'
  } finally {
    saving.value = false
  }
}

function onClose() {
  emit('update:open', false)
}
</script>

<template>
  <Modal
    :open="open"
    :title="pageTitle ? `限制: ${pageTitle}` : '页面限制'"
    size="lg"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="loadError" class="pr-error">{{ loadError }}</div>

    <template v-else-if="loading">
      <div class="pr-skeleton">加载中…</div>
    </template>

    <template v-else>
      <p class="pr-intro">
        设置后,只有下方列出的用户 / 用户组才能查看或编辑本页。<strong>查看限制</strong>会沿父页向下继承,
        <strong>编辑限制</strong>只作用于本页。页面作者与管理员始终不受限制。
      </p>

      <!-- 两个 section:view / edit -->
      <section
        v-for="kind in (['view', 'edit'] as const)"
        :key="kind"
        class="pr-section"
      >
        <header class="pr-sec-head">
          <span class="material-symbols-outlined pr-sec-icon">
            {{ kind === 'view' ? 'visibility' : 'edit' }}
          </span>
          <div>
            <h3 class="pr-sec-title">{{ kind === 'view' ? '查看限制' : '编辑限制' }}</h3>
            <p class="pr-sec-hint">
              {{ kind === 'view'
                ? '限制谁能查看本页及其子页(继承)。留空表示沿用空间的可见性。'
                : '限制谁能编辑本页(不继承)。留空表示空间内的编辑者都能改。' }}
            </p>
          </div>
        </header>

        <ul v-if="itemsFor(kind).value.length > 0" class="pr-list">
          <li v-for="(it, idx) in itemsFor(kind).value" :key="it.principalKind + it.principalId" class="pr-row">
            <template v-if="it.principalKind === 'user'">
              <span class="pr-avatar" :style="{ background: userColorOf(it.principalId) }" aria-hidden="true">
                {{ (userNameOf(it.principalId) || '?').slice(0, 2) }}
              </span>
              <div class="pr-row-text">
                <div class="pr-row-name">{{ userNameOf(it.principalId) }}</div>
                <div v-if="userEmailOf(it.principalId)" class="pr-row-desc">{{ userEmailOf(it.principalId) }}</div>
              </div>
            </template>
            <template v-else>
              <span class="material-symbols-outlined pr-row-icon">workspaces</span>
              <div class="pr-row-text">
                <div class="pr-row-name">{{ groupNameOf(it.principalId) }}</div>
                <div v-if="groupDescOf(it.principalId)" class="pr-row-desc">{{ groupDescOf(it.principalId) }}</div>
              </div>
            </template>
            <button type="button" class="pr-remove" title="移除" @click="removeItem(kind, idx)">
              <span class="material-symbols-outlined">close</span>
            </button>
          </li>
        </ul>
        <div v-else class="pr-empty">未设置{{ kind === 'view' ? '查看' : '编辑' }}限制(所有可访问者)</div>

        <div class="pr-add">
          <button
            v-if="!addOpen[kind]"
            type="button"
            class="btn ghost pr-add-btn"
            @click="addOpen[kind] = true"
          >
            <span class="material-symbols-outlined pr-add-icon">add</span>
            <span>添加用户 / 用户组</span>
          </button>
          <div v-else class="pr-popover">
            <div class="pr-popover-search">
              <span class="material-symbols-outlined pr-search-icon">search</span>
              <input
                v-model="addSearch[kind]"
                type="text"
                class="pr-search"
                placeholder="搜索用户或用户组"
              />
            </div>
            <div class="pr-cand-scroll">
              <template v-if="candidateGroups(kind).length > 0">
                <div class="pr-cand-group">用户组</div>
                <button
                  v-for="g in candidateGroups(kind).slice(0, 30)"
                  :key="'g-' + g.id"
                  type="button"
                  class="pr-candidate"
                  @click="addGroup(kind, g.id)"
                >
                  <span class="material-symbols-outlined pr-row-icon">workspaces</span>
                  <div>
                    <div class="pr-row-name">{{ g.name }}</div>
                    <div v-if="g.description" class="pr-row-desc">{{ g.description }}</div>
                  </div>
                </button>
              </template>
              <template v-if="candidateUsers(kind).length > 0">
                <div class="pr-cand-group">用户</div>
                <button
                  v-for="u in candidateUsers(kind).slice(0, 30)"
                  :key="'u-' + u.id"
                  type="button"
                  class="pr-candidate"
                  @click="addUser(kind, u.id)"
                >
                  <span class="pr-avatar" :style="{ background: u.color }" aria-hidden="true">
                    {{ u.name.slice(0, 2) }}
                  </span>
                  <div>
                    <div class="pr-row-name">{{ u.name }}</div>
                    <div class="pr-row-desc">{{ u.email }}</div>
                  </div>
                </button>
              </template>
              <div v-if="candidateGroups(kind).length === 0 && candidateUsers(kind).length === 0" class="pr-empty">
                没有可添加的对象
              </div>
            </div>
            <div class="pr-popover-actions">
              <button type="button" class="btn ghost" @click="addOpen[kind] = false; addSearch[kind] = ''">
                完成
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>

    <template #footer>
      <span v-if="saveError" class="pr-save-err">{{ saveError }}</span>
      <button type="button" class="btn ghost" :disabled="saving" @click="onClose">取消</button>
      <button type="button" class="btn primary" :disabled="saving || !dirty" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.pr-error { padding: 24px; text-align: center; color: var(--danger); font-size: 14px; }
.pr-skeleton { padding: 32px; text-align: center; color: var(--text-3); font-size: 13px; }

.pr-intro {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  margin: 0 0 20px 0;
  padding: 12px 14px;
  background: var(--bg-canvas);
  border-radius: var(--radius-md, 4px);
}
.pr-intro strong { color: var(--text-1); font-weight: 600; }

.pr-section { margin-bottom: 24px; }
.pr-section:last-child { margin-bottom: 0; }
.pr-sec-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.pr-sec-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; }
.pr-sec-title { font-size: 14px; font-weight: 600; color: var(--text-1); margin: 0; }
.pr-sec-hint { font-size: 12px; color: var(--text-3); margin: 2px 0 0 0; line-height: 1.5; }

.pr-list {
  list-style: none; margin: 0 0 10px 0; padding: 0;
  border: 1px solid var(--border); border-radius: var(--radius-md, 4px);
  overflow: hidden;
}
.pr-row {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg);
}
.pr-row:last-child { border-bottom: 0; }
.pr-row:hover { background: var(--bg-canvas); }
.pr-row-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; }
.pr-row-text { min-width: 0; flex: 1; }
.pr-row-name { font-size: 14px; font-weight: 500; color: var(--text-1); }
.pr-row-desc { font-size: 12px; color: var(--text-3); margin-top: 1px; }

.pr-avatar {
  width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; font-size: 11px; text-transform: uppercase;
}

.pr-remove {
  background: transparent; border: 0; cursor: pointer; padding: 4px; border-radius: 50%;
  color: var(--text-3); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.pr-remove:hover { color: var(--danger); background: var(--bg-canvas); }
.pr-remove .material-symbols-outlined { font-size: 18px; }

.pr-empty {
  padding: 14px; text-align: center; color: var(--text-3); font-size: 13px;
  border: 1px dashed var(--border); border-radius: var(--radius-md, 4px); margin-bottom: 10px;
}

.pr-add { position: relative; }
.pr-add-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.pr-add-icon { font-size: 18px !important; }

.pr-popover {
  border: 1px solid var(--border); border-radius: var(--radius-md, 4px);
  background: var(--bg); padding: 12px; box-shadow: var(--shadow-sm, 0 2px 8px rgba(0,0,0,.06));
}
.pr-popover-search { position: relative; margin-bottom: 8px; }
.pr-search-icon {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  font-size: 18px; color: var(--text-3); pointer-events: none;
}
.pr-search {
  width: 100%; height: 34px; padding: 0 12px 0 36px; font-size: 14px;
  font-family: var(--font-sans, inherit); color: var(--text-1);
  background: var(--bg-canvas); border: 2px solid transparent; border-radius: var(--radius-md, 4px);
  outline: none; box-sizing: border-box;
}
.pr-search:focus { background: var(--bg); border-color: var(--accent); }

.pr-cand-scroll { max-height: 240px; overflow-y: auto; }
.pr-cand-group {
  font-size: 11px; font-weight: 600; color: var(--text-3); text-transform: uppercase;
  letter-spacing: 0.4px; padding: 8px 10px 4px;
}
.pr-candidate {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px;
  background: transparent; border: 0; border-radius: var(--radius-md, 4px);
  cursor: pointer; text-align: left;
}
.pr-candidate:hover { background: var(--bg-canvas); }
.pr-popover-actions { display: flex; justify-content: flex-end; margin-top: 8px; }

.pr-save-err { color: var(--danger); font-size: 13px; margin-right: auto; align-self: center; }
</style>
