<script setup lang="ts">
import { ref } from 'vue'
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

const email = ref('')
const password = ref('')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

/**
 * Pick redirect target after login:
 *   1. ?redirect= query string (validated to be a local path only — no open-redirect)
 *   2. Otherwise → /manager/users for admins (so they see their user list
 *      immediately and can create accounts), or / for regular users
 */
function resolveRedirect(): string {
  const raw = route.query.redirect
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) {
    return raw
  }
  return authStore.isAdmin ? '/manager/users' : '/'
}

async function onSubmit() {
  if (submitting.value) return
  errorMsg.value = null
  submitting.value = true
  try {
    await authStore.login(email.value.trim(), password.value)
    // After login, store now has user + mustResetPassword.
    // mustReset takes priority — Router guard will re-route to /reset-password.
    if (authStore.needsPasswordReset) {
      void router.replace('/reset-password')
      return
    }
    const dest = resolveRedirect()
    // Spaces and pages still need to load for HomeView (regular user path).
    // Admin lands on /manager/users directly, so we can skip those loads.
    if (!dest.startsWith('/manager')) {
      await spacesStore.init()
      await pagesStore.init()
    }
    void router.replace(dest)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'account_disabled') {
      errorMsg.value = '账号已被禁用,请联系管理员'
    } else if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      // Generic 401 from sign-in — backend intentionally doesn't distinguish
      // wrong email vs wrong password to prevent enumeration.
      errorMsg.value = '邮箱或密码错误'
    } else if (e instanceof ApiError) {
      errorMsg.value = e.message
    } else {
      errorMsg.value = '登录失败,请重试'
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <form class="login-card" @submit.prevent="onSubmit">
      <div class="brand">
        <span class="brand-mark">P</span>
        <span class="brand-name">power-wiki</span>
      </div>
      <h1 class="login-title">登录</h1>
      <p class="login-hint">使用账号密码登录到团队知识库</p>

      <div v-if="errorMsg" class="login-error" role="alert">
        <span class="material-symbols-outlined le-icon">error</span>
        <span>{{ errorMsg }}</span>
      </div>

      <label class="field">
        <span class="field-label">邮箱</span>
        <input
          v-model="email"
          type="email"
          autocomplete="email"
          required
          placeholder="you@example.com"
          class="field-input"
          :disabled="submitting"
          autofocus
        />
      </label>

      <label class="field">
        <span class="field-label">密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          placeholder="••••••••"
          class="field-input"
          :disabled="submitting"
        />
      </label>

      <button type="submit" class="submit" :disabled="submitting">
        <span v-if="submitting" class="spinner" aria-hidden="true"></span>
        <span>{{ submitting ? '登录中…' : '登录' }}</span>
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas, #F4F5F7);
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: var(--bg, #FFFFFF);
  border: 1px solid var(--border, #DFE1E6);
  border-radius: var(--radius-lg, 6px);
  padding: 32px;
  box-shadow: var(--shadow-md, 0 4px 8px -2px rgba(9, 30, 66, 0.08), 0 0 1px rgba(9, 30, 66, 0.08));
  display: flex;
  flex-direction: column;
  gap: 16px;
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

.login-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-1, #172B4D);
  margin: 4px 0 0 0;
  line-height: 1.2;
}
.login-hint {
  font-size: 13px;
  color: var(--text-3, #6B778C);
  margin: 0 0 8px 0;
}

.login-error {
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
.field-input:focus {
  border-color: var(--accent, #0052CC);
}
.field-input:disabled {
  background: var(--bg-canvas, #F4F5F7);
  cursor: not-allowed;
}

.submit {
  margin-top: 4px;
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
  animation: login-spin 0.8s linear infinite;
}
@keyframes login-spin { to { transform: rotate(360deg); } }
</style>