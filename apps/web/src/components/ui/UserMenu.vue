<script setup lang="ts">
/**
 * UserMenu — topbar avatar with dropdown.
 *
 * Replaces the plain UserAvatar mount in App.vue's topbar-right. The dropdown
 * is a click-to-toggle, click-outside / Esc to close pattern — no tippy/teleport
 * since the popover is small and lives within the topbar's overflow region.
 *
 * Items:
 *   - Header: avatar + name + email
 *   - 管理后台 (admin only — gated by authStore.isAdmin)
 *   - 登出 (clears session, authStore.logout() + reload to /login)
 *
 * Phase 4c will add a SpaceSwitcher section between the header and admin link
 * so admins can switch the active space without leaving the topbar.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node | null
  if (rootEl.value && t && !rootEl.value.contains(t)) close()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})

function goManager() {
  close()
  void router.push('/manager/people')
}

function goMySpace() {
  close()
  // Use the canonical /me route so the URL reflects the destination —
  // /me renders MySpaceView which flips the active space to the user's
  // personal space and bounces to / (HomeView then renders the tree).
  void router.push('/me')
}

async function onLogout() {
  close()
  // Cover the logout handoff with the boot spinner (App.vue showBoot),
  // mirroring LoginView's login-time pattern. Without this the moment
  // `auth.logout()` sets `user = null` the authed shell unmounts; the
  // RouterView then re-renders the current authed route (e.g. a HomeView
  // whose page tree was just wiped by `resetSessionState`), giving us a
  // visible blank frame before the router settles on /login.
  authStore.transitioning = true
  try {
    await authStore.logout()
    // After logout the auth guard will redirect any protected route to /login.
    // We use replace (not push) so back-button doesn't return to a protected page.
    await router.replace({ name: 'login' })
    // Small delay so the LoginView has at least started mounting before
    // we drop the boot overlay (matches the 80ms tail in LoginView.onSubmit).
    await new Promise((r) => setTimeout(r, 80))
  } finally {
    authStore.transitioning = false
  }
}
</script>

<template>
  <div ref="rootEl" class="user-menu">
    <button
      type="button"
      class="um-trigger"
      :class="{ open }"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="authStore.user?.name ?? '账号'"
      @click="toggle"
    >
      <UserAvatar
        :size="28"
        :label="authStore.user?.name ?? '?'"
        :color="authStore.user?.color"
      />
    </button>

    <transition name="um-fade">
      <div v-if="open" class="um-popover" role="menu">
        <div class="um-header">
          <UserAvatar
            :size="36"
            :label="authStore.user?.name ?? '?'"
            :color="authStore.user?.color"
          />
          <div class="um-header-text">
            <div class="um-name">{{ authStore.user?.name ?? '未登录' }}</div>
            <div class="um-email">{{ authStore.user?.email ?? '' }}</div>
          </div>
        </div>

        <div class="um-divider"></div>

        <button
          v-if="authStore.personalSpaceId"
          type="button"
          class="um-item"
          role="menuitem"
          @click="goMySpace"
        >
          <span class="material-symbols-outlined um-icon">cottage</span>
          <span>我的空间</span>
        </button>

        <button
          v-if="authStore.isAdmin"
          type="button"
          class="um-item"
          role="menuitem"
          @click="goManager"
        >
          <span class="material-symbols-outlined um-icon">admin_panel_settings</span>
          <span>管理后台</span>
        </button>

        <button type="button" class="um-item danger" role="menuitem" @click="onLogout">
          <span class="material-symbols-outlined um-icon">logout</span>
          <span>登出</span>
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.user-menu { position: relative; display: inline-flex; }

.um-trigger {
  background: transparent;
  border: 0;
  padding: 0;
  margin-left: 8px;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: box-shadow var(--duration-fast) var(--ease-out);
}
.um-trigger:hover { box-shadow: 0 0 0 4px var(--accent-bg-soft); }
.um-trigger.open { box-shadow: 0 0 0 4px var(--accent-bg-active); }
.um-trigger:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.um-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: var(--shadow-md, 0 4px 8px -2px rgba(9, 30, 66, 0.08), 0 0 1px rgba(9, 30, 66, 0.08));
  padding: 4px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.um-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 10px 8px 10px;
}
.um-header-text { min-width: 0; }
.um-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.um-email {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.um-divider {
  height: 1px;
  background: var(--border);
  margin: 2px 0;
}

.um-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  font-size: 14px;
  font-family: var(--font-sans, inherit);
  color: var(--text-1);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm, 3px);
  text-align: left;
  cursor: pointer;
  width: 100%;
  transition: background var(--duration-fast) var(--ease-out);
}
.um-item:hover { background: var(--bg-canvas); }
.um-item:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
.um-item.danger { color: var(--danger); }
.um-item.danger:hover { background: var(--danger-soft); }

.um-icon {
  font-size: 18px;
  flex-shrink: 0;
  color: inherit;
}

/* 弹出动画 */
.um-fade-enter-active,
.um-fade-leave-active {
  transition: opacity var(--duration-fast) ease, transform var(--duration-fast) var(--ease-out);
}
.um-fade-enter-from,
.um-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>