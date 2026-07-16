<script setup lang="ts">
/**
 * CheatSheetModal — ⌘/ 唤起的速查表.
 *
 * 两栏内容:
 *  1. 键盘快捷键 — StarterKit keymap 全开(见 CLAUDE.md「键盘快捷键放开」),
 *     散落在编辑器 / 全局,集中列出。
 *  2. 不容易发现的功能 — UI 里没明示入口的隐藏功能:
 *     slash 菜单、@ mention、DragHandle、Ctrl+S 手动存档、文件拖入、Tab
 *     缩进、Markdown 输入规则、复制页面、历史 / 回滚等。
 *
 * 唯一目的是让新人知道"快捷键 / 隐藏能力存在"。视觉对齐 Atlassian Atlas
 * 设计语(参考 design/wiki-read.html),其余沿用现有 modal 模式:
 * Teleport to body、backdrop click 关闭、Escape 关闭、body 锁滚。
 * 开关状态在 uiStore.cheatSheetOpen,⌘/ 在 App.vue 全局 keydown 触发。
 */
import { useUiStore } from '@/stores/ui'
import { storeToRefs } from 'pinia'
import { MOD_KEY as MOD } from '@/lib/platform'
import { useBodyLock } from '@/composables/useBodyLock'
import { useEscape } from '@/composables/useEscape'

const uiStore = useUiStore()
const { cheatSheetOpen } = storeToRefs(uiStore)

type Shortcut = { keys: string[]; desc: string }
type Group = { title: string; items: Shortcut[] }
type Tip = { icon: string; title: string; desc: string }
const shortcutGroups: Group[] = [
  {
    title: '全局',
    items: [
      { keys: [MOD,'K'], desc: '搜索所有页面' },
      { keys: ['/'], desc: '搜索(Vim 风格,仅非输入框聚焦)' },
      { keys: [MOD,'/'], desc: '打开 / 关闭这张速查表(读 / 编辑模式都可用;Shift+/ = ? 是同一个键)' },
      { keys: [MOD,'S'], desc: '立即存档为新版本快照' },
    ],
  },
  {
    title: '编辑',
    items: [
      { keys: [MOD,'B'], desc: '加粗' },
      { keys: [MOD,'I'], desc: '斜体' },
      { keys: [MOD,'U'], desc: '下划线' },
      { keys: [MOD,'Z'], desc: '撤销' },
      { keys: [MOD,'⇧', 'Z'], desc: '重做' },
    ],
  },
  {
    title: '结构',
    items: [
      { keys: [MOD,'⌥', '1'], desc: '一级标题' },
      { keys: [MOD,'⌥', '2'], desc: '二级标题' },
      { keys: [MOD,'⇧', '7'], desc: '有序列表' },
      { keys: [MOD,'⇧', '8'], desc: '无序列表' },
      { keys: [MOD,'⇧', '9'], desc: '引用块' },
      { keys: ['Tab'], desc: '列表 / Task 缩进一级' },
      { keys: ['⇧', 'Tab'], desc: '列表 / Task 反向缩进' },
    ],
  },
]

/**
 * 隐藏功能清单.
 *
 * 挑选标准:UI 没有明示入口,但实际存在且高频有用。每条 1 句话 + 图标,
 * 命中率高的功能放在前面(读者扫读从左上开始)。描述避免「您可以…」之类的
 * 客套,直陈操作。
 */
const tips: Tip[] = [
  {
    icon: 'menu',
    title: '行首输 / 唤起块菜单',
    desc: '插入标题 / Callout / Toggle / 表格 / 附件 / 代码块 等块级元素。',
  },
  {
    icon: 'alternate_email',
    title: '@ 通知同事',
    desc: '编辑器里输入 @ 选择同事,会发通知 + 在评论里 chip 标记。',
  },
  {
    icon: 'drag_indicator',
    title: '拖块重排',
    desc: 'hover 段落 / 标题左侧的 ⋮⋮ 手柄,拖到新位置即可重排整块。',
  },
  {
    icon: 'file_upload',
    title: '拖入文件 = 附件',
    desc: '把图片 / PDF / Office 文件直接拖进编辑器即可上传。',
  },
  {
    icon: 'save',
    title: 'Ctrl+S 立即存档',
    desc: '平时是 30 秒静默打版本快照,这条快捷键是手动打 checkpoint。',
  },
  {
    icon: 'code',
    title: 'Markdown 直接打字',
    desc: '##  + 空格转标题、**加粗**、- 无序、1. 有序、> 引用皆自动识别。',
  },
  {
    icon: 'content_copy',
    title: '复制整个页面',
    desc: 'ReadView 顶部 ⋯ 菜单里有「复制本页」,复制到当前 sibling 下方。',
  },
  {
    icon: 'history',
    title: '看历史 / 回滚',
    desc: '页面顶部 ⋯ → 历史,选任一版本可 restore 到当前(字面级 diff)。',
  },
  {
    icon: 'toc',
    title: '右侧目录自动跟读',
    desc: 'ReadView 右侧 TOC 实时高亮你正在看的 heading,平滑滚动 + 深锚链接。',
  },
  {
    icon: 'notifications',
    title: '顶栏铃铛 = 通知中心',
    desc: 'mention / reply / 评论 30 秒轮询,点行直接跳到对应评论锚点。',
  },
]

