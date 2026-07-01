<script setup lang="ts">
/**
 * CommentsSection — embeds in ReadView at the bottom of the article.
 *
 * Replaces the dead `<div class="comments">…<textarea disabled>` block
 * from `ReadView.vue` line 278. Owns the full comment tree for one page:
 *   - First-load fetch via `usePaginatedList(api.comments.list(pageId))`
 *   - "Load more" footer when the server reports `hasMore`
 *   - Optimistic insert on composer "submitted"
 *   - Optimistic delete on item "deleted"
 *   - Reply bubbles up from item into the parent's replies array
 *
 * Level-2 only (v0): no nested replies-of-replies. The server enforces the
 * same shape — see `apps/api/src/routes/comments.ts`. `?limit` and
 * `?offset` paginate the top-level list; replies of each top-level row
 * are returned in full with the row.
 */
import { onMounted, ref, watch } from 'vue'
import CommentItem from './CommentItem.vue'
import CommentsComposer from './CommentsComposer.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import type { Comment } from '@power-wiki/shared'
import { api } from '@/lib/api'
import { usePaginatedList } from '@/composables/usePaginatedList'

type CommentWithReplies = Comment & { replies: Comment[] }

const props = defineProps<{
  pageId: string
}>()

/** 一次拿 20 条;评论密集的页面(产品文档)也只需两次拉取。 */
const PAGE_SIZE = 20

const { items, hasMore, loading, refreshing, error: paginatedError, reset, loadMore } =
  usePaginatedList<CommentWithReplies>(
    (q) => api.comments.list(props.pageId, q),
    { pageSize: PAGE_SIZE },
  )

const localError = ref<string | null>(null)

onMounted(() => {
  void reset()
})

/**
 * When the parent switches `pageId` (Router pushes to a new page), we
 * need to refetch from scratch — `reset()` keeps stale items visible
 * during the round-trip (B.3 pattern), but they're stale-data stale
 * (the previous page's comments), so a hard replace is the right
 * semantic. Same for the `paginatedError` -> local error message
 * conversion.
 */
watch(
  () => props.pageId,
  () => {
    localError.value = null
    void reset()
  },
)

watch(paginatedError, (e) => {
  localError.value = e instanceof Error ? e.message : '加载评论失败'
})

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
  // Top-level (parentId null) → append to root list. The new row sits
  // beyond the current `hasMore` window if the user has already
  // scrolled past the first page; that is fine — server still has it
  // and the next `loadMore` will fetch it (and de-dupe by id when
  // we get there).
  items.value = [...items.value, withReplies]
}

/**
 * Bubble from a nested CommentItem: that component's composer submitted a
 * reply whose server response carries a fresh Comment. We re-attach it to
 * its parent's `replies[]` reactively so the new row renders immediately.
 *
 * `findReplyInTree` is bounded: comments nest at most 2 levels (top-level +
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
    <h3 class="cs-title">
      评论 ({{ items.length }}{{ hasMore ? '+' : '' }})
    </h3>

    <div v-if="refreshing" class="cs-refreshing-bar" aria-hidden="true"></div>

    <div v-if="loading && items.length === 0" class="cs-skeleton" aria-hidden="true">
      <Skeleton :count="3" height="14px" />
    </div>
    <div v-else-if="localError" class="cs-error">{{ localError }}</div>
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

    <div v-if="hasMore" class="cs-load-more">
      <button
        type="button"
        class="cs-load-more-btn"
        :disabled="loading"
        @click="loadMore"
      >
        <span v-if="loading" class="cs-load-more-spinner" aria-hidden="true"></span>
        {{ loading ? '加载中…' : '加载更多评论' }}
      </button>
    </div>
    <div v-else-if="items.length > 0" class="cs-load-end">— 已加载全部 —</div>

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
.cs-empty,
.cs-load-end {
  font-size: 13px;
  color: var(--text-3, #5e6c84);
  padding: 8px 0;
  text-align: center;
}
.cs-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0 12px;
}
.cs-load-end {
  color: var(--text-3, #6b778c);
  font-size: 12px;
  padding: 4px 0 0;
}
.cs-error {
  font-size: 13px;
  color: var(--danger, #de350b);
  padding: 8px 0;
}
.cs-list {
  margin-bottom: 8px;
}

/* ─── load more ─────────────────────────────────────────────────── */
.cs-load-more {
  display: flex;
  justify-content: center;
  padding: 4px 0 12px;
}
.cs-load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 18px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2, #44546f);
  background: var(--bg, #fff);
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 16px;
  cursor: pointer;
  transition: background 80ms ease, border-color 80ms ease, color 80ms ease;
}
.cs-load-more-btn:hover:not(:disabled) {
  background: var(--bg-canvas, #f4f5f7);
  border-color: var(--border-strong, #c1c7d0);
  color: var(--text-1, #172b4d);
}
.cs-load-more-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.cs-load-more-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border, #dfe1e6);
  border-top-color: var(--accent, #0052cc);
  border-radius: 50%;
  animation: cs-spin 0.7s linear infinite;
}
@keyframes cs-spin {
  to { transform: rotate(360deg); }
}

/* ─── top refreshing bar (B.3 stale-items pattern) ──────────────── */
.cs-refreshing-bar {
  position: relative;
  height: 2px;
  background: transparent;
  margin: -8px 0 8px;
  overflow: hidden;
}
.cs-refreshing-bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--accent, #0052cc);
  animation: cs-progress 1.2s ease-in-out infinite;
}
@keyframes cs-progress {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(0%); }
  100% { transform: translateX(100%); }
}
</style>
