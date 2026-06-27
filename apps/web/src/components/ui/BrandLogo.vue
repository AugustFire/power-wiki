<script setup lang="ts">
/**
 * BrandLogo — power-wiki 的唯一品牌资产来源。
 *
 * 几何 P(填充 currentColor)+ 右侧两条递减不透明度的横线,
 * 暗示从 P 字右侧抽出的书页侧切面,呼应 wiki 的知识沉淀意象。
 *
 * 用法:
 *   <BrandLogo />                         // 仅图标,默认尺寸 24
 *   <BrandLogo :size="32" />              // 指定尺寸
 *   <BrandLogo with-wordmark />           // 图标 + "power-wiki" 字标
 *   <BrandLogo variant="light" />         // 白色 fill,用于深色背景
 *
 * 颜色由父级通过 CSS `color:` 控制(solid → --accent;light → --text-invert)。
 */
withDefaults(
  defineProps<{
    size?: number
    withWordmark?: boolean
    variant?: 'solid' | 'light'
  }>(),
  { size: 24, withWordmark: false, variant: 'solid' },
)
</script>

<template>
  <span class="brand-logo" :class="`brand-logo-${variant}`">
    <svg
      class="bl-mark"
      :width="size"
      :height="size"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-hidden="true"
    >
      <!-- 几何 P:外轮廓 + 内嵌负空间(圆角矩形孔)用 evenodd 填充 -->
      <path
        fill-rule="evenodd"
        d="M4 4 H20 A6 6 0 0 1 20 16 H12 V28 H4 Z M12 8 H18 A2 2 0 0 1 18 12 H12 Z"
      />
      <!-- 书页侧切面:右侧两条递减透明度横线,暗示层叠书页 -->
      <line
        x1="20" y1="22" x2="29" y2="22"
        stroke="currentColor" stroke-width="2" stroke-linecap="round"
        opacity="0.55"
      />
      <line
        x1="20" y1="26" x2="29" y2="26"
        stroke="currentColor" stroke-width="2" stroke-linecap="round"
        opacity="0.3"
      />
    </svg>
    <span v-if="withWordmark" class="bl-wordmark">power-wiki</span>
  </span>
</template>

<style scoped>
.brand-logo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-sans, inherit);
  font-weight: 700;
  line-height: 1;
  /* solid 默认:父级 color 控制,fallback --accent */
  color: var(--accent, #0052CC);
}
.brand-logo-light {
  color: var(--text-invert, #FFFFFF);
}
.bl-mark {
  display: block;
  flex-shrink: 0;
}
.bl-wordmark {
  font-size: inherit;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
</style>