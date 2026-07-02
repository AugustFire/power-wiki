<script setup lang="ts">
/**
 * CommentItem — single rendered comment with optional replies.
 *
 *   - Row: author · time · content · (展开/收起) · actions
 *     全部塞同一行,长 content 用 -webkit-line-clamp: 1 截断 + "展开"按钮展开。
 *     旧布局是 header 一行 + content 一行(中间有 4px margin-top + 1.5 line-height
 *     浪费空白),改成单行后单条评论占的高度从 ~70px 降到 ~38px,密集评论滚动
 *     顺很多。
 *   - Body: renders `contentMd` with @-mention promotion: only names
 *     listed in the row's `mentionedUserIds` are wrapped in
 *     `<span class="mention-chip">` (so a casual `email@example.com`
 *     in the body doesn't get a chip). The chip's appearance is
 *     controlled by the GLOBAL `.mention-chip` rule in
 *     `apps/web/src/styles/components.css` so it matches editor live
 *     view and saved-HTML read view exactly.
 *   - Footer: reply composer (when toggled) + nested replies.
 *
 * No avatar in the list — kept the composer avatar only, per UX feedback
 * ("圆形头部太占行高"). Buttons are direct icons, not a kebab menu — the
 * old kebab was hard to dismiss.
 *
 * `useAuth` is used only to know if the current user is the author or
 * admin (which gates the delete affordance). Mutation events bubble up to
 * the parent so it can update the local tree without refetching.
 */
import { ref, computed, watch } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useConfirm } from '@/composables/useConfirm'
import CommentsComposer from './CommentsComposer.vue'
import type { Comment } from '@power-wiki/shared'

const props = defineProps<{
  comment: Comment & { replies?: Comment[] }
  pageId: string
}>()

const emit = defineEmits<{
  (e: 'reply-added', parent: Comment, child: Comment): void
  (e: 'deleted', id: string): void
}>()

const auth = useAuthStore()
const { confirm } = useConfirm()
const me = computed(() => auth.user)
const canModify = computed(
  () => !!me.value && (me.value.id === props.comment.authorId || me.value.role === 'admin'),
)

const showReply = ref(false)
const expanded = ref(false)
const error = ref<string | null>(null)

/**
 * 是否需要"展开"按钮的启发式:
 *   - 内容超过 60 字符(中英文在中等宽度容器里大概率单行装不下)
 *   - 或含显式换行(用户按了 Enter,自然多行,截了反而不全)
 *
 * 没用 ref + scrollHeight 测量 — 那条路需要临时取消 line-clamp 强制 reflow,
 * 每条评论挂载多一次;对评论密度高的页面不值。启发式误判最坏只是多一个
 * 点了没用的"展开"按钮,无副作用。
 */
const needsExpand = computed(() => {
  const text = props.comment.contentMd
  return text.length > 60 || text.includes('\n')
})

watch(
  () => props.comment.contentMd,
  () => {
    expanded.value = false
  },
)

