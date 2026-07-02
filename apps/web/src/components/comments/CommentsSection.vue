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
import { computed, onMounted, ref, watch } from 'vue'
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

/** 一次拿 10 条;评论密集的页面(产品文档)也只需两次拉取。 */
const PAGE_SIZE = 10

const { items, hasMore, loading, refreshing, error: paginatedError, reset, loadMore } =
  usePaginatedList<CommentWithReplies>(
    (q) => api.comments.list(props.pageId, q),
    { pageSize: PAGE_SIZE },
  )

/**
 * 显示窗口 — 折叠语义(expanded 状态机):
 *   - expanded=false (默认): 永远只显示前 PAGE_SIZE 条,不论 items.value 多大
 *   - expanded=true:          显示 items.value 全部
 *   - "加载更多": 调 loadMore() 拉下一页(items 增多);expanded 不变,新加载的不可见
 *                       直到用户点"展开剩余 N 条"
 *   - "展开剩余":   expanded = true
 *   - "收起":       expanded = false,固定回到前 PAGE_SIZE 条(不逐步 -PAGE_SIZE)
 * 切换 pageId 时重置 expanded=false,跟 `reset()` 同步语义。
 */
const expanded = ref(false)
const visibleItems = computed(() =>
  expanded.value ? items.value : items.value.slice(0, PAGE_SIZE),
)
const hiddenLoaded = computed(() => Math.max(0, items.value.length - PAGE_SIZE))
const canLoadMore = computed(() => hasMore.value)
const canExpand = computed(
  () => !hasMore.value && hiddenLoaded.value > 0 && !expanded.value,
)
const canCollapse = computed(() => expanded.value)

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
    expanded.value = false
    void reset()
  },
)

watch(paginatedError, (e) => {
  localError.value = e instanceof Error ? e.message : '加载评论失败'
})

/**
 * 加载更多:pageSize 固定 10,调一次 usePaginatedList.loadMore() 就 +10。
 * 关键:加载完后 expanded=true,这样新拉到的 10 条立即可见(否则 expanded=false
 * 时 visibleItems = items.slice(0, PAGE_SIZE) 永远只显示前 10,用户点按钮看不到
 * 任何变化 — 那是 bug)。
 *
 * "展开剩余"按钮也是同样的最终态(expanded=true),所以两者合并逻辑:只要用户
 * 想看到更多,expanded 就开起来。
 */
async function onLoadMore(): Promise<void> {
  if (hasMore.value) {
    await loadMore()
  }
  expanded.value = true
}

function onExpand(): void {
  expanded.value = true
}

function onCollapse(): void {
  expanded.value = false
}

function onSubmitted(c: Comment): void {
  // `parentId` is null for top-level (composer we render right below the
  // list) or the parent id for replies (composer inside the item). Mirror
  // the API response shape so ReplyItem can re-attach it.
  // Server returns rows newest-first (desc by createdAt), so the new row
  // goes to the FRONT of the list (unshift), not the back.
  const withReplies: CommentWithReplies = { ...c, replies: [] }
  if (c.parentId) {
    const parent = items.value.find((p) => p.id === c.parentId)
    if (parent) {
      parent.replies = [withReplies, ...parent.replies]
      return
    }
  }
  // Top-level (parentId null) → prepend to root list. If the user has
  // already scrolled past the first page and the new row would land
  // beyond the `hasMore` window, that's fine — server still has it and
  // the next `loadMore` will fetch (and de-dupe by id when we get there).
  items.value = [withReplies, ...items.value]
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
    target.replies = [withReplies, ...target.replies]
    return
  }
  // Parent row vanished between submit and response (rare — e.g. soft-delete
  // by another user). Fall through to top-level so the user sees their
  // reply rather than losing it to a router refresh.
  items.value = [withReplies, ...items.value]
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
        v-for="c in visibleItems"
        :key="c.id"
        :comment="c"
        :page-id="pageId"
        @reply-added="onReplyAdded"
        @deleted="onDeleted"
      />
    </div>

    <div v-if="canLoadMore || canExpand || canCollapse" class="cs-load-more">
      <button
        v-if="canLoadMore"
        type="button"
        class="cs-load-more-btn"
        :disabled="loading"
        @click="onLoadMore"
      >
        <span v-if="loading" class="cs-load-more-spinner" aria-hidden="true"></span>
        {{ loading ? '加载中…' : '加载更多评论' }}
      </button>
      <button
        v-else-if="canExpand"
        type="button"
        class="cs-load-more-btn"
        @click="onExpand"
      >展开剩余 {{ hiddenLoaded }} 条</button>
      <!-- "收起"独立 v-if,可以跟"加载更多"并排显示 —
           展开状态下用户既能继续加载,也能折叠回 10 条 -->
      <button
        v-if="canCollapse"
        type="button"
        class="cs-load-more-btn"
        @click="onCollapse"
      >收起</button>
    </div>
    <div v-else-if="items.length > 0 && !canCollapse" class="cs-load-end">— 已加载全部 —</div>

    <CommentsComposer :page-id="pageId" @submitted="onSubmitted" />
  </section>
</template>

<style scoped>
/* 跟主区靠一条文字色横线 + 大间距区分:
   - 不用背景色块(避免视觉补丁感)
   - 不用 box-shadow / border / radius(去掉卡片感,跟文章主区融为一体)
   - 标题字号 16 让"评论区"作为独立区域仍然可识别
   - hover bg --bg-subtle 仍是行级高亮的关键 */
.comments-section {
  margin-top: 56px;
  border-top: 1px solid var(--text-3, #6b778c);
  background: transparent;
}
.cs-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1, #172b4d);
  margin: 0;
  padding: 28px 0 16px;
}
.cs-loading,
.cs-empty {
  font-size: 13px;
  color: var(--text-3, #6b778c);
  padding: 12px 0 20px;
  text-align: center;
}
.cs-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0 12px;
}
.cs-load-end {
  color: var(--text-3, #6b778c);
  font-size: 12px;
  padding: 4px 0 8px;
  text-align: center;
}
.cs-error {
  font-size: 13px;
  color: var(--danger, #de350b);
  padding: 8px 0;
}
.cs-list {
  margin: 0;
  padding: 0 0 4px;
}

/* ─── load more ─────────────────────────────────────────────────── */
.cs-load-more {
  display: flex;
  justify-content: center;
  gap: 8px;
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
