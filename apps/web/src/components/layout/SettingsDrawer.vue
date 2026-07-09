<script setup lang="ts">
/**
 * SettingsDrawer — P1-6 用户自助修改姓名 / 颜色。
 *
 * 入口:UserMenu 「设置」 → uiStore.openSettings()
 * 渲染于 App.vue 顶层(mounted once at boot),实际门户只受
 * uiStore.settingsDrawerOpen 控制。
 *
 * 为什么不放进 UserMenu:
 *   UserMenu 是个 click-to-toggle 的小 popover,本身体积小。
 *   改名 / 改色需要 form,有 input + 颜色预览 + 保存按钮 + 错误回显 +
 *   “已保存” toast — 塞不进小 popover。
 *   用抽屉保留 Confluence 「Manage account」式的体验。
 *
 * 显示策略:
 *   - 抽屉打开时 GET /api/users/me 拉一次最新数据,保证看的是后端真值
 *     而不是可能过时的 authStore.user(后台 admin 改了你的头像,这里要同步)。
 *   - 表单本地 dirty state;Close / Esc / backdrop 都不污染。
 *   - 保存后 PATCH /api/users/me 返新 User,直接写回 authStore.user →
 *     TopBar 头像、ActivityView actor 名、Sidebar owner 名同步刷新。
 *
 * 颜色 hex 只接受 #RGB / #RRGGBB,跟后端 UpdateUserInputSchema 一致。
 * 提供 8 个 Atlassian 调色板常用色作为快捷,加一个 native color input
 * 让用户挑任一颜色 — native color input 出来的 6 位 hex 直接进 schema。
 *
 * Per CLAUDE.md "不主动 commit / push":changes stay local;user says
 * "提交吧" before any git commit/push.
 */
import { computed, ref, watch } from 'vue'
import Drawer from '@/components/ui/Drawer.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { api, ApiError } from '@/lib/api'
import type { User } from '@power-wiki/shared'

const authStore = useAuthStore()
const uiStore = useUiStore()

/** Picker 改色 — 8 个 Atlassian palette 常用色,加一个 native picker。
 *  hex 必须满足 UpdateUserInputSchema 的 /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/,
 *  否则后端 400。换色时大小写统一用大写,UI 渲染一致。 */
const PALETTE = [
  '#0052CC', // blue
  '#36B37E', // green
  '#FF5630', // red
  '#FF8B00', // orange
  '#6554C0', // purple
  '#00B8D9', // teal
  '#172B4D', // dark
  '#5E6C84', // slate
] as const

const open = computed({
  get: () => uiStore.settingsDrawerOpen,
  set: (v) => (v ? uiStore.openSettings() : uiStore.closeSettings()),
})

const editName = ref('')
const editColor = ref('#0052CC')
const livePreview = ref<User | null>(null)
const loading = ref(false)
const saving = ref(false)
const errorMsg = ref<string | null>(null)

// 修改密码 — 独立 ref + 独立 error(改密失败不能污染 name/color 的
// dirty/save 状态)。ResetPasswordInputSchema 已经在后端做了长度校验
// (8-128),前端只校验「两次输入一致」+ 实时展示规则。
const currentPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const changingPwd = ref(false)
const pwdError = ref<string | null>(null)
const pwdOpen = ref(false)

/** 同步表单到 authStore.user。打开抽屉时调一次,保存成功后也调一次。 */
function syncFormFromUser(u: User | null) {
  if (!u) return
  editName.value = u.name
  editColor.value = u.color.toUpperCase()
  livePreview.value = { ...u, name: editName.value, color: editColor.value }
}