function toggleExpand() {
  expanded.value = !expanded.value
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const sec = Math.round(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/**
 * Render markdown body to safe HTML. v0 only converts newlines + chips;
 * no other tags allowed. We deliberately do NOT wrap every `@xxx` in
 * contentMd: the rich-page editor's chip path stores `mentioned_user_ids`
 * JSONB on the comment row, and the chip rendering on those SELECT pages
 * belongs to the rendered chip. Here, we wrap only the names listed in
 * `mentionedUserIds` so that:
 *   - A casual typing of `email@example.com` in a comment doesn't get a chip.
 *   - A user typing `@bob` who's in the page's space gets the chip rendered
 *     with the real-mention variant.
 * Anything else is left as plain text (no `data-mention="0"` hint chip),
 * which matches how editors in v0 just typed `@bob` without using the
 * editor's Tiptap Suggestion.
 */
function renderBody(): string {
  const raw = props.comment.contentMd
  // Escape HTML first so user content can never inject markup.
  let out = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const labels = props.comment.mentionedUserIds
    .map((id) => id.trim())
    .filter((s) => s.length > 0 && s.length <= 32 && !/\s/.test(s))
  if (labels.length > 0) {
    const escapedLabels = labels.map((l) =>
      l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    const re = new RegExp(`@(${escapedLabels.join('|')})\\b`, 'g')
    out = out.replace(
      re,
      (m, name) =>
        `<span class="mention-chip" data-user-id="${name}" data-label="${name}" data-mention="1">@${name}</span>`,
    )
  }

  // Wrap newlines as <br>.
  return out.replace(/\n/g, '<br>')
}

async function onDelete(): Promise<void> {
  // 自研 confirm 弹窗 — 跟全站 admin 操作的删除确认一致(同一个 ConfirmDialog)
  const ok = await confirm({
    title: '删除这条评论?',
    message: '评论及其回复会一并删除,且无法恢复。',
    danger: true,
    confirmText: '删除',
    cancelText: '取消',
  })
  if (!ok) return
  error.value = null
  try {
    await api.comments.delete(props.comment.id)
    emit('deleted', props.comment.id)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '删除失败'
  }
}

function onReplyAdded(c: Comment): void {
  showReply.value = false
  emit('reply-added', props.comment, c)
}
</script>

<template>
  <div class="comment-item" :data-author="comment.authorName ?? comment.authorId">
    <div class="ci-body">
      <div class="ci-line">
        <span class="ci-author">{{ comment.authorName ?? comment.authorId }}</span>
        <span class="ci-time">{{ relativeTime(comment.createdAt) }}</span>
        <span v-if="comment.isEdited" class="ci-edited">(已编辑)</span>
        <div
          class="ci-text"
          :class="{ expanded }"
          v-html="renderBody()"
        />
        <button
          v-if="needsExpand"
          class="ci-expand-btn"
          type="button"
          @click="toggleExpand"
        >{{ expanded ? '收起' : '展开' }}</button>
        <div class="ci-head-actions">
          <button
            v-if="!comment.parentId"
            class="ci-icon-btn"
            type="button"
            :class="{ 'is-active': showReply }"
            :aria-label="showReply ? '取消回复' : '回复'"
            :title="showReply ? '取消回复' : '回复'"
            @click="showReply = !showReply"
          >
            <span class="material-symbols-outlined">reply</span>
          </button>
          <button
            v-if="canModify"
            class="ci-icon-btn ci-icon-btn-danger"
            type="button"
            aria-label="删除评论"
            title="删除评论"
            @click="onDelete"
          >
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>
      </div>
      <CommentsComposer
        v-if="showReply"
        :page-id="pageId"
        :parent-id="comment.id"
        class="ci-reply-composer"
        @submitted="onReplyAdded"
        @cancel="showReply = false"
      />
      <div v-if="comment.replies && comment.replies.length > 0" class="ci-replies">
        <CommentItem
          v-for="r in comment.replies"
          :key="r.id"
          :comment="r"
          :page-id="pageId"
          @reply-added="(p, c) => emit('reply-added', p, c)"
          @deleted="(id) => emit('deleted', id)"
        />
      </div>
      <p v-if="error" class="ci-error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.comment-item {
  /* 紧凑单行布局:padding 10→6,每条评论总高度从 ~70px 降到 ~38px */
  padding: 6px 0;
  border-bottom: 1px solid var(--border, #ebeef0);
}
.comment-item:last-child {
  border-bottom: 0;
}
.ci-body {
  min-width: 0;
}

/* 单行容器:author + time + (edited) + content(占主) + (展开/收起) + actions */
.ci-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3, #5e6c84);
}
.ci-author {
  color: var(--text-1, #172b4d);
  font-weight: 600;
  flex-shrink: 0;
}
.ci-time {
  /* 时间戳跟用户名拉开一点距离,避免粘在一起 */
  flex-shrink: 0;
}
.ci-edited {
  font-size: 11px;
  color: var(--text-3, #5e6c84);
  flex-shrink: 0;
}

.ci-text {
  flex: 1;
  min-width: 0;
  color: var(--text-1, #172b4d);
  font-size: 14px;
  line-height: 1.5;
  word-wrap: break-word;
  /* 长 URL 串行折行(中文/英文/数字) */
  overflow-wrap: anywhere;
  /* 单行截断 + 省略号;展开后改回 block 显示全文 */
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ci-text.expanded {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}

.ci-expand-btn {
  flex-shrink: 0;
  align-self: center;
  font-size: 12px;
  font-weight: 500;
  color: var(--accent, #0052cc);
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0;
  line-height: 1.5;
  white-space: nowrap;
}
.ci-expand-btn:hover {
  text-decoration: underline;
}

.ci-head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  /* 默认 actions 淡一些,hover 评论时再明显,减少视觉噪音 */
  opacity: 0.55;
  transition: opacity 80ms ease;
  flex-shrink: 0;
}
.comment-item:hover .ci-head-actions,
.comment-item:focus-within .ci-head-actions {
  opacity: 1;
}
/* 始终可见的图标按钮 — 替代之前的 kebab menu(那个太难点掉) */
.ci-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--text-3, #5e6c84);
  cursor: pointer;
  transition: background 80ms ease, color 80ms ease;
}
.ci-icon-btn:hover {
  background: var(--hover-bg, #f4f5f7);
  color: var(--accent, #0052cc);
}
.ci-icon-btn.is-active {
  background: var(--hover-bg, #f4f5f7);
  color: var(--accent, #0052cc);
}
.ci-icon-btn-danger:hover {
  color: var(--danger, #de350b);
}
.ci-icon-btn .material-symbols-outlined {
  font-size: 18px;
}
/* .mention-chip inherits from the global rule in mention.css so editor
 * live view, saved HTML read view, and comment text all match. */
.ci-reply-composer {
  margin-top: 8px;
}
.ci-replies {
  margin-top: 6px;
  margin-left: 4px;
  padding-left: 14px;
  border-left: 2px solid var(--border, #ebeef0);
}
.ci-error {
  margin: 4px 0 0;
  color: var(--danger, #de350b);
  font-size: 12px;
}
</style>
