<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { ApiError } from '@/lib/api'
import BrandLogo from '@/components/ui/BrandLogo.vue'

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
    if (authStore.needsPasswordReset) {
      void router.replace('/reset-password')
      return
    }
    const dest = resolveRedirect()
    // Cover the LoginView → destination handoff so the unmount frame doesn't
    // flash blank. Cleared in the finally after router.replace resolves +
    // one tick, so the destination view has at least started mounting.
    authStore.transitioning = true
    if (!dest.startsWith('/manager')) {
      await spacesStore.init()
      await pagesStore.init()
    }
    await router.replace(dest)
    await new Promise((r) => setTimeout(r, 80))
  } catch (e) {
    if (e instanceof ApiError && e.code === 'account_disabled') {
      errorMsg.value = '账号已被禁用,请联系管理员'
    } else if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      errorMsg.value = '邮箱或密码错误'
    } else if (e instanceof ApiError) {
      errorMsg.value = e.message
    } else {
      errorMsg.value = '登录失败,请重试'
    }
  } finally {
    submitting.value = false
    authStore.transitioning = false
  }
}
</script>

<template>
  <div class="login-page">
    <!-- 左侧:品牌区 -->
    <aside class="login-brand">
      <div class="lb-decor" aria-hidden="true">
        <!-- 装饰:浅色低透明度几何元素,呼应 logo 的书页线条 -->
        <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
          <g stroke="currentColor" stroke-linecap="round" fill="none">
            <line x1="40" y1="60" x2="360" y2="60" stroke-width="2" opacity="0.18" />
            <line x1="40" y1="80" x2="280" y2="80" stroke-width="2" opacity="0.12" />
            <line x1="40" y1="100" x2="320" y2="100" stroke-width="2" opacity="0.08" />
            <circle cx="340" cy="320" r="80" stroke-width="2" opacity="0.1" />
            <circle cx="340" cy="320" r="40" stroke-width="2" opacity="0.16" />
          </g>
        </svg>
      </div>
      <div class="lb-content">
        <BrandLogo :size="56" variant="light" with-wordmark class="lb-logo" />
        <h1 class="lb-tagline">团队知识库 · 协作编辑</h1>
        <p class="lb-sub">
          Confluence 风格的开源 wiki,<br />
          沉淀团队每一份知识。
        </p>
      </div>
    </aside>

    <!-- 右侧:表单区 -->
    <main class="login-main">
      <form class="login-card" @submit.prevent="onSubmit">
        <BrandLogo :size="28" class="lc-mark" />
        <h2 class="lc-title">登录</h2>
        <p class="lc-hint">使用账号密码登录到团队知识库</p>

        <div v-if="errorMsg" class="lc-error" role="alert">
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
    </main>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  background: var(--bg);
}

/* ─── 左侧品牌区(40%) ─── */
.login-brand {
  flex: 0 0 40%;
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at 80% 20%, rgba(255, 255, 255, 0.08), transparent 60%),
    linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
  color: var(--text-invert);
  display: flex;
  align-items: center;
  padding: 64px;
}
.lb-decor {
  position: absolute;
  inset: 0;
  color: var(--text-invert);
  pointer-events: none;
}
.lb-decor svg {
  width: 100%;
  height: 100%;
}
.lb-content {
  position: relative;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.lb-logo {
  /* 让字标跟着 logo 一起变大 — Logo 56px,字标约 36px */
  font-size: 36px;
}
.lb-tagline {
  font-size: 36px;
  font-weight: 700;
  line-height: 1.25;
  margin: 8px 0 0 0;
  letter-spacing: -0.01em;
}
.lb-sub {
  font-size: 16px;
  line-height: 1.6;
  margin: 0;
  opacity: 0.85;
  font-weight: 400;
}

/* ─── 右侧表单区(60%) ─── */
.login-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 64px;
  background: var(--bg-canvas);
}
.login-card {
  width: 100%;
  max-width: 400px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 6px);
  padding: 36px;
  box-shadow: var(--shadow-md, 0 4px 8px -2px rgba(9, 30, 66, 0.08), 0 0 1px rgba(9, 30, 66, 0.08));
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.lc-mark { margin-bottom: 4px; }
.lc-title {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-1);
  margin: 4px 0 0 0;
  line-height: 1.2;
}
.lc-hint {
  font-size: 13px;
  color: var(--text-3);
  margin: 0 0 8px 0;
}

.lc-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 13px;
  border-radius: var(--radius-md, 4px);
  border: 1px solid var(--danger);
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
  color: var(--text-2);
}
.field-input {
  height: 44px;
  padding: 0 12px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: var(--bg);
  border: 2px solid var(--border);
  border-radius: var(--radius-md, 4px);
  outline: none;
  transition: border-color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.field-input:focus { border-color: var(--accent); }
.field-input:disabled { background: var(--bg-canvas); cursor: not-allowed; }

.submit {
  margin-top: 4px;
  height: 44px;
  width: 100%;
  background: var(--accent);
  color: var(--text-invert);
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
.submit:hover:not(:disabled) { background: var(--accent-hover); }
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