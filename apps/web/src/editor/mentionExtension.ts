/**
 * Mention Tiptap extension — Stage 6.
 *
 * Inline atom node `<span class="mention-chip" data-user-id="xxx">@张三</span>`.
 * Inserted via the Suggestion plugin (char=`@`), which fires when the user
 * types `@` in the editor and shows a dropdown of candidate users with
 * access to the page's space.
 *
 * Wire-up:
 *   - `MentionList.vue` owns the popover, the search input, the candidate
 *     cache (`candidatesRef`), and the pageId it should query against
 *     (`pageIdRef` — set on `open()` from `useActivePageId()`). The
 *     `items` callback here just returns the cache; the search input
 *     drives refetches via `fetchCandidates`.
 *   - `MentionView.vue` is the NodeView (inline render, hover tooltip).
 *
 * No toolbar / BubbleMenu entry in v0 — typing `@` is the only entry
 * point (slash menu also has a `mention` item that inserts `@`).
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import MentionView from '@/components/editor/MentionView.vue'
import { MentionList } from '@/components/editor/MentionList.vue'
import {
  useMentionCandidates,
  type MentionItem,
} from '@/composables/useMentionCandidates'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'

const { candidatesRef, pageIdRef, fetchCandidatesImmediate: fetchCandidates } =
  useMentionCandidates()

export interface MentionAttrs {
  userId: string
  label: string
}

const suggestionKey = new PluginKey('mentionSuggestion')

export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      userId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-user-id'),
        renderHTML: (attrs) => {
          const userId = (attrs as MentionAttrs).userId
          if (!userId) return {}
          return { 'data-user-id': userId }
        },
      },
      label: {
        default: '',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-label') || el.textContent?.replace(/^@/, '') || '',
        renderHTML: (attrs) => {
          const label = (attrs as MentionAttrs).label
          return label ? { 'data-label': label } : {}
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span.mention-chip' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const userId = (node.attrs.userId as string) || ''
    const label = (node.attrs.label as string) || ''
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'mention-chip',
        'data-user-id': userId,
        'data-label': label,
      }),
      `@${label}`,
    ]
  },

  addNodeView() {
    // VueNodeViewRenderer wraps MentionView. MentionView reads
    // node.attrs.userId / .label and renders the inline chip with a
    // hover tooltip carrying the user's email.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return VueNodeViewRenderer(MentionView as any)
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '@',
        pluginKey: suggestionKey,
        allowSpaces: false,
        // Items are now driven by the popover's own search input (see
        // `MentionList.vue`). On the first call, the cache is empty, so
        // we await the initial fetch to avoid an empty flash. Subsequent
        // calls just return the cache — the search input's debounced
        // refetch keeps it fresh as the user types.
        items: async ({ query }: { query: string }) => {
          if (candidatesRef.value.length === 0 && pageIdRef) {
            await fetchCandidates(query)
          }
          return candidatesRef.value
        },
        render: () => {
          // The MentionList module owns the live Tippy instance + index
          // ref internally — we just call into open/update/onKeyDown/close
          // from the lifecycle callbacks Tiptap hands us.
          return {
            onStart: (props) => {
              MentionList.open(props)
            },
            onUpdate: (props) => {
              MentionList.update(props)
            },
            onKeyDown: (props) => {
              return MentionList.onKeyDown(props)
            },
            onExit: () => {
              MentionList.close()
            },
          }
        },
        command: ({
          editor,
          range,
          props,
        }: {
          editor: import('@tiptap/core').Editor
          range: { from: number; to: number }
          props: MentionItem
        }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: 'mention',
              attrs: { userId: props.id, label: props.name },
            })
            // Insert a trailing space so the user can keep typing.
            .insertContent(' ')
            .run()
        },
      }),
    ]
  },

  addCommands() {
    return {
      // Trigger the Suggestion popup programmatically (e.g. from SlashMenu
      // "mention" item). Inserts "@" and lets ProseMirror's input rules
      // open the suggestion — we don't need to do anything special.
      insertMention:
        () =>
        ({ commands }) =>
          commands.insertContent('@'),
    }
  },
})

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    mention: {
      insertMention: () => ReturnType
    }
  }
}
