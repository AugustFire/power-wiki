<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { ApiError } from '@/lib/api'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

const newPasswordTooShort = computed(() => newPassword.value.length > 0 && newPassword.value.length < 8)
const passwordsMismatch = computed(() => confirmPassword.value.length > 0 && newPassword.value !== confirmPassword.value)
const sameAsCurrent = computed(() => newPassword.value.length > 0 && currentPassword.value.length > 0 && newPassword.value === currentPassword.value)

const canSubmit = computed(() =>
  currentPassword.value.length > 0 &&
  newPassword.value.length >= 8 &&
  newPassword.value === confirmPassword.value &&
  newPassword.value !== currentPassword.value,
)

/**
 * Pick redirect target after reset:
 *   1. ?redirect= query string (validated)
 *   2. Otherwise → /manager/users for admins, / for regular users
 */
function resolveRedirect(): string {
  const raw = route.query.redirect
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) return raw
  return authStore.isAdmin ? '/manager/users' : '/'
}

async function onSubmit() {
  if (submitting.value || !canSubmit.value) return
  errorMsg.value = null
  submitting.value = true
  try {
    await authStore.resetPassword(currentPassword.value, newPassword.value)
    const dest = resolveRedirect()
    // Admin lands on manager UI; only kick off data loaders for the home path.
    if (!dest.startsWith('/manager')) {
      await spacesStore.init()
      await pagesStore.init()
    }
    void router.replace(dest)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      errorMsg.value = '当前密码错误'
    } else if (e instanceof ApiError) {
      errorMsg.value = e.message
    } else {
      errorMsg.value = '重置失败,请重试'
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="reset-page">
    <form class="reset-card" @submit.prevent="onSubmit">
      <div class="brand">
        <span class="brand-mark">P</span>
        <span class="brand-name">power-wiki</span>
      </div>
      <h1 class="reset-title">设置新密码</h1>
      <p class="reset-hint">
        你正在首次登录或被管理员重置了密码,请设置一个新的密码。
      </p>

      <div v-if="errorMsg" class="reset-error" role="alert">
        <span class="material-symbols-outlined le-icon">error</span>
        <span>{{ errorMsg }}</span>
      </div>

      <label class="field">
        <span class="field-label">当前密码</span>
        <input
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          required
          placeholder="初始密码或旧密码"
          class="field-input"
          :disabled="submitting"
          autofocus
        />
      </label>

      <label class="field">
        <span class="field-label">新密码</span>
        <input
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
          placeholder="至少 8 位"
          class="field-input"
          :class="{ 'field-input-invalid': newPasswordTooShort || sameAsCurrent }"
          :disabled="submitting"
        />
        <span v-if="newPasswordTooShort" class="field-hint field-hint-warn">
          密码至少需要 8 位
        </span>
        <span v-else-if="sameAsCurrent" class="field-hint field-hint-warn">
          新密码不能与当前密码相同
        </span>
      </label>

      <label class="field">
        <span class="field-label">确认新密码</span>
        <input
          v-model="confirmPassword"
          type="password"
          autocomplete="new-password"
          required
          placeholder="再输入一次"
          class="field-input"
          :class="{ 'field-input-invalid': passwordsMismatch }"
          :disabled="submitting"
        />
        <span v-if="passwordsMismatch" class="field-hint field-hint-warn">
          两次输入的密码不一致
        </span>
      </label>

      <button type="submit" class="submit" :disabled="!canSubmit || submitting">
        <span v-if="submitting" class="spinner" aria-hidden="true"></span>
        <span>{{ submitting ? '提交中…' : '设置新密码并登录' }}</span>
      </button>
    </form>
  </div>
</template>

<style scoped>
.reset-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas, #F4F5F7);
  padding: 24px;
}

.reset-card {
  width: 100%;
  max-width: 440px;
  background: var(--bg, #FFFFFF);
  border: 1px solid var(--border, #DFE1E6);
  border-radius: var(--radius-lg, 6px);
  padding: 32px;
  box-shadow: var(--shadow-md, 0 4px 8px -2px rgba(9, 30, 66, 0.08), 0 0 1px rgba(9, 30, 66, 0.08));
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
  margin-bottom: 4px;
}
.brand-mark {
  width: 24px;
  height: 24px;
  background: var(--accent, #0052CC);
  border-radius: var(--radius, 3px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 14px;
}
.brand-name { color: var(--text-1, #172B4D); }

.reset-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-1, #172B4D);
  margin: 4px 0 0 0;
  line-height: 1.2;
}
.reset-hint {
  font-size: 13px;
  color: var(--text-3, #6B778C);
  margin: 0 0 4px 0;
}

.reset-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--danger-soft, #FFEBE6);
  color: var(--danger, #FF5630);
  font-size: 13px;
  border-radius: var(--radius-md, 4px);
  border: 1px solid var(--danger, #FF5630);
}
.le-icon { font-size: 18px; flex-shrink: 0; }

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2, #44546F);
}
.field-input {
  height: 44px;
  padding: 0 12px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1, #172B4D);
  background: var(--bg, #FFFFFF);
  border: 2px solid var(--border, #DFE1E6);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.field-input:focus { border-color: var(--accent, #0052CC); }
.field-input-invalid { border-color: var(--danger, #FF5630); }
.field-input:disabled { background: var(--bg-canvas, #F4F5F7); cursor: not-allowed; }

.field-hint {
  font-size: 12px;
  color: var(--text-3, #6B778C);
}
.field-hint-warn { color: var(--danger, #FF5630); }

.submit {
  margin-top: 6px;
  height: 44px;
  width: 100%;
  background: var(--accent, #0052CC);
  color: var(--text-invert, #FFFFFF);
  border: 0;
  border-radius: var(--radius-md, 4px);
  font-size: 14px;
  font-weight: 600;
  font-family: var(--font-sans, inherit);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background var(--duration-fast, 120ms) var(--ease-out, ease);
}
.submit:hover:not(:disabled) { background: var(--accent-hover, #0747A6); }
.submit:disabled { opacity: 0.6; cursor: not-allowed; }

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: white;
  border-radius: 50%;
  animation: rp-spin 0.8s linear infinite;
}
@keyframes rp-spin { to { transform: rotate(360deg); } }
</style>