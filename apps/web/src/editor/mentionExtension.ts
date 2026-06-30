/**
 * Mention Tiptap extension — Stage 6.
 *
 * Inline atom node `<span class="mention-chip" data-user-id="xxx">@张三</span>`.
 * Inserted via the Suggestion plugin (char=`@`), which fires when the user
 * types `@` in the editor and shows a dropdown of candidate users with
 * access to the page's space.
 *
 * Wire-up:
 *   - candidates come from `api.comments.mentionCandidates(pageId, query)`
 *     via `useActivePageId()` so we never leak users from spaces the
 *     current user can't access.
 *   - `MentionList.vue` is the dropdown component (keyboard nav).
 *   - `MentionView.vue` is the NodeView (inline render, hover tooltip).
 *
 * No toolbar / BubbleMenu entry in v0 — typing `@` is the only entry
 * point (slash menu also has a `mention` item that inserts `@`).
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import MentionView from '@/components/editor/MentionView.vue'
import { MentionList, type MentionItem } from '@/components/editor/MentionList.vue'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { api } from '@/lib/api'
import { useActivePageId } from '@/composables/useActivePageId'

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
        // Items are computed on-demand by reading the active page id;
        // a `AbortController` cancels stale fetches when the user keeps
        // typing or closes the suggestion.
        items: async ({ query }: { query: string }) => {
          const pageId = useActivePageId().activePageId.value
          if (!pageId) return [] as MentionItem[]
          try {
            const candidates = await api.comments.mentionCandidates(pageId, query)
            return candidates.map((c) => ({
              id: c.id,
              name: c.name,
              color: c.color,
              email: c.email,
            })) satisfies MentionItem[]
          } catch {
            return [] as MentionItem[]
          }
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
