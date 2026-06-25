<script setup lang="ts">
withDefaults(
  defineProps<{
    /** 头像里显示的文字(默认 "ME" = Me,后续接 user system 时换) */
    label?: string
    /** 24 / 28 / 32 */
    size?: 20 | 24 | 28 | 32
    /** tooltip */
    title?: string
  }>(),
  { label: 'ME', size: 24, title: '我' }
)
</script>

<template>
  <span
    class="user-avatar"
    :class="`size-${size}`"
    :title="title"
    :aria-label="title"
    role="img"
  >{{ label }}</span>
</template>

<style scoped>
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--text-invert);
  border-radius: 50%;
  font-weight: 600;
  font-family: inherit;
  flex-shrink: 0;
  user-select: none;
  line-height: 1;
}
.size-20 { width: 20px; height: 20px; font-size: 9px;  letter-spacing: 0.02em; }
.size-24 { width: 24px; height: 24px; font-size: 10px; letter-spacing: 0.02em; }
.size-28 { width: 28px; height: 28px; font-size: 11px; letter-spacing: 0.03em; }
.size-32 { width: 32px; height: 32px; font-size: 12px; letter-spacing: 0.04em; }
</style>

