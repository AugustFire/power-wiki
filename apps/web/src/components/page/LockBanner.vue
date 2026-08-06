<!--
  LockBanner —— EditView 顶部的「Alice 锁定中」横幅,提示当前页面被别人拿
  着编辑锁。

  Phase 4 (2026-08-05):Confluence 风格的 page-level lock UI。
    - 颜色:warning(中黄),区别于 error 的红。
    - 倒计时每秒刷新一次,过期(到 0:00 时)LockBanner 自动隐藏。
    - admin 用户看到「强制接管」按钮,普通 holder 用户看到「放弃锁」。
    - 「放弃锁」= holder 调用 DELETE /api/pages/:id/lock;组件 unmount 时
      usePageLock 也会自动调一次,所以这个按钮主要是「我决定不写了」
      的显式语义入口。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, ApiError, type PageLock } from '@/lib/api'
import { formatLockRemaining } from '@/lib/formatLockExpiry'
import { useUiStore } from '@/stores/ui'
import { useConfirm } from '@/composables/useConfirm'
import UserAvatar from '@/components/ui/UserAvatar.vue'

const props = defineProps<{
  /** 当前 page 的锁状态(可能是 null / 自己的 / 他人的)。 */
  lock: PageLock | null
  /** 当前 user 是否 admin —— 显示「强制接管」按钮。 */
  isAdmin: boolean
  /** 当前 user.id —— 决定 lock.userId === me 时是「我的」还是「他人」。 */
  currentUserId: string
  /** 当前 lock holder 的展示名 / 头像色 / 头像(由 usePageLock 解析 awareness
   *  state 或 users lookup 拿到)。失败时 fallback to userId。 */
  holderName?: string | null
  holderColor?: string | null
  holderAvatarKind?: 'preset' | 'custom' | null
  holderAvatarRef?: string | null
}>()

const emit = defineEmits<{
  /** usePageLock 监听:lock 已释放(主动 / 接管 / 过期)。caller 把
   *  内部 lock ref 清掉。 */
  released: []
  /** 接管成功后 caller 切到「我」状态:刷新 lock.value 给上层。 */
  takeover: [lock: PageLock]
}>()

const uiStore = useUiStore()
const { confirm } = useConfirm()

/** 倒计时:每秒重渲一次;过期(到 0:00 后下一帧)整条 banner 隐藏。 */
const now = ref(Date.now())
let tickHandle: number | null = null

onMounted(() => {
  tickHandle = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (tickHandle != null) {
    window.clearInterval(tickHandle)
    tickHandle = null
  }
})

/** 显示条件:
 *   - 有 lock
 *   - lock 未过期(expiresAt > now)
 *   - lock.userId !== 自己 —— 自己持锁时不需要 banner
 */
const remainingMs = computed(() => {
  if (!props.lock) return 0
  return Math.max(0, props.lock.expiresAt - now.value)
})

const isMine = computed(() => !!props.lock && props.lock.userId === props.currentUserId)
const visible = computed(() => !!props.lock && remainingMs.value > 0 && !isMine.value)
const remainingText = computed(() =>
  props.lock ? formatLockRemaining(props.lock.expiresAt, now.value) : '0:00',
)

/** 接管操作 —— admin 专用。弹 confirm 二次确认(强制接管别人工作
 *  不应该是随手操作),确认后调 takeover endpoint,把 server 端新锁
 *  返给 usePageLock 更新。 */
async function onTakeover() {
  if (!props.lock) return
  const ok = await confirm({
    title: '强制接管此页面?',
    message: `正在编辑的用户 ${props.holderName ?? props.lock.userId} 的未保存修改会被标记为冲突。你的修改不会覆盖他们已落盘的修改(Yjs CRDT 合并),但锁接管会通知他们的客户端刷新 UI。`,
    confirmText: '强制接管',
    cancelText: '取消',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await api.pageLock.takeover(props.lock.pageId)
    emit('takeover', r.lock)
    uiStore.notify(`已接管「${props.holderName ?? '该页面'}」的编辑`, 'success')
  } catch (e) {
    if (e instanceof ApiError) {
      uiStore.notify(e.message ?? '接管失败', 'error', 5000)
    } else {
      throw e
    }
  }
}

/** 「放弃锁」= holder 主动释放,但 banner 是他人锁视角显示(自己的锁
 *  不渲染),所以这个按钮实际只在 admin 接管 / 或自己 idle 自动到期
 *  时用 —— 这里保留出口给 admin 误拿锁场景下放弃回他人。 */
async function onRelease() {
  if (!props.lock) return
  try {
    await api.pageLock.release(props.lock.pageId)
    emit('released')
    uiStore.notify('已释放锁', 'success')
  } catch (e) {
    if (e instanceof ApiError) {
      uiStore.notify(e.message ?? '释放失败', 'error', 5000)
    } else {
      throw e
    }
  }
}

watch(
  () => props.lock?.userId,
  () => {
    // lock holder 变化时不需要做什么特殊处理,visible computed 自动翻转
  },
)
</script>

<template>
  <div v-if="visible" class="lock-banner">
    <span class="material-symbols-outlined lock-icon" aria-hidden="true">lock</span>
    <UserAvatar
      v-if="lock"
      :size="20"
      :color="holderColor ?? 'var(--text-3)'"
      :label="holderName ?? lock.userId"
      :avatar-kind="holderAvatarKind ?? null"
      :avatar-ref="holderAvatarRef ?? null"
      :user-id="lock.userId"
    />
    <span class="lock-text">
      <strong>{{ holderName ?? lock?.userId }}</strong>
      正在编辑此页面 · 还剩 <span class="lock-timer">{{ remainingText }}</span>
    </span>
    <div class="lock-actions">
      <button
        v-if="isAdmin && lock"
        type="button"
        class="btn-takeover"
        title="强制接管(发送通知给当前编辑者)"
        @click="onTakeover"
      >
        <span class="material-symbols-outlined icon-sm">emergency_share</span>
        强制接管
      </button>
      <button
        v-if="isMine && lock"
        type="button"
        class="btn-release"
        title="释放编辑锁(组件卸载时也会自动释放)"
        @click="onRelease"
      >
        <span class="material-symbols-outlined icon-sm">lock_open</span>
        释放锁
      </button>
    </div>
  </div>
</template>

<style scoped>
.lock-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  margin-bottom: 12px;
  background: var(--warning-soft, #FFF7E6);
  border: 1px solid var(--warning-border, #F5A623);
  border-radius: 4px;
  color: var(--warning-text, #8A5300);
  font-size: 13px;
  font-weight: 500;
}

.lock-icon {
  font-size: 18px;
  color: var(--warning, #F5A623);
  flex-shrink: 0;
}

.lock-text {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.lock-timer {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  margin: 0 2px;
}

.lock-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn-takeover,
.btn-release {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 0;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface-1);
  color: var(--warning-text, #8A5300);
  transition: background 0.12s ease;
}

.btn-takeover {
  background: var(--warning, #F5A623);
  color: white;
}

.btn-takeover:hover {
  background: #E09612;
}

.btn-release:hover {
  background: var(--bg-subtle);
}
</style>