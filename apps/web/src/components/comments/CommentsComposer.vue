<script setup lang="ts">
/**
 * CommentsComposer — single comment / reply composer.
 *
 * Plain `<textarea>` + Cmd/Ctrl+Enter to submit. The Mention editor's
 * Suggestion only runs inside the page editor; for comments we keep
 * it simple — the server still re-validates any `mentionedUserIds` we
 * forward, but in v0 this composer doesn't auto-extract them (the page
 * editor's Tiptap Suggestion does).
 *
 * Used in two places:
 *   - Top-level comment (parentId = null)
 *   - Reply under an existing comment (parentId = comment.id)
 */
import { ref, computed } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import UserAvatar from '@/components/ui/UserAvatar.vue'
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
    })
    text.value = ''
    emit('submitted', c)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '发送失败,请稍后再试'
  } finally {
    submitting.value = false
  }
}

function onKeyDown(ev: KeyboardEvent): void {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    ev.preventDefault()
    void submit()
  }
}
</script>

<template>
  <div class="comment-composer" :data-role="props.parentId ? 'reply' : 'top'">
    <UserAvatar
      v-if="me"
      :label="me.name"
      :color="me.color"
      :size="28"
      class="cc-avatar"
    />
    <textarea
      v-model="text"
      :placeholder="props.parentId ? '回复…' : '评论 (Cmd/Ctrl+Enter 发送)'"
      :disabled="submitting"
      rows="3"
      @keydown="onKeyDown"
    />
    <div class="cc-actions">
      <button v-if="props.parentId" class="cc-btn cc-cancel" type="button" @click="emit('cancel')">
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
.comment-composer {
  display: grid;
  grid-template-columns: 28px 1fr;
  grid-template-rows: auto auto auto;
  column-gap: 10px;
  row-gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--border, #dfe1e6);
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
