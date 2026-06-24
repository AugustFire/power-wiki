<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'

// eslint-disable-next-line @typescript-eslint/no-explicitany
type AnyEditor = any

const props = defineProps<{
  node: { attrs: { language?: string | null } }
  editor: AnyEditor
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
}>()

// lowlight common 里的常用子集
const LANGS: { value: string; label: string }[] = [
  { value: 'plaintext', label: '纯文本' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'cpp', label: 'C / C++' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'sql', label: 'SQL' },
  { value: 'bash', label: 'Bash / Shell' },
  { value: 'yaml', label: 'YAML' },
]

const currentLabel = computed(() => {
  const l = props.node.attrs.language
  if (!l || l === 'plaintext' || l === 'plain') return '纯文本'
  return LANGS.find((x) => x.value === l)?.label ?? l
})

const copied = ref(false)
let copyTimer: number | null = null

async function copy(event: MouseEvent) {
  const btn = event.currentTarget as HTMLElement
  const wrapper = btn?.closest('.code-block') as HTMLElement | null
  if (!wrapper) return
  const code = wrapper.querySelector('code')
  const text = code?.textContent || ''
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch (err) {
    console.warn('[CodeBlockView] copy failed', err)
  }
}

// ─── 语言下拉 ──────────────────────────────────────────────
const langOpen = ref(false)
const langWrap = ref<HTMLElement | null>(null)

function toggleLang() {
  langOpen.value = !langOpen.value
}

function pickLang(value: string) {
  // 'plaintext' 用 null 表示无语言(lowlight 不识别 plaintext)
  props.updateAttributes({ language: value === 'plaintext' ? null : value })
  langOpen.value = false
}

function onDocMousedown(e: MouseEvent) {
  if (!langOpen.value) return
  const target = e.target as Node
  if (langWrap.value && !langWrap.value.contains(target)) {
    langOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown))
</script>

<template>
  <NodeViewWrapper class="code-block">
    <div class="code-block-header">
      <div ref="langWrap" class="cb-lang-wrap" :class="{ open: langOpen }">
        <button
          type="button"
          class="cb-lang-btn"
          :aria-expanded="langOpen"
          aria-haspopup="menu"
          title="切换语言"
          @click="toggleLang"
          @mousedown.stop
        >
          <span>{{ currentLabel }}</span>
          <span class="material-symbols-outlined chev">expand_more</span>
        </button>
        <div v-if="langOpen" class="cb-lang-menu">
          <button
            v-for="l in LANGS"
            :key="l.value"
            type="button"
            class="cb-lang-opt"
            :class="{ active: (node.attrs.language ?? 'plaintext') === l.value }"
            @mousedown.prevent="pickLang(l.value)"
          >
            {{ l.label }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="code-block-copy"
        :class="{ copied }"
        @mousedown.stop
        @click="copy"
        :aria-label="copied ? '已复制' : '复制代码'"
        :title="copied ? '已复制' : '复制代码'"
      >
        <span class="material-symbols-outlined copy-icon" style="font-size:14px">
          {{ copied ? 'check' : 'content_copy' }}
        </span>
        <span>{{ copied ? '已复制' : '复制' }}</span>
      </button>
    </div>
    <pre><NodeViewContent as="code" :class="node.attrs.language ? `language-${node.attrs.language}` : null" /></pre>
  </NodeViewWrapper>
</template>

<style scoped>
.code-block {
  margin: 16px 0;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-code);
  border: 1px solid var(--border);
}
.code-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 4px 4px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  user-select: none;
}

/* 语言下拉触发按钮 */
.cb-lang-wrap { position: relative; }
.cb-lang-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: #9CA3AF;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  font-family: var(--font-mono);
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.1s, color 0.1s;
}
.cb-lang-btn:hover { background: rgba(255, 255, 255, 0.06); color: #E5E7EB; }
.cb-lang-btn .chev {
  font-size: 14px;
  transition: transform 150ms ease;
}
.cb-lang-wrap.open .cb-lang-btn .chev { transform: rotate(180deg); }

/* 下拉菜单 */
.cb-lang-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 160px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 4px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.cb-lang-opt {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  white-space: nowrap;
}
.cb-lang-opt:hover { background: var(--bg-subtle); color: var(--text-1); }
.cb-lang-opt.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }

.code-block-lang {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #9CA3AF;
  font-family: var(--font-mono);
}
.code-block-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: #9CA3AF;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s, color 0.15s;
  font-family: inherit;
}
.code-block-copy:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #E5E7EB;
}
.code-block-copy.copied {
  color: #C3E88D;
}
.code-block :deep(pre) {
  margin: 0;
  padding: 16px;
  background: transparent;
  color: #B3BAC5;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  border-radius: 0;
}
.code-block :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
}
</style>