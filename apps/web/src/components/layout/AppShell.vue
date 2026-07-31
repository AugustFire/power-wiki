<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { RouterView, useRoute } from 'vue-router'
import TopBar from '@/components/layout/TopBar.vue'
import Sidebar from '@/components/layout/Sidebar.vue'
import TopSearch from '@/components/layout/TopSearch.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import CheatSheetModal from '@/components/ui/CheatSheetModal.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import SettingsDrawer from '@/components/layout/SettingsDrawer.vue'
import ImportMarkdownModal from '@/components/editor/ImportMarkdownModal.vue'
import MovePageDialog from '@/components/layout/MovePageDialog.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useUiStore } from '@/stores/ui'
import { usePagesStore } from '@/stores/pages'
import { useNetworkStatus } from '@/composables/useNetworkStatus'

const route = useRoute()
const uiStore = useUiStore()
const pagesStore = usePagesStore()
const { topSearchOpen, error } = storeToRefs(uiStore)
const { loading, loaded, loadError } = storeToRefs(pagesStore)
const { moveModalOpen, moveContext } = storeToRefs(uiStore)
const { isOnline } = useNetworkStatus()

const isManagerLayout = computed(() => route.meta.appLayout === 'manager')
const isWideWorkspace = computed(() => route.meta.workspaceWidth === 'wide')
const isFlushContent = computed(() => route.meta.contentMode === 'flush')
const hasToc = computed(() => route.meta.hasToc === true)

/* ─── 4.11 · Banner coordination ────────────────────────────────────
 * 原版把 offline-banner + error-banner 放在 document flow 里(40 + 24 px),
 * 当 banner 出现时把整页 main / subheader / sidebar 全部下推 —— subheader
 * 的 `position: sticky; top: var(--topbar-h)` 在用户滚到顶部时就会把
 * 自身从自然 document 位置(--topbar-h + 64px)拉到 --topbar-h 位置,
 * 视觉上跟 banner 重叠。同时 sidebar 的 `top: calc(--topbar-h + --sub-h)`
 * 也不包含 banner 高度,sticky 切换瞬间留 64px 空白。
 *
 * 修法:banner 改 `position: fixed; top: 0`,从 document flow 抽出来,
 * viewport 顶部固定。TopBar / Subheader / Sidebar / TOC / Layout 高度
 * 全部加 `var(--banner-h)`,通过 CSS 变量级联(写在 :root)统一管理。
 * AppShell 监测哪个 banner 出现,测出真实渲染高度写到 CSS 变量上。
 *
 * 互斥(4.P2.f):offline 优先于 error。同一时刻最多一个 banner,
 * 避免堆叠把 viewport 顶部压到 ~74px 影响阅读区。offline 出现时常伴随
 * 上一次未消的错误,error 提示信息此刻相对冗余,offline 已是更准确
 * 的根因。
 */
const activeBanner = ref<'offline' | 'error' | null>(null)
const offlineBannerEl = ref<HTMLElement | null>(null)
const errorBannerEl = ref<HTMLElement | null>(null)
const bannerHeight = ref(0)

function recomputeBanner() {
  if (!isOnline.value) activeBanner.value = 'offline'
  else if (error.value) activeBanner.value = 'error'
  else activeBanner.value = null
}

async function measureBanner() {
  await nextTick()
  const el = activeBanner.value === 'offline' ? offlineBannerEl.value
    : activeBanner.value === 'error' ? errorBannerEl.value
    : null
  bannerHeight.value = el ? el.offsetHeight : 0
}

function applyBannerHeightVar() {
  document.documentElement.style.setProperty('--banner-h', `${bannerHeight.value}px`)
}

onMounted(() => {
  recomputeBanner()
  watch([isOnline, error], recomputeBanner, { immediate: false })
  watch(activeBanner, measureBanner, { immediate: true, flush: 'post' })
  watch(bannerHeight, applyBannerHeightVar, { immediate: true, flush: 'post' })
})

onBeforeUnmount(() => {
  // 登出 / 切到登录路由时清理,避免下次挂载残留 64px 占位
  document.documentElement.style.removeProperty('--banner-h')
})

