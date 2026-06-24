<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  editor: AnyEditor
  mode: 'text' | 'highlight' // 文字色 vs 高亮色
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

// 文字色:Atlassian 调色板,基于 tokens.css
const TEXT_COLORS = [
  { name: '默认', value: null, swatch: '#172B4D', ring: true },
  { name: '灰色', value: '#6B778C', swatch: '#6B778C' },
  { name: '红色', value: '#FF5630', swatch: '#FF5630' },
  { name: '橙色', value: '#FF8B00', swatch: '#FF8B00' },
  { name: '黄色', value: '#FFAB00', swatch: '#FFAB00' },
  { name: '绿色', value: '#36B37E', swatch: '#36B37E' },
  { name: '蓝色', value: '#0052CC', swatch: '#0052CC' },
  { name: '紫色', value: '#403294', swatch: '#403294' },
]

const HIGHLIGHT_COLORS = [
  { name: '无', value: null, swatch: 'transparent', ring: true },
  { name: '灰', value: '#DFE1E6', swatch: '#DFE1E6' },
  { name: '红', value: '#FFBDAD', swatch: '#FFBDAD' },
  { name: '橙', value: '#FFC400', swatch: '#FFC400' },
  { name: '黄', value: '#FFE380', swatch: '#FFE380' },
  { name: '绿', value: '#ABF5D1', swatch: '#ABF5D1' },
  { name: '蓝', value: '#79E2F2', swatch: '#79E2F2' },
  { name: '紫', value: '#B3ACF5', swatch: '#B3ACF5' },
]

const palette = computed(() => (props.mode === 'text' ? TEXT_COLORS : HIGHLIGHT_COLORS))

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
  border-radius: 3px;
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