<script setup lang="ts">
/**
 * CommentsSection — embeds in ReadView at the bottom of the article.
 *
 * Replaces the dead `<div class="comments">…<textarea disabled>` block
 * from `ReadView.vue` line 278. Owns the full comment tree for one page:
 *   - First-load fetch via `api.comments.list(pageId)`
 *   - Optimistic insert on composer "submitted"
 *   - Optimistic delete on item "deleted"
 *   - Reply bubbles up from item into the parent's replies array
 *
 * Level-2 only (v0): no nested replies-of-replies. The server enforces the
 * same shape — see `apps/api/src/routes/comments.ts`.
 */
import { onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import CommentItem from './CommentItem.vue'
import CommentsComposer from './CommentsComposer.vue'
import type { Comment } from '@power-wiki/shared'

type CommentWithReplies = Comment & { replies: Comment[] }

const props = defineProps<{
  pageId: string
}>()

const items = ref<CommentWithReplies[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await api.comments.list(props.pageId)
    items.value = result.items as CommentWithReplies[]
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '加载评论失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

function onSubmitted(c: Comment): void {
  // `parentId` is null for top-level (composer we render right below the
  // list) or the parent id for replies (composer inside the item). Mirror
  // the API response shape so ReplyItem can re-attach it.
  const withReplies: CommentWithReplies = { ...c, replies: [] }
  if (c.parentId) {
    const parent = items.value.find((p) => p.id === c.parentId)
    if (parent) {
      parent.replies = [...parent.replies, withReplies]
      return
    }
  }
  // Top-level (parentId null) → append to root list.
  items.value = [...items.value, withReplies]
}

/**
 * Bubble from a nested CommentItem: that component's composer submitted a
 * reply whose server response carries a fresh Comment. We re-attach it to
 * its parent's `replies[]` reactively so the new row renders immediately.
 *
 * `findInTree` is bounded: comments nest at most 2 levels (top-level +
 * replies) per `apps/api/src/routes/comments.ts` schema, so a linear scan
 * is cheap.
 */
function onReplyAdded(parent: Comment, child: Comment): void {
  const withReplies: CommentWithReplies = { ...child, replies: [] }
  const target = items.value.find((p) => p.id === parent.id)
    ?? findReplyInTree(parent.id)
  if (target) {
    target.replies = [...target.replies, withReplies]
    return
  }
  // Parent row vanished between submit and response (rare — e.g. soft-delete
  // by another user). Fall through to top-level so the user sees their
  // reply rather than losing it to a router refresh.
  items.value = [...items.value, withReplies]
}

function findReplyInTree(parentId: string): CommentWithReplies | null {
  for (const top of items.value) {
    const reply = top.replies.find((r) => r.id === parentId)
    if (reply) return reply as CommentWithReplies
  }
  return null
}

function onDeleted(id: string): void {
  // Walk the tree (root + each parent's replies), drop the row.
  for (let i = 0; i < items.value.length; i++) {
    if (items.value[i]!.id === id) {
      items.value.splice(i, 1)
      return
    }
  }
  for (const top of items.value) {
    const idx = top.replies.findIndex((r) => r.id === id)
    if (idx >= 0) {
      top.replies.splice(idx, 1)
      return
    }
  }
}
</script>

<template>
  <section class="comments-section">
    <h3 class="cs-title">评论 ({{ items.length }})</h3>

    <div v-if="loading && items.length === 0" class="cs-loading">加载评论中…</div>
    <div v-else-if="error" class="cs-error">{{ error }}</div>
    <div v-else-if="items.length === 0" class="cs-empty">还没有讨论,说点什么吧</div>

    <div v-else class="cs-list">
      <CommentItem
        v-for="c in items"
        :key="c.id"
        :comment="c"
        :page-id="pageId"
        @reply-added="onReplyAdded"
        @deleted="onDeleted"
      />
    </div>

    <CommentsComposer :page-id="pageId" @submitted="onSubmitted" />
  </section>
</template>

<style scoped>
.comments-section {
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--border, #dfe1e6);
}
.cs-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1, #172b4d);
  margin: 0 0 12px;
}
.cs-loading,
.cs-empty {
  font-size: 13px;
  color: var(--text-3, #5e6c84);
  padding: 8px 0;
}
.cs-error {
  font-size: 13px;
  color: var(--danger, #de350b);
  padding: 8px 0;
}
.cs-list {
  margin-bottom: 8px;
}
</style>
