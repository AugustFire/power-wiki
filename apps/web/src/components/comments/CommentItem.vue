<script setup lang="ts">
/**
 * CommentItem — single rendered comment with optional replies.
 *
 *   - Header: author · relative time · always-visible icon buttons
 *     (reply for top-level; delete for author / admin)
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
import { ref, computed } from 'vue'
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
const error = ref<string | null>(null)

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
      <div class="ci-head">
        <span class="ci-author">{{ comment.authorName ?? comment.authorId }}</span>
        <span class="ci-time">{{ relativeTime(comment.createdAt) }}</span>
        <span v-if="comment.isEdited" class="ci-edited">(已编辑)</span>
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
      <div class="ci-text" v-html="renderBody()" />
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
  padding: 8px 0;
  border-bottom: 1px solid var(--border, #ebeef0);
}
.ci-body {
  min-width: 0;
}
.ci-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3, #5e6c84);
}
.ci-author {
  color: var(--text-1, #172b4d);
  font-weight: 600;
}
.ci-edited {
  font-size: 11px;
  color: var(--text-3, #5e6c84);
}
.ci-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
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
.ci-text {
  margin-top: 4px;
  color: var(--text-1, #172b4d);
  font-size: 14px;
  line-height: 1.5;
  word-wrap: break-word;
}
/* .mention-chip inherits from the global rule in components.css so editor
 * live view, saved HTML read view, and comment text all match. */
.ci-reply-composer {
  margin-top: 8px;
}
.ci-replies {
  margin-top: 8px;
  margin-left: 8px;
  padding-left: 12px;
  border-left: 2px solid var(--border, #ebeef0);
}
.ci-error {
  margin: 4px 0 0;
  color: var(--danger, #de350b);
  font-size: 12px;
}
</style>
