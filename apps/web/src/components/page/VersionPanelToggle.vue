<script setup lang="ts">
/**
 * VersionPanelToggle — the "页面历史" button that goes into the
 * ReadView subheader next to star / export / edit.
 *
 * Mirrors `editor/ExportMenu.vue` `.ex-trigger` styling: icon + label on a
 * default `.btn` (not ghost, not primary). This matches the Confluence
 * reference at design/wiki-read.html:310:
 *   <button class="btn"><icon>history</icon> 页面历史</button>
 *
 * Local state ownership: the panel's presence is owned by the parent
 * (ReadView), this button just toggles a ref — mirrors the TocPanel
 * pattern. Keeps the URL stable and avoids a route-change flash.
 */
defineProps<{
  open: boolean
}>()
defineEmits<{
  toggle: []
}>()
</script>

<template>
  <button
    class="btn version-toggle"
    type="button"
    :class="{ open }"
    :aria-expanded="open"
    :aria-label="open ? '关闭版本历史' : '页面历史'"
    :title="open ? '关闭版本历史' : '页面历史'"
    @click="$emit('toggle')"
  >
    <span class="material-symbols-outlined icon-md">history</span>
    页面历史
  </button>
</template>

<style scoped>
/* Match ExportMenu's `.ex-trigger.open` micro-feedback: when the panel
   is up, the button shows the same pressed-background as a hovered btn. */
.version-toggle.open {
  background: var(--border);
  color: var(--text-1);
}
</style>
