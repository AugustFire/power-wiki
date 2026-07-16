<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { isSafeHref } from '@/lib/sanitize'
import { useToast } from '@/composables/useToast'

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
const errorText = ref<string | null>(null)
const toast = useToast()

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
    errorText.value = null
    emit('close')
    return
  }
  // 输入无协议头时(如「power.wiki」),自动补 https:// —— 这是写链接
  // 的常见 UX。但补完后必须走 isSafeHref 二次校验,挡掉 javascript: /
  // data: 等被伪装成无协议头的危险 URL。
  const candidate = /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)
    ? href
    : `https://${href}`
  if (!isSafeHref(candidate)) {
    errorText.value = '链接格式无效,只支持 http(s) / mailto / tel / 内部页面链接'
    toast.error('链接格式无效')
    return
  }
  errorText.value = null
  e.chain().focus().extendMarkRange('link').setLink({ href: candidate }).run()
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

// 输入变化时清掉错误态,避免「报错后用户改对了还在红」
watch(url, () => {
  if (errorText.value) errorText.value = null
})
</script>

<template>
  <div v-if="open" class="link-popover" @mousedown.stop>
    <input
      ref="inputEl"
      v-model="url"
      type="url"
      placeholder="https://"
      class="link-input"
      :class="{ 'link-input-error': errorText }"
      @keydown="onKey"
    />
    <div v-if="errorText" class="link-error">{{ errorText }}</div>
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
.link-input-error { border-color: var(--danger, #de350b) !important; }
.link-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger, #de350b);
  line-height: 1.4;
}
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