/**
 * 拿到 <div id="app-right-rail"> 的 DOM 引用,provide 给所有需要 Teleport
 * 进右栏的后代(ReadView / EditView 的 <TocPanel>)。
 *
 * 为什么用 ref 而不是字符串选择器:Vue 3 的 <Teleport to="..."> 接受 string
 * 时会在 mount 阶段 querySelector,如果 target 那一刻还没在 DOM 里(ReadView
 * 是 () => import(...) 异步 chunk,vite 命中缓存时会在 layout 同 flush 内
 * 同步挂载,与右栏 mountChildren 时序赛跑),会 warn "Failed to locate
 * Teleport target" 并把 subTree 留在 null,后续 patch 时触发
 * "Cannot read properties of null (reading 'emitsOptions')",且右栏 TOC
 * 永远不渲染。
 *
 * 直接传 HTMLElement:Vue 在 Teleport.process() 里 `typeof targetProp === 'string'`
 * 才走 querySelector,否则用传入的元素,完全跳过字符串查找。Vue 的 mountChildren
 * 按 source 顺序处理 layout 子节点,右栏在 Sidebar 和 content 之前,ref 在
 * mountElement 里同步赋值,所以后代 mount 时(包括同 flush 异步 chunk 已 resolve
 * 的情况)ref.value 已经是元素。
 */
const rightRailEl = ref<HTMLElement | null>(null)
provide<Ref<HTMLElement | null>>('appRightRail', rightRailEl)

/** 同 rightRailEl 的设计:<div id="app-subheader"> 在 workspace 分支
 *  v-else-if="loaded" 下才渲染,manager 分支(等价的 isManagerLayout)不
 *  渲染。路由从 /manager/* 切到 /me/watched 这种「manager → workspace」
 *  转换时,manager branch 先 unmount、workspace branch 后 mount,中间
 *  时刻后代组件可能先于 #app-subheader 出现在 DOM,字符串 Teleport target
 *  会 warn 失败;走 ref 把目标元素直接交给 Teleport.process() 跳过
 *  querySelector,跟 right-rail 同款。 */
const subheaderEl = ref<HTMLElement | null>(null)
provide<Ref<HTMLElement | null>>('appSubheader', subheaderEl)
</script>

