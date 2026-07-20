<script setup lang="ts">
/**
 * HelpButton — TopBar 内 bell 左侧的「帮助」入口.
 *
 * 唤起 uiStore.openCheatSheet() —— ⌘/ 速查表 modal(图标、入口、快捷键
 * 三个 discover 路径并行,缺一不可:有 modal 没入口,还是没人找到)。
 *
 * 图标路径来自 design/wiki-read.html 顶栏 help 按钮的 SVG —— 保留
 * Feather "help-circle" 风格,与设计基准一致。
 */
import { useUiStore } from '@/stores/ui'
import { MOD_KEY } from '@/lib/platform'

const uiStore = useUiStore()

function onClick(): void {
  uiStore.openCheatSheet()
}
</script>

<template>
  <button
    class="help-btn"
    type="button"
    aria-label="键盘快捷键与隐藏功能"
    title="键盘快捷键与隐藏功能 ({{ MOD_KEY }})"
    @click="onClick"
  >
    <svg
      class="help-icon"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>
</template>

<style scoped>
.help-btn {
  position: relative;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.help-btn:hover {
  background: var(--bg-canvas);
}
.help-icon {
  width: 18px;
  height: 18px;
}
</style>
