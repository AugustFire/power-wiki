/**
 * useActivePageId — module-level ref to the id of the page currently open
 * in the editor. The Mention extension's Suggestion plugin reads from this
 * ref so it can call `api.comments.mentionCandidates(activePageId, query)`
 * scoped to the user's permissions on the page being edited.
 *
 * Why module-level (not via the Tiptap editor instance):
 *   - The Mention extension is registered globally (in extensions.ts) and
 *     instantiated once per editor mount. The Suggestion plugin runs in
 *     ProseMirror without easy access to a "current pageId" prop.
 *   - EditView.vue `onMounted` writes the new page id; `onBeforeUnmount`
 *     clears it (the editor was unmounted, so any pending Suggestion that
 *     was about to refire sees an empty id).
 *
 * This matches the `useManagerStats` pattern of module-level refs that
 * multiple components can read without prop drilling.
 */
import { ref } from 'vue'

const activePageId = ref<string | null>(null)

export function useActivePageId() {
  return {
    activePageId,
    set(id: string | null): void {
      activePageId.value = id
    },
  }
}