<template>
  <div class="app-shell">
    <TopBar />

    <div v-if="activeBanner === 'offline'" ref="offlineBannerEl" class="offline-banner" role="status">
      <span class="material-symbols-outlined ob-icon">wifi_off</span>
      <span class="ob-text">网络连接已断开,正在等待恢复…</span>
    </div>

    <div v-else-if="activeBanner === 'error'" ref="errorBannerEl" class="error-banner" role="alert">
      <span class="material-symbols-outlined eb-icon">error</span>
      <span class="eb-text">{{ error }}</span>
      <button type="button" class="eb-close" title="关闭" @click="uiStore.clearError()">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>

    <main>
      <div v-if="loading" class="boot-skeleton" aria-hidden="true">
        <aside class="bs-sidebar">
          <Skeleton width="60%" height="14px" />
          <div class="bs-tree">
            <Skeleton v-for="i in 8" :key="i" :width="`${55 + ((i * 37) % 40)}%`" height="12px" />
          </div>
        </aside>
        <section class="bs-content">
          <Skeleton width="52%" height="30px" radius="6px" />
          <div class="bs-meta">
            <Skeleton width="28px" height="28px" radius="50%" />
            <Skeleton width="140px" height="12px" />
          </div>
          <div class="bs-body">
            <Skeleton :count="3" height="13px" />
            <Skeleton width="88%" height="13px" />
            <Skeleton width="40%" height="13px" />
            <Skeleton width="70%" height="13px" />
          </div>
        </section>
      </div>

      <div v-else-if="loadError" class="page-error">
        <span class="material-symbols-outlined pe-icon">cloud_off</span>
        <h2 class="pe-title">无法连接到后端</h2>
        <p class="pe-text">{{ loadError }}</p>
        <p class="pe-hint">确认 <code>apps/api</code> 服务已启动(<code>pnpm dev</code> 会同时起 web + api)。</p>
        <button type="button" class="pe-retry" @click="pagesStore.init()">重试</button>
      </div>

      <RouterView v-else-if="loaded && isManagerLayout" v-slot="{ Component }">
        <component :is="Component" />
      </RouterView>

      <template v-else-if="loaded">
        <div class="subheader">
          <div id="app-subheader" ref="subheaderEl" class="app-subheader-content"></div>
        </div>
        <div
          class="layout"
          :class="{
            'layout-wide': isWideWorkspace,
            'no-toc': !hasToc,
            'toc-collapsed': hasToc && uiStore.tocCollapsed,
          }"
        >
          <!-- #app-right-rail 必须先于 <div class="content"> 渲染 —— 顺序
               决定 Vue 的 mountChildren 顺序,确保 rightRailEl ref 在
               ReadView/EditView mount 前已经赋值。ReadView 内的
               <Teleport :to="rightRailEl"> 直接拿 HTMLElement 跳过
               querySelector,详见 <script setup> 里的 rightRailEl 注释。
               grid 用 order 把右栏视觉上挪回第三列,DOM 顺序仍然是 mount
               顺序。 -->
          <div id="app-right-rail" ref="rightRailEl" class="app-right-rail"></div>
          <Sidebar />
          <div class="content" :class="{ 'content-flush': isFlushContent }">
            <RouterView v-slot="{ Component }">
              <component :is="Component" />
            </RouterView>
          </div>
        </div>
      </template>
    </main>

    <TopSearch :open="topSearchOpen" @close="uiStore.closeTopSearch()" />
    <ConfirmDialog />
    <CheatSheetModal />
    <ToastContainer />
    <SettingsDrawer />
    <ImportMarkdownModal />
    <MovePageDialog
      v-if="moveModalOpen && moveContext"
      :page-id="moveContext.pageId"
      @close="uiStore.closeMoveDialog()"
    />
  </div>
</template>

<style scoped>
.app-shell { min-height: 100vh; }
.app-subheader-content {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.app-right-rail {
  min-width: 0;
  height: 100%;
}
.content-flush {
  padding: 0;
  overflow: hidden;
}

.offline-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  background: var(--warning-soft);
  color: var(--warning-text);
  font-size: var(--text-sm, 13px);
  border-bottom: 1px solid var(--warning);
  /* 4.11 — banner 改 fixed,viewport 顶部常驻。z-index 高于 TopBar
     (100),让 network 状态始终压过 brand + 切换器;TopBar 自然下沉
     到 banner 下边缘(--topbar-h + --banner-h)。 */
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 110;
}
.offline-banner .ob-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.error-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 24px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 14px;
  border-bottom: 1px solid var(--danger);
  /* 4.11 — 同 offline,banner 改 fixed 跟 TopBar 错层;互斥(4.P2.f)
     保证同一时刻只有一个 banner 在位。 */
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 110;
}
.eb-icon { font-size: 20px; flex-shrink: 0; }
.eb-text { flex: 1; }
.eb-close {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  padding: 4px;
  display: flex;
  border-radius: 4px;
}
.eb-close:hover { background: rgba(255, 86, 48, 0.12); }
.eb-close .material-symbols-outlined { font-size: 18px; }

.boot-skeleton {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 32px;
  padding: 24px 32px;
  max-width: 1600px;
}
.bs-sidebar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 8px;
}
.bs-tree {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}
.bs-content {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 820px;
  padding-top: 8px;
}
.bs-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bs-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 8px;
}
.page-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: var(--text-2);
}
.pe-icon {
  font-size: 56px;
  color: var(--danger);
}
.pe-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}
.pe-text {
  font-size: 14px;
  margin: 0;
  color: var(--danger);
}
.pe-hint {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
  max-width: 480px;
}
.pe-hint code {
  background: var(--bg-muted);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.pe-retry {
  margin-top: 8px;
  padding: 8px 20px;
  background: var(--accent);
  color: white;
  border: 0;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.pe-retry:hover { background: var(--accent-hover); }
</style>