/** 打开时拉一次最新 user,关时重置。watch 比 onMounted+close 容易处理副作用。 */
watch(open, async (isOpen) => {
  if (isOpen) {
    loading.value = true
    errorMsg.value = null
    try {
      const fresh = await api.users.me.get()
      syncFormFromUser(fresh)
      // 后端真值盖掉 authStore(防止 stale)
      authStore.user = fresh
    } catch (e) {
      // 拿不到就用 store 现有的兜底 — 不要因为 meta 失败就让用户开不到抽屉
      errorMsg.value = e instanceof ApiError ? e.message : '加载用户信息失败'
      syncFormFromUser(authStore.user)
    } finally {
      loading.value = false
    }
  } else {
    errorMsg.value = null
    saving.value = false
  }
})

/** Live preview 跟手 — 不打后端,只刷新右上角预览头像 + 文案预览 */
function updatePreviewName(name: string) {
  editName.value = name
  if (livePreview.value) {
    livePreview.value = { ...livePreview.value, name }
  }
}
function updatePreviewColor(color: string) {
  editColor.value = color.toUpperCase()
  if (livePreview.value) {
    livePreview.value = { ...livePreview.value, color: editPreviewColor.value }
  }
}

const editPreviewColor = computed(() => editColor.value)

/** 是否有未保存改动。 */
const dirty = computed(() => {
  const u = authStore.user
  if (!u) return false
  const nameChanged = editName.value.trim() !== u.name
  const colorChanged = editColor.value.toUpperCase() !== u.color.toUpperCase()
  return nameChanged || colorChanged
})

const nameInvalid = computed(
  () => editName.value.trim().length === 0 || editName.value.length > 64,
)

/** 改密表单的就绪态 — 8 字符以上 / 两次输入一致 / 当前密码非空。 */
const pwdReady = computed(
  () =>
    currentPwd.value.length > 0 &&
    newPwd.value.length >= 8 &&
    newPwd.value === confirmPwd.value,
)

async function onChangePassword() {
  if (changingPwd.value || !pwdReady.value) return
  changingPwd.value = true
  pwdError.value = null
  try {
    // 后端 ResetPasswordInputSchema 已经校验 currentPassword 非空 /
    // newPassword 8-128 字符。前端 8 字符 + 两次一致已对得上,但仍走
    // 真实请求,后端是最终事实。
    const r = await api.auth.resetPassword({
      currentPassword: currentPwd.value,
      newPassword: newPwd.value,
    })
    // 后端 status → 'active',会返新 user;同步 authStore 让顶栏 / 其他 view 刷新
    authStore.user = r.user
    // 清空输入 — 敏感字段不留在 DOM
    currentPwd.value = ''
    newPwd.value = ''
    confirmPwd.value = ''
    uiStore.notify('密码已更新')
    pwdOpen.value = false
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      pwdError.value = '当前密码不正确'
    } else if (e instanceof ApiError && e.status === 400) {
      pwdError.value = e.message || '新密码格式不正确'
    } else {
      pwdError.value = e instanceof ApiError ? e.message : '改密失败'
    }
  } finally {
    changingPwd.value = false
  }
}

async function onSave() {
  if (saving.value || !dirty.value || nameInvalid.value) return
  saving.value = true
  errorMsg.value = null
  try {
    const updated = await api.users.me.update({
      name: editName.value.trim(),
      color: editColor.value,
    })
    authStore.user = updated
    syncFormFromUser(updated)
    uiStore.notify('设置已保存')
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      errorMsg.value = '姓名 / 颜色格式不正确'
    } else {
      errorMsg.value = e instanceof ApiError ? e.message : '保存失败'
    }
  } finally {
    saving.value = false
  }
}

function onReset() {
  if (!authStore.user) return
  syncFormFromUser(authStore.user)
  errorMsg.value = null
}
</script>

