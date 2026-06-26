<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /**
     * Text shown inside the avatar. If a full name is given, the initials
     * are auto-derived (first letter of the first two words). Otherwise the
     * literal label is shown — keeps backwards compat with the old "ME" prop.
     */
    label?: string
    /** 20 / 24 / 28 / 32 / 36 / 40 / 48 / 56 */
    size?: 20 | 24 | 28 | 32 | 36 | 40 | 48 | 56
    /** tooltip */
    title?: string
    /** Background colour. Defaults to the brand accent. */
    color?: string
  }>(),
  { label: 'ME', size: 24, title: '我', color: '' },
)

const initials = computed(() => {
  const trimmed = props.label.trim()
  if (!trimmed) return '?'
  // If it looks like a full name (has whitespace or CJK + ASCII mix), take up to
  // first two leading chars. CJK names like "张三" → "张"; English "Alice Smith" → "AS".
  // Single-token labels (legacy "ME") pass through unchanged.
  if (trimmed.length <= 3 && !/\s/.test(trimmed)) return trimmed.toUpperCase()
  // Split on whitespace first; fall back to first two chars if no whitespace.
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
})
</script>

<template>
  <span
    class="user-avatar"
    :class="`size-${size}`"
    :title="title"
    :aria-label="title"
    role="img"
    :style="color ? { background: color } : undefined"
  >{{ initials }}</span>
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
.size-36 { width: 36px; height: 36px; font-size: 13px; letter-spacing: 0.04em; }
.size-40 { width: 40px; height: 40px; font-size: 14px; letter-spacing: 0.05em; }
.size-48 { width: 48px; height: 48px; font-size: 16px; letter-spacing: 0.05em; }
.size-56 { width: 56px; height: 56px; font-size: 18px; letter-spacing: 0.05em; }
</style>