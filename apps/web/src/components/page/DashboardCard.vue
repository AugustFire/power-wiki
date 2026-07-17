<script setup lang="ts">
/**
 * DashboardCard — Dashboard section 卡片。
 *
 * 两个变体:`'page' | 'mention'`,对应 Dashboard 4 个 section 中
 * 的 2 种 row shape:
 *   - 'page'    — created / watched / recent / personalSpace section 用的
 *                 PageNode 卡(标题 + space chip + 时间 + 创建者)
 *   - 'mention' — mentions section 用的通知卡(actor 头像 + 通知文本 + 跳转)
 *
 * 设计目标:复用 ReadView byline 视觉风格(icon + 标题 + space chip + 时间)。
 * 点击 → 路由跳转;mention 用 `?hash=#comment-{id}` 锚点跳到评论。
 *
 * 不持有任何状态 —— 数据全部 props 传入,view 层管 fetch / refresh。
 */
import { computed } from 'vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { formatRelativeTime } from '@/lib/relativeTime'
import { NotificationKindLabels } from '@power-wiki/shared'
import type { PageNode, Notification } from '@power-wiki/shared'

const props = withDefaults(
  defineProps<{
    variant: 'page' | 'mention'
    /** 'page':PageNode; 'mention':Notification */
    page?: PageNode | null
    /** 'mention' variant:the notification to render */
    notification?: Notification | null
    /** space chip 显示。mention variant 用 notification 的 pageTitle 渲染时,
     * 这里额外提供 space 信息。'page' variant 从 page.spaceId 派生。 */
    spaceName?: string | null
    spaceColor?: string | null
    spaceKind?: 'personal' | 'shared' | null
  }>(),
  {
    page: null,
    notification: null,
    spaceName: null,
    spaceColor: null,
    spaceKind: null,
  },
)

const emit = defineEmits<{
  /** page click → /p/{id} */
  (e: 'openPage', pageId: string): void
  /** mention click → /p/{pageId}#comment-{commentId} */
  (e: 'openMention', pageId: string, commentId: string | null): void
}>()

const pageId = computed<string | null>(() => {
  if (props.variant === 'page') return props.page?.id ?? null
  return props.notification?.pageId ?? null
})

const pageTitle = computed<string>(() => {
  if (props.variant === 'page') return props.page?.title?.trim() || '(无标题)'
  return props.notification?.pageTitle?.trim() || '(无标题)'
})

const pageIcon = computed<string | undefined>(() => {
  if (props.variant === 'page') return props.page?.icon || undefined
  return undefined
})

const authorName = computed<string | null>(() => {
  if (props.variant === 'page') return props.page?.authorName ?? null
  return props.notification?.actorName ?? null
})
const authorColor = computed<string | null>(() => {
  if (props.variant === 'page') return props.page?.authorColor ?? null
  return props.notification?.actorColor ?? null
})

const updatedAt = computed<number | null>(() => {
  if (props.variant === 'page') return props.page?.updatedAt ?? null
  return props.notification?.createdAt ?? null
})

function handleClick(): void {
  if (props.variant === 'mention' && props.notification) {
    emit('openMention', props.notification.pageId, props.notification.commentId ?? null)
    return
  }
  if (pageId.value) {
    emit('openPage', pageId.value)
  }
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    handleClick()
  }
}

const mentionLabel = computed<string>(() => {
  const kind = props.notification?.kind ?? 'mention'
  return NotificationKindLabels[kind] ?? '提及'
})
</script>

<template>
  <div
    class="dash-card"
    :class="`variant-${variant}`"
    role="button"
    tabindex="0"
    @click="handleClick"
    @keydown="handleKeydown"
  >
    <div class="dash-icon" aria-hidden="true">
      <span v-if="pageIcon" class="material-symbols-outlined">{{ pageIcon }}</span>
      <UserAvatar
        v-else-if="variant === 'mention'"
        :size="32"
        :label="authorName ?? (notification?.actorId ?? '?')"
        :color="authorColor ?? undefined"
        :avatar-kind="notification?.actorAvatarKind ?? null"
        :avatar-ref="notification?.actorAvatarRef ?? null"
        :user-id="notification?.actorId ?? null"
        :title="authorName ?? ''"
      />
      <span v-else class="material-symbols-outlined">description</span>
    </div>
    <div class="dash-body">
      <div class="dash-line-1">
        <span v-if="variant === 'mention'" class="mention-verb">{{ mentionLabel }}</span>
        <span v-if="variant === 'mention'" class="mention-actor">{{ authorName ?? '(已删除用户)' }}</span>
        <span class="dash-title" :title="pageTitle">{{ pageTitle }}</span>
      </div>
      <div class="dash-line-2">
        <span
          v-if="spaceName"
          class="space-chip"
          :style="{ background: spaceColor ?? 'var(--text-3)' }"
          :title="spaceKind === 'personal' ? `${spaceName} (个人空间)` : `${spaceName} (团队空间)`"
        >{{ spaceName }}</span>
        <span v-if="variant === 'mention'" class="mention-comment">在评论里</span>
        <span v-if="updatedAt" class="time">{{ formatRelativeTime(updatedAt) }}</span>
      </div>
    </div>
    <span class="dash-arrow material-symbols-outlined" aria-hidden="true">chevron_right</span>
  </div>
</template>

<style scoped>
.dash-card {
  display: grid;
  grid-template-columns: 32px 1fr 20px;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid var(--border, #EBECF0);
  cursor: pointer;
  transition: background var(--duration-fast, 0.1s) ease-out;
}
.dash-card:hover { background: var(--bg-subtle, #F4F5F7); }
.dash-card:focus-visible {
  outline: 2px solid var(--focus-ring, #4C9AFF);
  outline-offset: -2px;
  border-radius: var(--radius-sm, 3px);
}
.dash-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: var(--text-2, #44546F);
}
.dash-icon .material-symbols-outlined {
  font-size: 24px;
  color: var(--text-2, #44546F);
}
.dash-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dash-line-1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
  color: var(--text-1, #172B4D);
  flex-wrap: wrap;
  min-width: 0;
}
.mention-verb {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-invert);
  background: var(--danger);
  padding: 1px 6px;
  border-radius: 8px;
  letter-spacing: 0.2px;
  flex-shrink: 0;
  line-height: 1.4;
}
.mention-actor {
  font-weight: 600;
  color: var(--text-1, #172B4D);
  flex-shrink: 0;
}
.dash-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1, #172B4D);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dash-line-2 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-3, #6B778C);
  flex-wrap: wrap;
}
.space-chip {
  display: inline-block;
  max-width: 160px;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  color: var(--text-invert);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: 0.2px;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}
.mention-comment {
  color: var(--text-3, #6B778C);
  font-size: 12px;
}
.time {
  color: var(--text-3, #6B778C);
  font-variant-numeric: tabular-nums;
}
.dash-arrow {
  color: var(--text-3, #6B778C);
  font-size: 18px;
}
.dash-card:hover .dash-arrow { color: var(--accent, #0052CC); }

.variant-mention .dash-icon .user-avatar {
  /* Mention 用 actor 头像,不需要再叠加 icon。 */
  width: 32px;
  height: 32px;
  font-size: 12px;
}
</style>