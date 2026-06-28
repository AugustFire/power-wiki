/**
 * Shared state for "create" actions that originate in the right-side
 * context panel but render the inline create form in the main view.
 *
 * Why module-level refs: the context panel and the list view are sibling
 * RouterView slots — neither is a parent of the other, so we can't pass
 * props or slots between them. A module-level ref is the simplest way for
 * a panel button to toggle a view-side form.
 *
 * Only one entity's create form can be open at a time (the user is in one
 * route), but we keep them separate so each panel can independently own
 * its own state and there's no cross-talk if a route transition lands
 * mid-toggle.
 *
 * Stage 5d: `resetAll()` clears the three open-form flags. Called by
 * auth.logout() / auth.login() so the next user doesn't inherit an
 * already-open create form from the previous session.
 */
import { ref } from 'vue'

const showCreateUser = ref(false)
const showCreateGroup = ref(false)
const showCreateSpace = ref(false)

export function useManagerActions() {
  return {
    showCreateUser,
    showCreateGroup,
    showCreateSpace,
    resetAll,
  }
}

function resetAll(): void {
  showCreateUser.value = false
  showCreateGroup.value = false
  showCreateSpace.value = false
}