<template>
  <Drawer v-model:open="open" title="个人设置" :width="420">
    <div class="settings-drawer">
      <p class="lead">
        自助修改姓名和头像色 — 一改即生效,全应用同步刷新(顶栏头像、@mention 自动补全、最近页面活动流的 actor)。
      </p>

      <div v-if="loading" class="loading-state">加载中…</div>

      <div v-else class="settings-body">
        <!-- Live preview 头部 -->
        <div class="preview-block">
          <UserAvatar
            :size="48"
            :label="livePreview?.name ?? authStore.user?.name ?? '?'"
            :color="livePreview?.color ?? authStore.user?.color"
          />
          <div class="preview-meta">
            <div class="preview-name">{{ livePreview?.name ?? '—' }}</div>
            <div class="preview-email">{{ authStore.user?.email ?? '' }}</div>
          </div>
        </div>

        <!-- 姓名 -->
        <label class="field">
          <span class="field-label">姓名</span>
          <input
            v-model="editName"
            type="text"
            class="field-input"
            maxlength="64"
            autocomplete="name"
            placeholder="你的显示名"
            @input="updatePreviewName(($event.target as HTMLInputElement).value)"
          />
          <span v-if="nameInvalid" class="field-hint error">
            姓名不能为空,且不能超过 64 个字符
          </span>
        </label>

        <!-- 颜色 -->
        <div class="field">
          <span class="field-label">头像颜色</span>
          <div class="palette">
            <button
              v-for="c in PALETTE"
              :key="c"
              type="button"
              class="palette-swatch"
              :class="{ active: editColor.toUpperCase() === c.toUpperCase() }"
              :style="{ background: c }"
              :title="c"
              :aria-label="`选择颜色 ${c}`"
              :aria-pressed="editColor.toUpperCase() === c.toUpperCase()"
              @click="updatePreviewColor(c)"
            ></button>
            <label class="palette-custom" :title="'自定义颜色'">
              <input
                type="color"
                :value="editColor"
                aria-label="自定义颜色"
                @input="updatePreviewColor(($event.target as HTMLInputElement).value)"
              />
              <span class="material-symbols-outlined">colorize</span>
            </label>
          </div>
          <span class="field-hint">{{ editColor }}</span>
        </div>

        <!-- 修改密码 — 折叠。改密是低频操作,默认收起避免跟 name/color
             主表单抢视觉焦点。展开后独立表单 + 独立保存按钮,失败不
             影响 name/color 的 dirty 状态。 -->
        <details class="pwd-section" :open="pwdOpen" @toggle="pwdOpen = ($event.target as HTMLDetailsElement).open">
          <summary class="pwd-summary">
            <span class="material-symbols-outlined">lock</span>
            修改密码
          </summary>
          <div class="pwd-body">
            <label class="field">
              <span class="field-label">当前密码</span>
              <input
                v-model="currentPwd"
                type="password"
                class="field-input"
                autocomplete="current-password"
                placeholder="你正在使用的密码"
              />
            </label>
            <label class="field">
              <span class="field-label">新密码</span>
              <input
                v-model="newPwd"
                type="password"
                class="field-input"
                autocomplete="new-password"
                placeholder="至少 8 位"
              />
            </label>
            <label class="field">
              <span class="field-label">确认新密码</span>
              <input
                v-model="confirmPwd"
                type="password"
                class="field-input"
                autocomplete="new-password"
                placeholder="再输入一次"
              />
              <span
                v-if="confirmPwd.length > 0 && newPwd !== confirmPwd"
                class="field-hint error"
              >
                两次输入的新密码不一致
              </span>
            </label>

            <div v-if="pwdError" class="error-bar" role="alert">
              <span class="material-symbols-outlined">error</span>
              <span>{{ pwdError }}</span>
            </div>

            <div class="pwd-actions">
              <button
                type="button"
                class="btn btn-primary"
                :disabled="!pwdReady || changingPwd"
                @click="onChangePassword"
              >
                <span
                  v-if="changingPwd"
                  class="material-symbols-outlined icon-sm is-loading"
                >progress_activity</span>
                保存新密码
              </button>
            </div>
          </div>
        </details>

        <!-- 错误条 -->
        <div v-if="errorMsg" class="error-bar" role="alert">
          <span class="material-symbols-outlined">error</span>
          <span>{{ errorMsg }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="actions">
        <button
          v-if="dirty && !loading"
          type="button"
          class="btn btn-link"
          @click="onReset"
        >
          放弃修改
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!dirty || nameInvalid || saving || loading"
          @click="onSave"
        >
          <span
            v-if="saving"
            class="material-symbols-outlined icon-sm is-loading"
          >progress_activity</span>
          保存
        </button>
      </div>
    </template>
  </Drawer>
</template>

<style scoped>
.settings-drawer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}
.lead {
  font-size: 13px;
  color: var(--text-3, #6b778c);
  margin: 0 0 4px;
  line-height: 1.5;
}
.loading-state {
  font-size: 13px;
  color: var(--text-3, #6b778c);
  padding: 24px 0;
  text-align: center;
}

.preview-block {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-subtle, #f4f5f7);
  border-radius: var(--radius-md, 6px);
}
.preview-meta { min-width: 0; }
.preview-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1, #172b4d);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-email {
  font-size: 12px;
  color: var(--text-3, #6b778c);
  line-height: 1.3;
  margin-top: 2px;
}

.field { display: flex; flex-direction: column; gap: 6px; }
.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2, #42526e);
}
.field-input {
  height: 32px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 14px;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: var(--radius, 4px);
  background: var(--bg, #fff);
  color: var(--text-1, #172b4d);
}
.field-input:hover { border-color: var(--border-strong, #c1c7d0); }
.field-input:focus {
  outline: none;
  border-color: var(--focus-ring, #4c9aff);
  box-shadow: 0 0 0 1px var(--focus-ring, #4c9aff);
}
.field-hint {
  font-size: 12px;
  color: var(--text-3, #6b778c);
}
.field-hint.error { color: var(--danger, #de350b); }

.palette {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.palette-swatch {
  width: 28px;
  height: 28px;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  transition: transform var(--duration-fast), border-color var(--duration-fast);
}
.palette-swatch:hover { transform: scale(1.1); }
.palette-swatch.active {
  border-color: var(--text-1, #172b4d);
  box-shadow: 0 0 0 2px var(--bg, #fff) inset;
}
.palette-swatch:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 2px;
}

.palette-custom {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px dashed var(--border, #dfe1e6);
  border-radius: 50%;
  cursor: pointer;
  color: var(--text-3, #6b778c);
  background: var(--bg, #fff);
}
.palette-custom .material-symbols-outlined {
  font-size: 16px;
}
.palette-custom input[type='color'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
}

.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--error-soft, #ffebe6);
  border: 1px solid var(--error, #de350b);
  border-radius: var(--radius, 4px);
  color: var(--error, #de350b);
  font-size: 13px;
}
.error-bar .material-symbols-outlined { font-size: 18px; }

.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.actions .btn-link { margin-right: auto; }
.btn {
  height: 32px;
  padding: 0 16px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius, 4px);
  border: 1px solid transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn-primary {
  background: var(--accent, #0052cc);
  color: #fff;
}
.btn-primary:hover:not(:disabled) { background: var(--accent-strong, #0747a6); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-link {
  background: transparent;
  color: var(--accent, #0052cc);
  padding: 0;
  border: 0;
  text-decoration: underline;
}
.btn-link:hover { color: var(--accent-strong, #0747a6); }
.icon-sm { font-size: 16px; }
.is-loading { animation: spin 0.9s linear infinite; }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

.pwd-section {
  border: 1px solid var(--border, #dfe1e6);
  border-radius: var(--radius, 4px);
  background: var(--bg, #fff);
}
.pwd-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2, #42526e);
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.pwd-summary::-webkit-details-marker { display: none; }
.pwd-summary::before {
  content: 'chevron_right';
  font-family: 'Material Symbols Outlined';
  font-size: 18px;
  color: var(--text-3, #6b778c);
  transition: transform var(--duration-fast);
}
.pwd-section[open] > .pwd-summary::before { transform: rotate(90deg); }
.pwd-summary:hover { background: var(--bg-subtle, #f4f5f7); }
.pwd-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 12px 12px;
  border-top: 1px solid var(--border, #ebecf0);
}
.pwd-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