useBodyLock(cheatSheetOpen)
useEscape(cheatSheetOpen, () => uiStore.closeCheatSheet())
</script>

<template>
  <Teleport to="body">
    <transition name="cheat-fade">
      <div
        v-if="cheatSheetOpen"
        class="cheat-backdrop"
        @mousedown.self="uiStore.closeCheatSheet()"
      >
        <div
          class="cheat-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cheat-title"
          @mousedown.stop
        >
          <header class="cheat-head">
            <div>
              <h2 id="cheat-title" class="cheat-title">速查表</h2>
              <p class="cheat-subtitle">
                不好发现的快捷键和小技巧集中在这里。<kbd class="cheat-mini-kbd">{{ MOD }}</kbd>/ 任意处唤起。
              </p>
            </div>
            <button
              class="cheat-close"
              type="button"
              aria-label="关闭"
              @click="uiStore.closeCheatSheet()"
            >
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>

          <div class="cheat-body">
            <!-- 左:键盘快捷键 -->
            <section class="cheat-col cheat-col-keys">
              <h3 class="cheat-col-title">键盘快捷键</h3>
              <div class="cheat-keys-groups">
                <div v-for="g in shortcutGroups" :key="g.title" class="cheat-group">
                  <h4 class="cheat-group-title">{{ g.title }}</h4>
                  <ul class="cheat-key-list">
                    <li v-for="(s, i) in g.items" :key="i" class="cheat-key-row">
                      <span class="cheat-desc">{{ s.desc }}</span>
                      <span class="cheat-keys">
                        <kbd v-for="(k, ki) in s.keys" :key="ki" class="cheat-kbd">{{ k }}</kbd>
                      </span>
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <!-- 右:不容易发现的功能 -->
            <section class="cheat-col cheat-col-tips">
              <h3 class="cheat-col-title">不容易发现的功能</h3>
              <ul class="cheat-tip-list">
                <li v-for="t in tips" :key="t.title" class="cheat-tip">
                  <span class="cheat-tip-icon material-symbols-outlined">{{ t.icon }}</span>
                  <div class="cheat-tip-body">
                    <strong class="cheat-tip-title">{{ t.title }}</strong>
                    <p class="cheat-tip-desc">{{ t.desc }}</p>
                  </div>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.cheat-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim-2);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.cheat-dialog {
  width: 880px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 24px 28px;
}
.cheat-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border, #dfe1e6);
}
.cheat-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 4px;
}
.cheat-subtitle {
  font-size: 12px;
  color: var(--text-3, #6b778c);
  margin: 0;
}
.cheat-mini-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 3px;
  vertical-align: 1px;
  margin: 0 1px;
}
.cheat-close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.cheat-close:hover {
  background: var(--hover-bg, #f4f5f7);
}
.cheat-close .material-symbols-outlined {
  font-size: 20px;
}

.cheat-body {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 32px;
}
.cheat-col-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3, #6b778c);
  margin: 0 0 12px;
}

/* 左栏:快捷键 */
.cheat-keys-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.cheat-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin: 0 0 8px;
}
.cheat-key-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cheat-key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}
.cheat-desc {
  color: var(--text-2, #44546f);
  min-width: 0;
  line-height: 1.4;
}
.cheat-keys {
  display: inline-flex;
  gap: 3px;
  flex-shrink: 0;
}
.cheat-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
}

/* 右栏:tip 卡片 */
.cheat-tip-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cheat-tip {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: 6px;
}
.cheat-tip-icon {
  font-size: 20px;
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 1px;
}
.cheat-tip-body {
  min-width: 0;
}
.cheat-tip-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 2px;
}
.cheat-tip-desc {
  font-size: 12.5px;
  color: var(--text-2, #44546f);
  margin: 0;
  line-height: 1.5;
}

.cheat-fade-enter-active,
.cheat-fade-leave-active {
  transition: opacity var(--duration-fast) ease;
}
.cheat-fade-enter-active .cheat-dialog,
.cheat-fade-leave-active .cheat-dialog {
  transition: transform var(--duration-base) var(--ease-out);
}
.cheat-fade-enter-from,
.cheat-fade-leave-to {
  opacity: 0;
}
.cheat-fade-enter-from .cheat-dialog,
.cheat-fade-leave-to .cheat-dialog {
  transform: translateY(-8px) scale(0.97);
}
</style>
