<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'

// eslint-disable-next-line @typescript-eslint/no-explicitany
type AnyEditor = any

const props = defineProps<{
  editor: AnyEditor
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const url = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  // 组件只在 open=true 时挂载,这里直接读当前 link href
  const e = props.editor
  if (e) url.value = (e.getAttributes('link').href as string | undefined) ?? ''
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
})

const hasLink = computed(() => !!props.editor?.isActive('link'))

function apply() {
  const e = props.editor
  if (!e) return
  const href = url.value.trim()
  if (!href) {
    // 空输入视同"移除链接"
    e.chain().focus().extendMarkRange('link').unsetLink().run()
  } else {
    const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)
      ? href
      : `https://${href}`
    e.chain().focus().extendMarkRange('link').setLink({ href: safe }).run()
  }
  emit('close')
}

function remove() {
  const e = props.editor
  if (!e) return
  e.chain().focus().extendMarkRange('link').unsetLink().run()
  emit('close')
}

function cancel() {
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    apply()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}
</script>

<template>
  <div v-if="open" class="link-popover" @mousedown.stop>
    <input
      ref="inputEl"
      v-model="url"
      type="url"
      placeholder="https://"
      class="link-input"
      @keydown="onKey"
    />
    <div class="link-actions">
      <button class="lp-btn ghost" type="button" @click="cancel">取消</button>
      <button v-if="hasLink" class="lp-btn danger" type="button" @click="remove">
        移除链接
      </button>
      <button class="lp-btn primary" type="button" @click="apply">应用</button>
    </div>
  </div>
</template>

<style scoped>
.link-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 280px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 10px;
  z-index: 200;
}
.link-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-family: inherit;
  background: var(--bg);
  color: var(--text-1);
  outline: none;
  box-sizing: border-box;
}
.link-input:focus { border-color: var(--accent); }
.link-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  justify-content: flex-end;
}
.lp-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.lp-btn:hover { background: var(--bg-subtle); }
.lp-btn.primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.lp-btn.primary:hover { background: var(--accent-hover); }
.lp-btn.danger {
  color: var(--danger);
  border-color: var(--danger);
}
.lp-btn.danger:hover { background: var(--danger-soft); }
</style>
