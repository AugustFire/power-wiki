<script setup lang="ts">
import { computed, ref } from 'vue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = any

const props = defineProps<{
  editor: AnyEditor
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

interface Cat {
  id: string
  label: string
  emojis: string[]
}

const CATS: Cat[] = [
  {
    id: 'smile',
    label: '表情',
    emojis: [
      '😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊',
      '😋','😎','😍','😘','🥰','😗','🙂','🤗','🤩','🤔',
      '😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯',
      '😪','😫','😴','😌','😛','😜','😝','🤤','😒','😓',
      '😔','😕','🙃','😲','😖','😞','😟','😤','😢','😭',
      '😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶',
      '😳','🤪','😵','😡','😠','🤬','😷','🤒','🤕','🤢',
      '🤮','🤧','😇','🥳','🥴','🤠','🤡','🤥','🤫','🤭',
    ],
  },
  {
    id: 'gesture',
    label: '手势',
    emojis: [
      '👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉',
      '👆','🖕','👇','☝️','👋','🤚','🖐️','✋','🖖','👏',
      '🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾',
      '🫰','🫶','🫳','🫴','🫱','🫲','👂','👃','🧠','🫀',
      '🫁','🦷','🦴','👀','👁️','👅','👄','💋','🩸',
    ],
  },
  {
    id: 'people',
    label: '人物',
    emojis: [
      '👶','🧒','👦','👧','🧑','👨','👩','🧓','👴','👵',
      '👮','👷','💂','🕵️','👼','🎅','🤶','🧙','🧚','🧛',
      '🧜','🧝','💆','💇','🚶','🏃','💃','🕺','👯','🧖',
      '🧗','🏇','⛷️','🏂','🏌️','🏄','🚣','🏊','🤽','🚴',
      '🤹','🧘',
    ],
  },
  {
    id: 'animal',
    label: '动物',
    emojis: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
      '🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒',
      '🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇',
      '🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜',
      '🦂','🐢','🐍','🦎','🐙','🦑','🦐','🦞','🦀','🐡',
      '🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓',
    ],
  },
  {
    id: 'food',
    label: '食物',
    emojis: [
      '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐',
      '🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑',
      '🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅',
      '🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳',
      '🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟',
      '🍕','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕',
    ],
  },
  {
    id: 'object',
    label: '物品',
    emojis: [
      '⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','💽','💾','💿',
      '📀','📷','📸','📹','🎥','📺','📻','🎙️','⏰','⌛',
      '⏳','📡','🔋','🔌','💡','🔦','🕯️','💸','💵','💰',
      '💳','💎','🔧','🔨','⚒️','🛠️','⛏️','🔩','⚙️','⛓️',
      '🔫','💣','🧨','🔪','🛡️','🚬','⚰️','🔮','💈','🔭',
      '🔬','💊','💉','🩹','🩺','🧬','🛁','🚽','🚿','🧼',
      '🎁','🎀','🎉','🎊','🏆','🏅','🥇','🥈','🥉','⚽',
      '🏀','🎾','🏈','⚾','🎳','🏓','🏸','⛳','🎣','🎮',
    ],
  },
  {
    id: 'symbol',
    label: '符号',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔',
      '❣️','💕','💞','💓','💗','💖','💘','💝','💟','✨',
      '⭐','🌟','💫','⚡','🔥','💥','☀️','🌈','☁️','❄️',
      '☃️','⛄','🌊','💧','💦','🎵','🎶','🔔','🔕','📢',
      '📣','💬','💭','🗯️','♻️','✅','❌','❓','❗','💯',
      '🚫','🔞','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','☯️',
      '⚛️','♈','♉','♊','♋','♌','♍','♎','♏','♐',
    ],
  },
  {
    id: 'flag',
    label: '旗帜',
    emojis: [
      '🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇨🇳','🇭🇰',
      '🇹🇼','🇯🇵','🇰🇷','🇺🇸','🇬🇧','🇫🇷','🇩🇪','🇷🇺','🇮🇹','🇪🇸',
      '🇵🇹','🇳🇱','🇧🇪','🇸🇪','🇳🇴','🇫🇮','🇩🇰','🇮🇸','🇵🇱','🇺🇦',
      '🇹🇷','🇮🇳','🇻🇳','🇹🇭','🇸🇬','🇲🇾','🇮🇩','🇵🇭','🇦🇺','🇳🇿',
      '🇧🇷','🇦🇷','🇲🇽','🇨🇦','🇨🇭','🇦🇹','🇮🇪','🇬🇷','🇪🇬','🇿🇦',
    ],
  },
]

const active = ref(CATS[0].id)
const search = ref('')

const activeCat = computed(() => CATS.find((c) => c.id === active.value) ?? CATS[0])

const filteredEmojis = computed<string[]>(() => {
  const q = search.value.trim()
  if (!q) return activeCat.value.emojis
  // 跨分类搜索:把所有 emojis 展平去重
  const seen = new Set<string>()
  for (const c of CATS) {
    for (const e of c.emojis) seen.add(e)
  }
  // 简单 includes 匹配;emoji 视觉搜索很难做字符级匹配,先按子串
  return Array.from(seen).filter((e) => e.includes(q))
})

function insert(emoji: string) {
  const e = props.editor
  if (!e) return
  e.chain().focus().insertContent(emoji).run()
  emit('close')
}
</script>

<template>
  <div class="emoji-picker" @mousedown.stop>
    <div class="ep-tabs">
      <button
        v-for="c in CATS"
        :key="c.id"
        type="button"
        class="ep-tab"
        :class="{ active: c.id === active }"
        :title="c.label"
        @mousedown.prevent="active = c.id; search = ''"
      >
        {{ c.emojis[0] }}
      </button>
    </div>
    <div class="ep-search">
      <span class="material-symbols-outlined ep-search-icon">search</span>
      <input
        v-model="search"
        type="text"
        class="ep-search-input"
        placeholder="搜索表情…"
        @keydown.stop
      />
    </div>
    <div class="ep-grid">
      <button
        v-for="(e, idx) in (search.trim() ? filteredEmojis : activeCat.emojis)"
        :key="search.trim() ? `${e}-${idx}` : `${activeCat.id}-${idx}`"
        type="button"
        class="ep-emoji"
        :title="e"
        @mousedown.prevent="insert(e)"
      >{{ e }}</button>
      <div v-if="search.trim() && filteredEmojis.length === 0" class="ep-empty">
        没有匹配的表情
      </div>
    </div>
    <div class="ep-hint">点击插入 · Esc 关闭</div>
  </div>
</template>

<style scoped>
.emoji-picker {
  width: 320px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ep-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 1px;
  padding: 2px;
  border-bottom: 1px solid var(--border);
}
.ep-tab {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  font-size: 16px;
  line-height: 1;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ep-tab:hover { background: var(--bg-subtle); }
.ep-tab.active { background: var(--accent-soft); }

.ep-search {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.ep-search-icon {
  font-size: 14px;
  color: var(--text-3);
}
.ep-search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-1);
}
.ep-search-input::placeholder { color: var(--text-3); }

.ep-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 1px;
  max-height: 220px;
  overflow-y: auto;
  padding: 2px;
}
.ep-emoji {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ep-emoji:hover { background: var(--bg-subtle); }
.ep-emoji:active { background: var(--accent-soft); }

.ep-empty {
  grid-column: 1 / -1;
  padding: 16px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

.ep-hint {
  font-size: 10px;
  color: var(--text-3);
  text-align: right;
  padding: 2px 4px 0;
  border-top: 1px solid var(--border);
  margin-top: 2px;
}
</style>

