<script setup lang="ts">
/**
 * MySpaceView — thin route shim for /me.
 *
 * The user's "personal space" lives at a real space id in the spaces list;
 * the sidebar's "我的空间" entry, the topbar user menu, and bookmarks all
 * need a stable URL to point at. /me is that URL — its only job is to flip
 * the active space to the current user's personal space and bounce to / so
 * HomeView (already space-scoped) renders it.
 *
 * This component renders nothing — it just kicks off the navigation on
 * mount. Refreshing /me therefore behaves like refreshing /: the URL stays
 * canonical while the content stays consistent.
 */
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'

const auth = useAuthStore()
const spaces = useSpacesStore()
const pages = usePagesStore()
const router = useRouter()

onMounted(async () => {
  // Ensure data is loaded — if the user lands on /me before spaces.init()
  // resolves, the personal-space lookup would race and we'd fall through to
  // the first shared space. Both stores can safely re-init.
  if (!spaces.loaded.value) {
    try {
      await spaces.init()
    } catch {
      // fall through; replace() below will land somewhere safe
    }
  }
  const psid = auth.personalSpaceId
  if (psid && spaces.spaces.value.some((s) => s.id === psid)) {
    spaces.setActiveSpace(psid)
    void pages.refresh()
  }
  // Always end up on / — HomeView renders whatever the active space is.
  // Using replace so /me doesn't end up in the browser history stack.
  await router.replace('/')
})
</script>

<template>
  <div />
</template>