<script setup lang="ts">
/**
 * UserMenu — topbar avatar with dropdown.
 *
 * Replaces the plain UserAvatar mount in App.vue's topbar-right. The dropdown
 * is a click-to-toggle, click-outside / Esc to close pattern — no tippy/teleport
 * since the popover is small and lives within the topbar's overflow region.
 *
 * Items (top → bottom):
 *   - Header: avatar + name + email
 *   - 我的空间 → /me 全局个人工作台
 *   - 设置     → SettingsDrawer
 *   - 登出     (clears session, authStore.logout() + redirect to /login)
 *
 * P1-8: 「管理后台」从这里挪到 TopBar 的 `ManagementMenu` dropdown —
 * 跟「当前空间管理」同段对照,避免单个 UserMenu 里塞两条作用域不同的
 * admin 入口(global vs. space)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SpaceAvatar from '@/components/ui/SpaceAvatar.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useSpacesStore } from '@/stores/spaces'

const router = useRouter()
const authStore = useAuthStore()
const uiStore = useUiStore()
const spacesStore = useSpacesStore()

const personalSpace = computed(() => spacesStore.personalSpace.value)

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

async function goMySpace() {
  close()
  // P1-7: 「我的空间」 = 进入个人空间容器视图(跟 SpaceSwitcher 选中
  // personal 是同一动作:切 activeSpace → 跳到该空间的 home)。这跟
  // 「我的工作台」(/me)是两个产品:
  //   - 我的工作台:跨空间个人 dashboard(pinned / recents / @mention)
  //   - 我的空间:个人空间的 page tree 容器(可看可编辑私人页面)
  // 之前把两条合并成 `push('/me')`,让用户失去了进入个人空间容器视图
  // 的入口 —— 现在分开:
  //   - Sidebar 顶部「我的工作台」 → /me (PersonalHomeView)
  //   - UserMenu「我的空间」 → / (SpaceHomeView, active=personal)
  if (personalSpace.value) {
    spacesStore.setActiveSpace(personalSpace.value.id)
    if (router.currentRoute.value.path !== '/') {
      void router.push('/')
    }
  }
}

/**
 * Open the SettingsDrawer (P1-6). Triggered by the 「设置」 menu item below.
 * Drawer itself lives at the App.vue level (teleport), so we only flip
 * uiStore.openSettings() here; the drawer responds to the reactive flag.
 */
function goSettings() {
  close()
  uiStore.openSettings()
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
        :avatar-kind="authStore.user?.avatarKind ?? null"
        :avatar-ref="authStore.user?.avatarRef ?? null"
        :user-id="authStore.user?.id ?? null"
      />
    </button>

    <transition name="um-fade">
      <div v-if="open" class="um-popover" role="menu">
        <div class="um-header">
          <UserAvatar
            :size="36"
            :label="authStore.user?.name ?? '?'"
            :color="authStore.user?.color"
            :avatar-kind="authStore.user?.avatarKind ?? null"
            :avatar-ref="authStore.user?.avatarRef ?? null"
            :user-id="authStore.user?.id ?? null"
          />
          <div class="um-header-text">
            <div class="um-name">{{ authStore.user?.name ?? '未登录' }}</div>
            <div class="um-email">{{ authStore.user?.email ?? '' }}</div>
          </div>
        </div>

        <div class="um-divider"></div>

        <button
          v-if="authStore.personalSpaceId && personalSpace"
          type="button"
          class="um-item"
          role="menuitem"
          @click="goMySpace"
        >
          <SpaceAvatar :space="personalSpace" :size="20" />
          <span>我的空间</span>
        </button>

        <button
          type="button"
          class="um-item"
          role="menuitem"
          @click="goSettings"
        >
          <span class="material-symbols-outlined um-icon">settings</span>
          <span>设置</span>
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