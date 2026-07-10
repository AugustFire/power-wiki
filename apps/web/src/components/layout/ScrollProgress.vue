<script setup lang="ts">
/**
 * ScrollProgress — sticky top scroll indicator, 2px, var(--accent), full width.
 *
 * 视觉:
 *   - position: fixed; top: 0; 横跨整个 viewport,与 TopBar 同列首屏
 *   - 2px 高,色彩 = --accent 蓝(Atlassian 主色,跟其它顶栏控件一致)
 *   - transform-origin: left + scaleX — 0% 时宽度 0(滚到底 = 看不到),
 *     100% 时宽度 100% — 用 transform 而非 width 动画,GPU 合成,
 *     不触发 reflow。
 *
 * 滚动模型:
 *   - 全站用 window / document.documentElement 滚动(view shell 都是
 *     `min-height: calc(100vh - var(--topbar-h))`,Content 涨破就推
 *     documentElement 往下,grid 内 overflow-y: auto 是防御性的兜底,
 *     实际不触发)
 *   - 不监听内部滚动容器(ActivityView / HistoryView 内部某侧栏 — 那种
 *     局部面板的滚动指示留给 v2 / per-view 单独处理;全页主滚动靠这个)
 *
 * 性能:
 *   - passive scroll + requestAnimationFrame 节流 — 60Hz 上不会每像素
 *     都跑计算
 *   - resize 也触发一次 — 滚条总长变化(图片懒加载、虚拟列表加载完)
 *     时重新对齐 100%
 *   - Unmount 严格清理 listener / cancel rAF,不留尾巴
 *
 * z-index = 200 — 必须 ≥ TopBar(z=100,components.css:34)否则会被 TopBar
 *   的 white bg 完全遮住。仍远低于所有 modal / drawer / popover(900+)。
 *
 * 路由变化的稳妥:
 *   - watch route.fullPath 重算 progress — 切到不滚动的页(如 ResetPasswordView
 *     满屏)时,scaleX(0) 自然隐藏
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

let rafId: number | null = null
const barEl = ref<HTMLDivElement | null>(null)

function tick() {
  rafId = null
  const el = barEl.value
  if (!el) return
  const docEl = document.documentElement
  const max = docEl.scrollHeight - window.innerHeight
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, docEl.scrollTop / max))
  el.style.transform = `scaleX(${ratio})`
}

function onScroll() {
  if (rafId !== null) return
  rafId = requestAnimationFrame(tick)
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  // 路由进入新页时,max scroll 变了 → 重算一次(图片 / 懒加载可能改变高度)
  tick()
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
  if (rafId !== null) cancelAnimationFrame(rafId)
})

/** 路由切换:新页 max-scroll / scroll-top 都可能变了 → 重算 */
watch(
  () => route.fullPath,
  () => {
    // 切路由后 content 通常还没 mount 完,等下一个 frame 再算
    requestAnimationFrame(tick)
  },
)
</script>

<template>
  <div class="scroll-progress" aria-hidden="true">
    <div ref="barEl" class="bar"></div>
  </div>
</template>

<style scoped>
.scroll-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 200;
  pointer-events: none;
  overflow: hidden;
}
.bar {
  height: 100%;
  width: 100%;
  background: var(--accent);
  transform: scaleX(0);
  transform-origin: left center;
  /* 短 transition 让 scroll-spike 上不会闪烁(快滚 → 进度跳,平滑过去);
   * 80ms 低于典型 scroll-event 间隔,不会掩盖实际位置变化。 */
  transition: transform 80ms linear;
  will-change: transform;
}
</style>
