<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { TEXT_COLOR_PALETTE, BG_COLOR_PALETTE } from '@/lib/colorPalettes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  editor: AnyEditor
  mode: 'text' | 'highlight' // 文字色 vs 高亮色
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const palette = computed(() => (props.mode === 'text' ? TEXT_COLOR_PALETTE : BG_COLOR_PALETTE))

const currentValue = ref<string | null>(null)

function readCurrent() {
  const e = props.editor
  if (!e) return
  if (props.mode === 'text') {
    currentValue.value = (e.getAttributes('textStyle').color as string | undefined) ?? null
  } else {
    currentValue.value = (e.getAttributes('highlight').color as string | undefined) ?? null
  }
}

onMounted(() => {
  readCurrent()
})

function applyColor(value: string | null) {
  const e = props.editor
  if (!e) return
  if (props.mode === 'text') {
    if (value === null) {
      e.chain().focus().unsetColor().run()
    } else {
      e.chain().focus().setColor(value).run()
    }
  } else {
    if (value === null) {
      e.chain().focus().unsetHighlight().run()
    } else {
      e.chain().focus().setHighlight({ color: value }).run()
    }
  }
  currentValue.value = value
  emit('close')
}
</script>

<template>
  <div class="color-popover" @mousedown.stop>
    <div class="cp-title">
      <span>{{ mode === 'text' ? '文字颜色' : '背景颜色' }}</span>
    </div>
    <div class="cp-grid">
      <button
        v-for="c in palette"
        :key="c.name"
        type="button"
        class="cp-swatch"
        :class="{ active: currentValue === c.value, ring: c.ring }"
        :title="c.name"
        @click="applyColor(c.value)"
      >
        <span
          class="cp-dot"
          :style="{
            background: c.swatch === 'transparent' ? 'transparent' : c.swatch,
            border: c.ring ? '1px solid var(--border-strong)' : 'none',
          }"
        ></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.color-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 8px;
  z-index: 100;
  width: 200px;
}
.cp-title {
  font-size: 12px;
  color: var(--text-3);
  padding: 0 4px 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}
.cp-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 4px;
}
.cp-swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.cp-swatch:hover { background: var(--bg-subtle); }
.cp-swatch.active { background: var(--accent-soft); }
.cp-dot {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}
</style>
