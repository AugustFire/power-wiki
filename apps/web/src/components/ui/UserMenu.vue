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
 *   - 我的空间  → setActiveSpace(personal) + replace('/'),在个人空间上下文里
 *                落地为 M2 Dashboard。详情见 `goMySpace` 注释。
 *   - 设置     → SettingsDrawer
 *   - 管理后台 (admin only — gated by authStore.isAdmin) → /manager/people
 *   - 登出     (clears session, authStore.logout() + redirect to /login)
 *
 * 命名 / 落地策略 (2026-07-11 三段式演化):
 *   v1: 「我的空间」 跳 /p/<personalSpaceId> —— personalSpaceId 是 space ID
 *       不是 page ID,直接 404。
 *   v2: 拆为 「我的工作」(/me) + 「我的空间」(setActive + /) 两项。用户反馈
 *       「我的工作」 有钉钉味,合并为 「我的空间」(/me)。
 *   v3 (当前): 「我的空间」 跳 /,前提是 active=personal。`/` HomeView 在
 *       personal context 下渲染 MeDashboardView,team 空间下渲染 page tree。
 *       — 字面意义「我的空间」 = 个人空间首页 = 视觉上是 awareness 视图。
 *       — 深链 /me 仍可用(直接挂 MeDashboardView,无 active 切换),但不是
 *         主要入口。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useSpacesStore } from '@/stores/spaces'

const router = useRouter()
const authStore = useAuthStore()
const uiStore = useUiStore()
const spacesStore = useSpacesStore()

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

/**
 * 「我的空间」 → `/` 路由,前提是 active space 已是 personal。
 *
 * 落地策略(2026-07-11 决定):
 *   `/` 路由是 HomeView,该 view 在 `activeSpace.kind === 'personal'` 时
 *   渲染 MeDashboardView(M2 awareness 视图)而不是团队空间的 page tree。
 *   这样「我的空间」的字面语义与落地统一:
 *     - URL 是 `/`(个人空间首页,跟其他空间同档位)
 *     - 视觉是 awareness dashboard(被 @ / 草稿 / 我创建 / 关注 / 最近)
 *
 *   `personalSpaceId` 是 space ID 不是 page ID,不能用 `/p/<id>`。我们走
 *   「切 active space → 跳 /」,跟登录后默认落地的同一条路径 —— 但用
 *   `replace` 避免从个人空间外的页面跳进来时 history 多塞一条,以及从
 *   Dashboard 内点自身时无意义滚动。
 */
function goMySpace() {
  close()
  const id = authStore.personalSpaceId
  if (!id) return
  if (spacesStore.activeSpaceId.value !== id) {
    spacesStore.setActiveSpace(id)
  }
  void router.replace('/')
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
          type="button"
          class="um-item"
          role="menuitem"
          @click="goSettings"
        >
          <span class="material-symbols-outlined um-icon">settings</span>
          <span>设置</span>
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