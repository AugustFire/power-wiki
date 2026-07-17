<script setup lang="ts">
/**
 * CommentsComposer — single comment / reply composer.
 *
 * Plain `<textarea>` + Cmd/Ctrl+Enter to submit. @mention support
 * is provided by `useCommentMention` (Stage 7) — typing `@` opens
 * a Tippy popover anchored at the @ character, picking a candidate
 * inserts `@name ` and adds the user id to the `mentionedUserIds`
 * set forwarded to the server. The server re-verifies the ids
 * against `mention-candidates` (so a client tampering with the
 * payload is harmless).
 *
 * Used in two places:
 *   - Top-level comment (parentId = null)
 *   - Reply under an existing comment (parentId = comment.id)
 */
import { ref, computed } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useCommentMention } from '@/composables/useCommentMention'
import type { Comment } from '@power-wiki/shared'

const props = defineProps<{
  pageId: string
  parentId?: string | null
}>()

const emit = defineEmits<{
  (e: 'submitted', c: Comment): void
  (e: 'cancel'): void
}>()

const auth = useAuthStore()
const me = computed(() => auth.user)
const text = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
/** User ids extracted from the @-mention popover. Forwarded on submit
 *  and cleared after a successful create (so the next draft starts
 *  fresh). The server still re-verifies; this is for UI purposes. */
const mentionedUserIds = ref<Set<string>>(new Set())

// `useCommentMention` returns three event handlers that wire the
// textarea to the popover. Page id is forwarded via a computed ref
// so the candidate list auto-refreshes when the parent (e.g. a
// pinned sidebar) navigates between pages.
const pageIdRef = computed(() => props.pageId)
const mention = useCommentMention(textareaEl, mentionedUserIds, pageIdRef)

async function submit(): Promise<void> {
  const content = text.value.trim()
  if (!content) return
  submitting.value = true
  error.value = null
  try {
    const c = await api.comments.create({
      pageId: props.pageId,
      parentId: props.parentId ?? null,
      contentMd: content,
      mentionedUserIds: mentionedUserIds.value.size > 0
        ? Array.from(mentionedUserIds.value)
        : undefined,
    })
    text.value = ''
    mentionedUserIds.value = new Set()
    mention.close()
    emit('submitted', c)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '发送失败,请稍后再试'
  } finally {
    submitting.value = false
  }
}

function onKeyDown(ev: KeyboardEvent): void {
  // Let the mention popover handle its own keymap first (↑/↓/Enter/Esc).
  if (mention.onTextareaKeydown(ev)) return
  // Submit shortcut — only when no popover is open and no modifier
  // other than Cmd/Ctrl is held (Shift+Enter still inserts a newline).
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault()
    void submit()
  }
}

function onCancel(): void {
  text.value = ''
  mentionedUserIds.value = new Set()
  mention.close()
  emit('cancel')
}
</script>

<template>
  <div class="comment-composer" :data-role="props.parentId ? 'reply' : 'top'">
    <UserAvatar
      v-if="me"
      :label="me.name"
      :color="me.color"
      :size="28"
      :avatar-kind="me.avatarKind ?? null"
      :avatar-ref="me.avatarRef ?? null"
      :user-id="me.id"
      class="cc-avatar"
    />
    <textarea
      ref="textareaEl"
      v-model="text"
      :placeholder="props.parentId ? '回复…(输入 @ 提及成员)' : '评论 (Cmd/Ctrl+Enter 发送,输入 @ 提及成员)'"
      :disabled="submitting"
      rows="3"
      @keydown="onKeyDown"
      @input="mention.onTextareaInput"
      @scroll="mention.onTextareaScroll"
    />
    <div class="cc-actions">
      <button v-if="props.parentId" class="cc-btn cc-cancel" type="button" @click="onCancel">
        取消
      </button>
      <button
        class="cc-btn cc-submit"
        type="button"
        :disabled="submitting || !text.trim()"
        @click="submit"
      >
        {{ submitting ? '发送中…' : '发送' }}
      </button>
    </div>
    <p v-if="error" class="cc-error">{{ error }}</p>
  </div>
</template>

<style scoped>
/* border-top 把 list 和 composer 视觉分组,跟 section 的外部分割线区分开
   (list→composer 弱分割, section→上方文章强分割)。底部 padding 16 撑开。 */
.comment-composer {
  display: grid;
  grid-template-columns: 28px 1fr;
  grid-template-rows: auto auto auto;
  column-gap: 10px;
  row-gap: 8px;
  padding: 16px 0 20px;
  border-top: 1px solid var(--border, #ebeef0);
}
.cc-avatar {
  grid-row: 1;
  grid-column: 1;
}
.comment-composer textarea {
  grid-row: 1;
  grid-column: 2;
  resize: vertical;
  min-height: 60px;
  padding: 8px 10px;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 4px;
  font: inherit;
  background: var(--bg, #fff);
  color: var(--text-1, #172b4d);
}
.cc-actions {
  grid-row: 2;
  grid-column: 2;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.cc-btn {
  padding: 6px 14px;
  border-radius: 3px;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid transparent;
  cursor: pointer;
}
.cc-btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}
.cc-cancel {
  background: transparent;
  color: var(--text-3, #5e6c84);
}
.cc-cancel:hover {
  background: var(--hover-bg, #f4f5f7);
}
.cc-submit {
  background: var(--accent, #0052cc);
  color: #fff;
}
.cc-submit:hover:not([disabled]) {
  background: var(--accent-hover, #0747a6);
}
.cc-error {
  grid-row: 3;
  grid-column: 2;
  color: var(--danger, #de350b);
  font-size: 12px;
  margin: 0;
}
</style>
