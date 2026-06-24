<script setup lang="ts">
defineProps<{
  icon: string
  title?: string
  disabled?: boolean
}>()
</script>

<template>
  <button class="icon-btn" :title="title" :disabled="disabled">
    <span class="material-symbols-outlined">{{ icon }}</span>
  </button>
</template>