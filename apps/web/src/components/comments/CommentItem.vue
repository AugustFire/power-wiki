<script setup lang="ts">
/**
 * CommentItem — single rendered comment with optional replies.
 *
 *   - Header: avatar · author · relative time
 *   - Body: renders `contentMd` with @-mention promotion: only names
 *     listed in the row's `mentionedUserIds` are wrapped in
 *     `<span class="mention-chip">` (so a casual `email@example.com`
 *     in the body doesn't get a chip). The chip's appearance is
 *     controlled by the GLOBAL `.mention-chip` rule in
 *     `apps/web/src/styles/components.css` so it matches editor live
 *     view and saved-HTML read view exactly.
 *   - Footer: reply button (top-level only) + author/admin delete menu.
 *   - Replies: nested list, indented, rendered with the same component.
 *
 * The `<UserAvatar>` import path mirrors CommentsComposer. The `useAuth`
 * store is used only to know if the current user is the author or admin
 * (which gates the delete affordance). Mutation events bubble up to the
 * parent so it can update the local tree without refetching.
 */
import { ref, computed } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import UserAvatar from '@/components/ui/UserAvatar.vue'
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
const me = computed(() => auth.user)
const canModify = computed(
  () => !!me.value && (me.value.id === props.comment.authorId || me.value.role === 'admin'),
)

const showReply = ref(false)
const menuOpen = ref(false)
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
  menuOpen.value = false
  if (!confirm('删除这条评论?')) return
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
    <UserAvatar
      :label="comment.authorName ?? comment.authorId"
      :color="comment.authorColor ?? '#0052CC'"
      :size="32"
      class="ci-avatar"
    />
    <div class="ci-body">
      <div class="ci-head">
        <span class="ci-author">{{ comment.authorName ?? comment.authorId }}</span>
        <span class="ci-time">{{ relativeTime(comment.createdAt) }}</span>
        <span v-if="comment.isEdited" class="ci-edited">(已编辑)</span>
        <div class="ci-menu-wrap" v-if="canModify">
          <button
            class="ci-kebab"
            type="button"
            aria-label="更多操作"
            @click="menuOpen = !menuOpen"
          >
            <span class="material-symbols-outlined">more_vert</span>
          </button>
          <div v-if="menuOpen" class="ci-menu">
            <button type="button" @click="onDelete">删除</button>
          </div>
        </div>
      </div>
      <div class="ci-text" v-html="renderBody()" />
      <div class="ci-foot" v-if="!comment.parentId">
        <button class="ci-reply-btn" type="button" @click="showReply = !showReply">
          {{ showReply ? '取消回复' : '回复' }}
        </button>
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
  display: grid;
  grid-template-columns: 32px 1fr;
  column-gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border, #ebeef0);
}
.ci-avatar {
  grid-row: 1;
  grid-column: 1;
  margin-top: 2px;
}
.ci-body {
  grid-row: 1;
  grid-column: 2;
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
.ci-menu-wrap {
  margin-left: auto;
  position: relative;
}
.ci-kebab {
  background: transparent;
  border: 0;
  padding: 4px;
  border-radius: 3px;
  color: var(--text-3, #5e6c84);
  cursor: pointer;
}
.ci-kebab:hover {
  background: var(--hover-bg, #f4f5f7);
}
.ci-kebab .material-symbols-outlined {
  font-size: 16px;
}
.ci-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 120px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
  z-index: 20;
}
.ci-menu button {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  color: var(--danger, #de350b);
  font-size: 13px;
  cursor: pointer;
}
.ci-menu button:hover {
  background: var(--hover-bg, #f4f5f7);
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
.ci-foot {
  margin-top: 4px;
}
.ci-reply-btn {
  background: transparent;
  border: 0;
  color: var(--text-3, #5e6c84);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 0;
}
.ci-reply-btn:hover {
  color: var(--accent, #0052cc);
}
.ci-reply-composer {
  margin-top: 4px;
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
