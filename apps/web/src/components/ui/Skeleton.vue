<script setup lang="ts">
/**
 * Skeleton — shimmer placeholder for loading states.
 *
 * Use when the actual content shape is known (e.g. an editor header
 * with avatar + 3 fields) so the chrome stays height-stable and the
 * load feels like a fade rather than a blank flash.
 *
 *   <Skeleton width="60%" height="20px" />
 *   <Skeleton :count="4" height="12px" />      // 4 stacked lines
 *   <Skeleton width="32px" height="32px" radius="50%" />  // avatar circle
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Width as CSS — default '100%' */
    width?: string | number
    /** Height as CSS — default '12px' */
    height?: string | number
    /** Border-radius as CSS — default 'var(--radius-sm, 3px)' */
    radius?: string | number
    /** Number of stacked lines (gaps via .skeleton-stack). 1 = single line. */
    count?: number
  }>(),
  { width: '100%', height: '12px', radius: 'var(--radius-sm, 3px)', count: 1 },
)

const style = computed(() => {
  const w = typeof props.width === 'number' ? `${props.width}px` : props.width
  const h = typeof props.height === 'number' ? `${props.height}px` : props.height
  const r = typeof props.radius === 'number' ? `${props.radius}px` : props.radius
  return { width: w, height: h, borderRadius: r }
})
</script>

<template>
  <div v-if="count > 1" class="skeleton-stack" aria-hidden="true">
    <span v-for="i in count" :key="i" class="skeleton" :style="style" />
  </div>
  <span v-else class="skeleton" :style="style" aria-hidden="true" />
</template>
