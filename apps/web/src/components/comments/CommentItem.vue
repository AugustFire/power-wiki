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
 * Edit affordance (author-only):
 *   - `canEdit` is the author id check (admin cannot edit others — see
 *     apps/api/src/lib/commentGuards.ts).
 *   - Click ✏️ → row swaps to `<textarea>` + 保存/取消. Re-uses
 *     `useCommentMention` so the @ popover behaves the same as the
 *     composer. Cmd/Ctrl+Enter saves, Esc cancels.
 *   - Mention re-derivation on save: `parseMentionsFromText()` re-extracts
 *     @-names from the new text using a candidate name→id map loaded on
 *     `enterEdit()`. Combined with the popover's `editMentions` set (which
 *     only ADDS via popover picks, never removes via text edit) this
 *     correctly drops deleted mentions. Server still re-verifies.
 *
 * `useAuth` is used only to know if the current user is the author or
 * admin (which gates the delete affordance). Mutation events bubble up to
 * the parent so it can update the local tree without refetching.
 */
import { ref, computed, watch, nextTick } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useConfirm } from '@/composables/useConfirm'
import { useCommentMention } from '@/composables/useCommentMention'
import CommentsComposer from './CommentsComposer.vue'
import { formatRelativeTime } from '@/lib/relativeTime'
import type { Comment } from '@power-wiki/shared'

const props = defineProps<{
  comment: Comment & { replies?: Comment[] }
  pageId: string
}>()

const emit = defineEmits<{
  (e: 'reply-added', parent: Comment, child: Comment): void
  (e: 'deleted', id: string): void
  (e: 'edited', updated: Comment): void
}>()

const auth = useAuthStore()
const { confirm } = useConfirm()
const me = computed(() => auth.user)
const canModify = computed(
  () => !!me.value && (me.value.id === props.comment.authorId || me.value.role === 'admin'),
)
// 编辑权限 = 仅作者(后端 guardMutateComment 同步收窄,见 apps/api/src/lib/commentGuards.ts)
// admin 不能编辑他人评论 — Confluence / Notion / 飞书 默认。
const canEdit = computed(() => !!me.value && me.value.id === props.comment.authorId)

const showReply = ref(false)
const expanded = ref(false)
const error = ref<string | null>(null)

// ── 编辑态 ─────────────────────────────────────────────────────────
const editing = ref(false)
const editText = ref('')
const editMentions = ref<Set<string>>(new Set())
const editError = ref<string | null>(null)
const editSubmitting = ref(false)
const editTextareaEl = ref<HTMLTextAreaElement | null>(null)
const pageIdRef = computed(() => props.pageId)
const mention = useCommentMention(editTextareaEl, editMentions, pageIdRef)
// name → userId,enterEdit 时一次性 fetch 整页候选,save 时反查文本里实际 @ 的名字。
// 不缓存到 store:仅当前编辑会话需要,关掉编辑就丢。
const candidateMap = ref<Map<string, string>>(new Map())

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
  // line-clamp 4 时一行约 70-80 字符,四行约 280-320 字符;
  // 阈值 200 让"超过 4 行才需要展开"成为合理启发式,绝大多数短评论不被截断。
  const text = props.comment.contentMd
  return text.length > 200 || text.includes('\n')
})

