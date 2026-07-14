<script setup lang="ts">
/**
 * ScrollProgress — 阅读进度条,2px, var(--accent), 横跨内容列宽度。
 * 只在 ReadView 挂载(page 阅读时才有意义;activity 流 / dashboard
 * 不显示)。
 *
 * 视觉:
 *   - position: fixed;贴在 subheader 的下边框上(top = topbar-h + sub-h
 *     - 2px),不再横在 viewport 最顶。
 *   - 2px 高,色彩 = --accent 蓝(Atlassian 主色,跟其它顶栏控件一致)
 *   - transform-origin: left + scaleX — 0% 时宽度 0(滚到底 = 看不到),
 *     100% 时宽度 100% — 用 transform 而非 width 动画,GPU 合成,
 *     不触发 reflow。
 *
 * 滚动模型(关键 — 早期版本只读 window scrollTop,在 internal-scroll
 * 视图上 bar 永远是 0):ReadView 的 `.content` `overflow-y: auto` 才是
 * 真正的滚动容器,window.scrollY 永远 = 0。同时 Sidebar 内部也是
 * overflow: auto(PageTree 长),也是一个 scroll 容器。
 *
 *   不能用 e.target:浏览器 scroll 恢复在 onMount 时会触发 Sidebar 的
 *   scroll 事件,e.target=Sidebar → bar 锁在 Sidebar 上 → 用户后续滚
 *   .content 时 bar 永远不动。Sidebar 进度对用户没意义,要排除。
 *
 *   解决:`pickScrollTarget` 在 onMount / 路由切换 时挑一次 — document
 *   真滚就用 document;否则挑 clientArea 最大的 overflow:auto 元素
 *   (主内容一定比 Sidebar 大,优先主内容)。缓存成 `scrollEl`,所有
 *   后续 scroll 事件都从这个缓存 target 读 scrollTop,完全忽略
 *   e.target。resize / 路由切换时 re-pick。
 *
 * 性能:
 *   - passive scroll + requestAnimationFrame 节流 — 60Hz 上不会每像素
 *     都跑计算
 *   - resize 也触发一次 — 视口大小变化(→ 内部容器 clientHeight 变)
 *     时重新对齐 100%
 *   - Unmount 严格清理 listener / cancel rAF,不留尾巴
 *
 * z-index = 200 — 必须 ≥ TopBar(z=100,components.css:34)否则会被 TopBar
 *   的 white bg 完全遮住。仍远低于所有 modal / drawer / popover(900+)。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

let rafId: number | null = null
const barEl = ref<HTMLDivElement | null>(null)
/** 缓存的 scroll target — 主内容区 (.content / .manager-main / document)。
 *  不直接用 e.target:浏览器 scroll 恢复会触发 Sidebar 的 scroll 事件,
 *  e.target 锁在 Sidebar 后就再也回不到主内容。 */
let scrollEl: Element | null = null

function updateBar() {
  const el = barEl.value
  if (!el) return
  const target = scrollEl
  if (!target) {
    el.style.transform = 'scaleX(0)'
    return
  }
  const max = target.scrollHeight - target.clientHeight
  if (max <= 0) {
    el.style.transform = 'scaleX(0)'
    return
  }
  const ratio = Math.max(0, Math.min(1, target.scrollTop / max))
  el.style.transform = `scaleX(${ratio})`
}

function onScroll() {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    // Lazy re-pick in 3 cases:
    //   1. 首次进 view — bar 挂载时 RouterView 还没 commit,.content
    //      还不存在 → scrollEl=null。Scroll 事件是「view 就绪」的强
    //      信号,此时 pick 一次稳赢。
    //   2. Cached target 已 detached — 路由切换时 <transition mode="out-in">
    //      旧 view 卸了,新 view 还没 mount,scrollEl 指向已脱离 DOM
    //      的旧元素。`document.contains` 检测出来(注意:不能用
    //      `document.body.contains` — html 元素是 root,body 并不
    //      包含它,会让 document 滚动条永远被认为是 detached)。
    //   3. Cached target 滚到头(没有 scrollHeight > clientHeight)
    //      — view 切换后新 view 可能没滚动,需要重 pick。
    if (
      !scrollEl ||
      !document.contains(scrollEl) ||
      scrollEl.scrollHeight <= scrollEl.clientHeight + 1
    ) {
      scrollEl = pickScrollTarget()
    }
    updateBar()
  })
}

function onResize() {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    // resize 后 clientWidth/clientHeight 变了,面积 pick 可能换 winner
    scrollEl = pickScrollTarget()
    updateBar()
  })
}

/**
 * 挑主滚动 target:document 真滚就用 document;否则挑 viewport 内
 * clientArea 最大的 overflow-y: auto/scroll 元素。Sidebar 280px 宽,
 * 主内容 ~1300px,主内容面积是 Sidebar 的 ~5x,稳赢。
 */
function pickScrollTarget(): Element | null {
  const doc = document.scrollingElement || document.documentElement
  if (doc.scrollHeight > doc.clientHeight + 1) return doc

  let best: HTMLElement | null = null
  let bestArea = 0
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    const style = getComputedStyle(el)
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue
    if (el.scrollHeight <= el.clientHeight + 1) continue
    const area = el.clientWidth * el.clientHeight
    if (area > bestArea) {
      bestArea = area
      best = el
    }
  }
  return best
}

function rebind() {
  scrollEl = pickScrollTarget()
  updateBar()
}

onMounted(() => {
  // capture phase 兜底 — 即便用户后面手动滚了非主区元素(理论上不该发生),
  // 我们的 cache 也不会被劫持,所有 scroll 事件都从 cache 读
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('resize', onResize, { passive: true })
  // 初始 rebind:bar 挂载时 .content 可能还没 layout 完(ReadView 首帧),
  // 所以紧接着再排两次 rAF 重试 — 等 .content 出现。
  rebind()
  requestAnimationFrame(() => {
    requestAnimationFrame(rebind)
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
  window.removeEventListener('resize', onResize)
  if (rafId !== null) cancelAnimationFrame(rafId)
})

/**
 * 路由切换:<transition mode="out-in"> 让旧 view 先 fade-out 再卸,
 * 然后新 view 才 mount。整个 transition 可能 200ms+。retry 直到
 * pickScrollTarget 返回的元素 != 旧 view 的 target — 旧 target 在
 * transition 期间还在 DOM(inDom=true),「detached」判定失败会让我们
 * 误以为已经稳定。所以只看「target 是否换了」,不看 inDom。
 */
watch(
  () => route.fullPath,
  () => {
    let attempts = 0
    const tryRebind = () => {
      const before = scrollEl
      rebind()
      // pick 出来的还是同一个元素 = 新 view 还没 mount,继续 retry
      if (before && scrollEl === before) {
        if (attempts++ < 10) setTimeout(tryRebind, 80)
      }
    }
    requestAnimationFrame(tryRebind)
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
  /* 贴在 subheader 的下边框上(不再横在 viewport 最顶)。ReadView 里
   * subheader sticky 在 top:var(--topbar-h)、高 var(--sub-h),其下边缘在
   * topbar-h + sub-h 处。bar 2px 高,top 减 2px 让 bar 底边与 subheader
   * 底边对齐 —— 阅读进度像是 subheader 的下边框在变色。 */
  top: calc(var(--topbar-h) + var(--sub-h) - 2px);
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
