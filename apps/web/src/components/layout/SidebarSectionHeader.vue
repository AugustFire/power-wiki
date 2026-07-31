<script setup lang="ts">
/**
 * 侧栏可折叠 section 标题 —— 「此空间的关注」/「此空间的页面」共用。
 *
 * 抽出来的原因:两块 section 之前各写一份标题(一个 <div>、一个 <button>),
 * UA 默认 line-height / 空白文字节点差异反复导致「此」字 x/y 漂移 1~2px。
 * 同一个组件渲染 = 结构与样式天然一致,视觉不会再各自漂移。
 *
 * 布局沿用原「此空间的关注」的形态:icon + 文字 + count 靠左成组,
 * chevron 贴右边缘。label 文字起点不因为折叠交互右移,跟下面的 row 缩进
 * 关系保持不变。
 */
defineProps<{
  icon: string
  label: string
  count?: number | null
  collapsed: boolean
  /** 设为 false 时不渲染 chevron、不响应 click —— 用于「本 section 不可
   *  折叠」的场景(目前是「此空间的关注」空态:0 条时既不能展开也
   *  没有可看内容,chevron 留着只会让用户期望一个展开反馈)。 */
  collapsible?: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <component
    :is="collapsible === false ? 'div' : 'button'"
    :type="collapsible === false ? undefined : 'button'"
    class="sidebar-section-title section-toggle"
    :aria-expanded="collapsible === false ? undefined : !collapsed"
    @click="collapsible === false ? undefined : emit('toggle')"
  >
    <span class="section-label">
      <span class="material-symbols-outlined section-icon">{{ icon }}</span>
      {{ label }}
      <span v-if="count != null" class="count">{{ count }}</span>
    </span>
    <span
      v-if="collapsible !== false"
      class="material-symbols-outlined chevron"
      :class="{ 'chevron-collapsed': collapsed }"
    >expand_more</span>
  </component>
</template>

<style scoped>
/* .sidebar-section-title 提供 26px / 13px / 600 / text-3 的 label 视觉 +
   flex space-between(styles/components.css),这里只补 <button> 复位 +
   chevron 交互。 */
.section-toggle {
  cursor: pointer;
  background: transparent;
  border: 0;
  width: 100%;
  text-align: left;
  font-family: inherit;
  color: inherit;
}
.section-toggle:hover {
  /* 只在可折叠时加深底色 —— 非折叠态(div 渲染)不响应 hover,避免出现
     「看着像可点,点又没反应」的悬停视觉。 */
  cursor: pointer;
  background: transparent;
}
button.section-toggle:hover {
  background: var(--bg-subtle);
}
.section-toggle .chevron {
  font-size: 18px !important;
  color: var(--text-3);
  flex-shrink: 0;
  margin-left: 4px;
  transition: transform var(--duration-fast) var(--ease-out);
}
.section-toggle .chevron-collapsed {
  transform: rotate(-90deg);
}
</style>