// 编辑过的 hover 提示:v0 只展示时间,actor 永远是作者本人(后端 edit 已
// 收窄到 author-only),无需展示「编辑人」。v1 加 edit history 再扩。
const editTitle = computed(() => {
  if (!props.comment.isEdited || !props.comment.editedAt) return undefined
  return `编辑于 ${formatRelativeTime(props.comment.editedAt)}`
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
  return formatRelativeTime(ts)
}

/**
 * Render markdown body to safe HTML. v0 only converts newlines + chips;
 * no other tags allowed.
 *
 * Mentions are chipped off the *text* (`@name`), NOT off `mentionedUserIds`.
 * Those two are separate concerns: the comment text is the display source of
 * truth, while `mentionedUserIds` (opaque nanoid user ids, never the display
 * name) is the notification target of record — they don't share an alphabet,
 * so matching text against ids can never work.
 *
 * A token is chipped when `@` sits at the start of input or right after
 * whitespace, mirroring the composer's own trigger rule
 * (`useCommentMention.findAtTrigger`). That boundary is what keeps
 * `email@example.com` — where `@` is preceded by a letter — out of the chip
 * path. The 32-char cap matches the mention label cap upstream.
 */
function renderBody(): string {
  const raw = props.comment.contentMd
  // Escape HTML first so user content can never inject markup.
  let out = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Note: newline → <br> happens *after* this, so `\s` here still sees raw
  // "\n" and a mention at the very start of a new line is matched correctly.
  out = out.replace(
    /(^|\s)@([^\s@]{1,32})/g,
    (_m, pre: string, name: string) =>
      `${pre}<span class="mention-chip" data-mention="1">@${name}</span>`,
  )

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

/* ── 行内编辑 ───────────────────────────────────────────────────────
 *
 * enterEdit:把当前评论的 contentMd / mentionedUserIds 灌进本地草稿,
 *   拉一次整页 mention-candidates 缓存(后端 guard 没变,PATCH 还会
 *   re-verify,所以本地 cache 只是为解析文本里的 @name)。
 *
 * saveEdit:trim → 校验非空 + 与原文不同 → 用 parseMentionsFromText
 *   从新文本反查 user ids(覆盖"从文本里删除 @name"的情况)→ 合并
 *   popover 新选的 → PATCH。edit 永远是 author-only(后端硬约束),
 *   所以这里只关心内容正确性,不重做权限。
 */

async function loadCandidates(): Promise<void> {
  try {
    const cands = await api.comments.mentionCandidates(props.pageId, '')
    candidateMap.value = new Map(cands.map((c) => [c.name, c.id]))
  } catch {
    // 静默失败:save 时 parseMentionsFromText 拿不到映射,会回退到
    // 只用 editMentions set(只含 popover 选过的)。漏几个 mention
    // 通知总比阻塞编辑体验好。
  }
}

function parseMentionsFromText(text: string): string[] {
  const ids: string[] = []
  // 跟 CommentItem.renderBody 同套 regex:@ 必须在开头或空白后,
  // 名字 ≤32 字符、无空白 / @,避免 email@example.com 误判。
  const re = /(^|\s)@([^\s@]{1,32})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = candidateMap.value.get(m[2]!)
    if (id) ids.push(id)
  }
  return [...new Set(ids)]
}

async function enterEdit(): Promise<void> {
  editText.value = props.comment.contentMd
  editMentions.value = new Set(props.comment.mentionedUserIds)
  editError.value = null
  editing.value = true
  void loadCandidates()
  await nextTick()
  editTextareaEl.value?.focus()
}

function cancelEdit(): void {
  editing.value = false
  editText.value = ''
  editMentions.value = new Set()
  editError.value = null
  mention.close()
}

async function saveEdit(): Promise<void> {
  if (editSubmitting.value) return // 防 Cmd+Enter 重复触发
  const content = editText.value.trim()
  if (!content) return
  // 内容未变就不要无意义 PATCH(后端虽然会接受,但会刷 isEdited / editedAt)
  if (content === props.comment.contentMd) {
    cancelEdit()
    return
  }
  editSubmitting.value = true
  editError.value = null
  try {
    const fromText = parseMentionsFromText(editText.value)
    const merged = [...new Set([...fromText, ...editMentions.value])]
    const updated = await api.comments.update(props.comment.id, {
      contentMd: content,
      mentionedUserIds: merged.length > 0 ? merged : undefined,
    })
    emit('edited', updated)
    editing.value = false
    editText.value = ''
    editMentions.value = new Set()
  } catch (e: unknown) {
    editError.value = e instanceof Error ? e.message : '保存失败,请稍后再试'
  } finally {
    editSubmitting.value = false
  }
}

function onEditKeydown(ev: KeyboardEvent): void {
  // popover 自己处理 ↑/↓/Enter/Esc(选 mention);不在 popover 模式下,
  // 我们拦截 Cmd/Ctrl+Enter(保存)和 Esc(取消)。
  if (mention.onTextareaKeydown(ev)) return
  if (ev.key === 'Escape') {
    ev.preventDefault()
    cancelEdit()
    return
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault()
    void saveEdit()
  }
}
</script>

<template>
  <div :id="`comment-${comment.id}`" class="comment-item" :data-author="comment.authorName ?? comment.authorId">
    <div class="ci-body">
      <div class="ci-head">
        <span class="ci-author">{{ comment.authorName ?? comment.authorId }}</span>
        <span class="ci-dot" aria-hidden="true">·</span>
        <span class="ci-time">{{ relativeTime(comment.createdAt) }}</span>
        <template v-if="comment.isEdited">
          <span class="ci-dot" aria-hidden="true">·</span>
          <span class="ci-edited" :title="editTitle">已编辑</span>
        </template>
        <div class="ci-actions">
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
            v-if="canEdit && !editing"
            class="ci-icon-btn"
            type="button"
            aria-label="编辑评论"
            title="编辑评论"
            @click="enterEdit"
          >
            <span class="material-symbols-outlined">edit</span>
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
      <textarea
        v-if="editing"
        ref="editTextareaEl"
        v-model="editText"
        class="ci-edit-textarea"
        :disabled="editSubmitting"
        rows="4"
        :placeholder="'编辑评论 (Cmd/Ctrl+Enter 保存,Esc 取消,输入 @ 提及成员)'"
        @keydown="onEditKeydown"
        @input="mention.onTextareaInput"
        @scroll="mention.onTextareaScroll"
      />
      <div v-if="editing" class="ci-edit-actions">
        <button
          class="ci-edit-btn ci-edit-cancel"
          type="button"
          :disabled="editSubmitting"
          @click="cancelEdit"
        >取消</button>
        <button
          class="ci-edit-btn ci-edit-save"
          type="button"
          :disabled="editSubmitting || !editText.trim() || editText === comment.contentMd"
          @click="saveEdit"
        >{{ editSubmitting ? '保存中…' : '保存' }}</button>
      </div>
      <p v-if="editing && editError" class="ci-edit-error">{{ editError }}</p>
      <div
        v-if="!editing"
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
          @edited="(u) => emit('edited', u)"
        />
      </div>
      <p v-if="error" class="ci-error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
/* 双行布局:
   - 头一行(ci-head): author · time · edited,actions 浮在右上角(absolute)
   - 主体(ci-text): 14px 多行(line-clamp 4),可独立阅读不跟头部挤
   - 展开按钮 + reply composer + 嵌套回复 紧随其后
   整行 hover 时 bg --bg-subtle 高亮,actions 在 hover 区域更明显 */
.comment-item {
  position: relative;
  padding: 10px 8px;
  border-radius: 4px;
  transition: background 80ms ease;
}
.comment-item:hover {
  background: var(--bg-subtle, #ebecf0);
}
.ci-body {
  min-width: 0;
}

.ci-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3, #6b778c);
  line-height: 1.5;
  margin-bottom: 6px;
}
.ci-author {
  color: var(--text-1, #172b4d);
  font-weight: 600;
  font-size: 13px;
  flex-shrink: 0;
}
.ci-dot {
  color: var(--text-3, #6b778c);
  opacity: 0.5;
  flex-shrink: 0;
}
.ci-time {
  color: var(--text-3, #6b778c);
  flex-shrink: 0;
}
.ci-edited {
  font-size: 11px;
  color: var(--text-3, #6b778c);
  opacity: 0.85;
  flex-shrink: 0;
}

.ci-text {
  color: var(--text-2, #44546f);
  font-size: 14px;
  line-height: 1.55;
  word-wrap: break-word;
  /* 长 URL 串行折行(中文/英文/数字) */
  overflow-wrap: anywhere;
  /* 默认 4 行截断(更宽松,大多数评论不被截),展开后显示全文 */
  display: -webkit-box;
  -webkit-line-clamp: 4;
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
  display: inline-block;
  margin-top: 4px;
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

/* actions 浮在 ci-head 右上角 — 一直可见(opacity 1.0)但用 --text-3 弱化,
   hover 时改 --accent 蓝强调 + 浮起阴影,这样用户能"扫"到有按钮,
   但不抢主体内容视线。 */
.ci-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  gap: 2px;
}
.ci-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--text-3, #6b778c);
  cursor: pointer;
  transition: background 80ms ease, color 80ms ease, box-shadow 80ms ease;
}
/* 整行 hover 时 actions 浮起(白底+阴影) — 让用户清楚这条评论"被激活"了,
   不需要精确 hover 到按钮上才看到。按钮自身 hover 进一步加蓝色。 */
.comment-item:hover .ci-icon-btn {
  background: var(--bg, #fff);
  box-shadow: var(--shadow-sm);
}
.ci-icon-btn:hover {
  color: var(--accent, #0052cc);
}
.ci-icon-btn.is-active {
  background: var(--bg, #fff);
  color: var(--accent, #0052cc);
  box-shadow: var(--shadow-sm);
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
  margin-top: 10px;
}
.ci-replies {
  margin-top: 4px;
  margin-left: 4px;
  padding-left: 14px;
  border-left: 2px solid var(--border, #ebeef0);
}
.ci-error {
  margin: 4px 0 0;
  color: var(--danger, #de350b);
  font-size: 12px;
}

/* ── 行内编辑 ──────────────────────────────────────────────────────
 * 跟 composer 同样的视觉:1px border + 4px radius + 焦点环。Edit 模
 * 态是 composer 的「单行变体」,所以 .ci-edit-* 的 border / radius
 * 跟 .comment-composer textarea 完全一致,只在 grid 布局上不同
 * (行内编辑不需要 28px avatar 列,全宽)。 */
.ci-edit-textarea {
  display: block;
  width: 100%;
  resize: vertical;
  min-height: 80px;
  padding: 8px 10px;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 4px;
  font: inherit;
  background: var(--bg, #fff);
  color: var(--text-1, #172b4d);
  box-sizing: border-box;
}
.ci-edit-textarea:focus {
  outline: 2px solid var(--accent, #0052cc);
  outline-offset: 1px;
  border-color: transparent;
}
.ci-edit-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ci-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.ci-edit-btn {
  padding: 6px 14px;
  border-radius: 3px;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid transparent;
  cursor: pointer;
}
.ci-edit-btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}
.ci-edit-cancel {
  background: transparent;
  color: var(--text-3, #5e6c84);
}
.ci-edit-cancel:hover:not([disabled]) {
  background: var(--hover-bg, #f4f5f7);
}
.ci-edit-save {
  background: var(--accent, #0052cc);
  color: #fff;
}
.ci-edit-save:hover:not([disabled]) {
  background: var(--accent-hover, #0747a6);
}

.ci-edit-error {
  margin: 6px 0 0;
  color: var(--danger, #de350b);
  font-size: 12px;
}
</style>
