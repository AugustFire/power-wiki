<script setup lang="ts">
/**
 * MeDashboardView — 「Your Work」个人 Dashboard(挂在 /me)。
 *
 * 设计基准:Confluence Cloud 「Your Work」面板。布局走单页滚动(Notion
 * 风),不分 tabs —— 用户每天看的不是「只看一类」,tabs 增加点击成本。
 *
 * 3 个 section(按优先级排序):
 *   1. @提到我         (mentions)        — 必读,红色未读 chip
 *   2. 我的个人空间    (personalSpace)   — 个人空间最近编辑的页面,
 *                                        当作 scratchpad / 草稿本用
 *   3. 我创建的        (created)         — 跨空间,author = me
 *
 * 个人空间定位是 scratchpad —— 想给团队空间起草文档就在个人空间写,
 * 写完通过 sidebar「移动到...」推到团队空间。Dashboard 这里把个人空间
 * 最近编辑的页面集中展示,等于替代了之前的「草稿」section。
 *
 * 版心:复用 .layout.no-toc + .content + .content-inner 三层框架(跟
 * WatchedView / ReadView / EditView / HomeView 一致),这样 sidebar 起点
 * 跟其他页面在同一条 column,避免切换时视觉割裂。.dash-page override
 * `.content-inner` 的 1680 max-width,让 list-style 内容铺满中间 column。
 *
 * Hero:avatar + 时间感知问候 + 今日日期,subheader 已提供 breadcrumb,
 * 这里不再重复 H1「我的空间」。
 *
 * 数据:api.users.me.dashboard() 综合端点一次拉满,30s GET 缓存让用户在
 * 30s 内切走又切回来不用重打 server。Mark-read 等 mutation 不主动
 * invalidateDashboard 缓存 — 30s 缓存窗口让单次 mutate 不至于刷全套数据,
 * 刷新按钮手动了再拉一次。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import DashboardCard from '@/components/page/DashboardCard.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useAuthStore } from '@/stores/auth'
import { useSpacesStore } from '@/stores/spaces'
import { usePagesStore } from '@/stores/pages'
import { useNotificationsStore } from '@/stores/notifications'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import { api } from '@/lib/api'
import type { DashboardPayload, PageNode, Space } from '@power-wiki/shared'

const router = useRouter()
const auth = useAuthStore()
const spacesStore = useSpacesStore()
const pagesStore = usePagesStore()
const notifications = useNotificationsStore()
useDocumentTitle(() => '我的空间')

const payload = ref<DashboardPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

/**
 * Space lookup by id — 把 section 卡片需要渲染的 space chip 信息从 spacesStore
 * 里派生出来。Spaces init() 通常在 boot 时已经完成;若用户直接深链进 /me,
 * 走 spacesStore.init() 兜底。
 */
const spaceById = computed<Map<string, Space>>(() => {
  const m = new Map<string, Space>()
  for (const s of spacesStore.spaces.value) m.set(s.id, s)
  return m
})

function describeSpace(id: string | null | undefined): {
  name: string
  color: string
  kind: 'personal' | 'shared'
} {
  if (!id) return { name: '(已删除空间)', color: '#888888', kind: 'shared' }
  const s = spaceById.value.get(id)
  if (!s) return { name: '(已删除空间)', color: '#888888', kind: 'shared' }
  return {
    name: s.name,
    color: s.color,
    kind: s.kind ?? 'shared',
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    if (!spacesStore.loaded.value) await spacesStore.init()
    payload.value = await api.users.me.dashboard(5)
    // 同步 bell badge — Dashboard 加载时刷新一次,跟 Drawer 一致
    void notifications.refreshUnread()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => { void load() })
// onMounted 跑一次 load() 已经覆盖了路由切换 — 跳走 unmount / 跳回来 remount
// 是新实例,新实例自己再 mount。route.fullPath watcher 在同实例下不会触发
// (路由参数变了但 fullPath 没变 / 同组件实例被复用),属于冗余兜底,删掉。

/* ─── 路由跳转 ──────────────────────────────────────────────────
 *
 * Mention → 跳到对应 page + 锚到 comment-{commentId}。scrollToHashAsync
 * 在 router/index.ts 处理 hash 滚动,这条跳转不需要 await。
 *
 * Page → 切到 page 所在空间(让侧栏 autoExpandAndLocate 跟过去),
 * 然后 push 到 /p/:id。复用 ActivityView.openPage 的语义。 */
function openPage(pageId: string): void {
  const page = payload.value?.created.find((p) => p.id === pageId)
    ?? payload.value?.personalSpace.find((p) => p.id === pageId)
  const sid = page?.spaceId
  if (sid && spacesStore.activeSpaceId.value !== sid) {
    spacesStore.setActiveSpace(sid)
  }
  void router.push(`/p/${pageId}`)
}

async function openMention(pageId: string, commentId: string | null): Promise<void> {
  // 先 mark-as-read(标当前这条已读)。失败不影响跳转。
  const matchingMentions = payload.value?.mentions.filter(
    (n) => !n.isRead && n.pageId === pageId && (commentId == null || n.commentId === commentId),
  ) ?? []
  const idsToMarkRead = matchingMentions.map((n) => n.id)
  if (idsToMarkRead.length > 0) {
    try {
      await api.notifications.markRead({ ids: idsToMarkRead })
      void notifications.refreshUnread()
    } catch {
      // 标已读失败不阻断跳转
    }
  }

  // 找 mention 指向的 page 所属 space,让侧栏能跟过去 autoExpandAndLocate。
  // mention section 的 card 不携带 spaceId(Notification DTO 没这字段),只能从
  // 其他 sections 的 PageNode 兜底。如果都没匹配,sid 为 undefined,
  // setActiveSpace 不调,用户会落在当前 active space 上 —— 可接受。
  const candidates = [
    ...(payload.value?.created ?? []),
    ...(payload.value?.personalSpace ?? []),
  ]
  const sid = candidates.find((p) => p.id === pageId)?.spaceId
  if (sid && spacesStore.activeSpaceId.value !== sid) {
    spacesStore.setActiveSpace(sid)
  }

  const hash = commentId ? `#comment-${commentId}` : ''
  void router.push(`/p/${pageId}${hash}`)
}

async function refresh(): Promise<void> {
  await load()
}

/**
 * 加载草稿 / 页面到 pagesStore,让打开时 sidebar 能 autoExpandAndLocate。
 * 短路三种 case(参考 ActivityView.ensurePageLoaded)。
 */
const deadPageIds = new Set<string>()
function ensurePageLoaded(page: PageNode): void {
  if (deadPageIds.has(page.id)) return
  if (pagesStore.getPage(page.id)) return
  void pagesStore.ensureAncestorsLoaded(page.id).then(() => {
    if (!pagesStore.getPage(page.id)) deadPageIds.add(page.id)
  })
}

/* ─── Section 计数 / 跳转 ────────────────────────────────────── */

const hasMentions = computed(() => (payload.value?.mentions.length ?? 0) > 0)
const hasPersonalSpace = computed(() => (payload.value?.personalSpace.length ?? 0) > 0)
const hasCreated = computed(() => (payload.value?.created.length ?? 0) > 0)

/* ─── Hero 文案 ────────────────────────────────────────────────
 *
 * 时间感知问候:凌晨 / 早上 / 下午 / 晚上。`mountedAt` 在 mount 那一刻
 * 冻结,刷新按钮不会让问候词闪变(避免 greet -> "早上好" -> 等几秒 ->
 * 12:00 跨过 -> 变成 "中午好" 的诡异跳变)。如果需要重新评估,刷页面即可。
 */
const mountedAt = ref(new Date())
const greeting = computed(() => {
  const h = mountedAt.value.getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})
const todayLabel = computed(() => {
  const d = mountedAt.value
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${wk}`
})

/**
 * Live clock —— 在 hero 右侧显示 HH:MM:SS,每秒更新一次。配套 day-progress
 * 条,可视化当天已过去的比例。
 *
 * 设计取舍:
 *   - 用 setInterval 1s 刷一次,而不是 200ms/500ms —— 1s 已经足够「活」,再快
 *     反而像动画 toast,扰人。
 *   - tabular-nums + 固定列宽,秒数跳变不抖,左右 columns 不漂移。
 *   - dayProgress 直接用「分」算,精度足够。half-day 节律(13:47 = 0.57)跟
 *     用户的日内感知对得上。
 *   - onBeforeUnmount clearInterval —— 这个 timer 必须清理,否则 reload
 *     后累计 N 个 setInterval 会越来越慢。
 */
const now = ref(new Date())
let clockTimer: number | null = null
onMounted(() => {
  clockTimer = window.setInterval(() => {
    now.value = new Date()
  }, 1000)
})
onBeforeUnmount(() => {
  if (clockTimer != null) window.clearInterval(clockTimer)
})
function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}
const clockText = computed(() => {
  const d = now.value
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
})
const dayProgress = computed(() => {
  const d = now.value
  const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
  return minutes / (24 * 60)
})

/**
 * 副标题:数据驱动的「今天先处理啥」一句话提示。
 *
 * 优先级:未读 @ 提到 > 未发布草稿 > 全部空(引导开始记录)。语气像私人助理
 * 而不是产品介绍 —— 跟 Confluence / Notion 的 footer-like 一句话定位同档:
 * 静态 product intro 太像 SaaS 后台,dynamic task hint 让用户一眼看到今天的
 * 待办。
 *
 * loading 占位靠 skeleton,这里的 loading 状态不需要专门走「正在加载」文案,
 * fallback 到「继续往下浏览」即可。
 */
const heroSubtitle = computed(() => {
  const mentions = payload.value?.mentions.length ?? 0
  const personal = payload.value?.personalSpace.length ?? 0

  if (mentions > 0) {
    return personal > 0
      ? `今天有 ${mentions} 条 @ 提到你,个人空间里还有 ${personal} 篇正在写的。`
      : `今天有 ${mentions} 条 @ 提到你,先看一眼吧。`
  }
  if (personal > 0) {
    return `个人空间里有 ${personal} 篇正在写,继续推进吧。`
  }
  return '浏览你创建的页面,或新建一页开始记录。'
})

</script>

<template>
  <div class="dash-shell">
    <!-- Subheader —— 跟 WatchedView / HomeView 一致,提供「我的空间」breadcrumb。
         2560 宽下 subheader 跟其他页面在同一条 y 轴上,避免页面切换时 banner
         高度跳动。 -->
    <div class="subheader">
      <div class="breadcrumb">
        <span class="crumb-item current">我的空间</span>
      </div>
      <div class="page-actions">
        <button
          class="refresh-btn"
          type="button"
          :disabled="loading"
          @click="refresh"
          :title="loading ? '加载中…' : '刷新'"
        >
          <span
            class="material-symbols-outlined"
            :class="{ 'is-loading': loading }"
          >refresh</span>
          <span class="refresh-label">刷新</span>
        </button>
      </div>
    </div>

    <div class="layout no-toc">
      <Sidebar />
      <div class="content">
        <div class="content-inner dash-page">
          <!-- Hero —— 纯排版页面标题 + 右侧 live clock 配重。
               上一版左文右空,headline 偏左像浮岛。这里用 flex 两列:
                 左:text column(meta eyebrow + 大 H1 + lead 段落)
                 右:live clock widget(HH:MM:SS + 当日进度条),ticking 1s 一次
               clock 既填了右侧空白,又把 dashboard 变成「正在运行的页面」——
               个人感更重。clock 走 tabular-nums,秒数跳不抖列宽。 -->
          <header class="dash-hero">
            <div class="dash-hero-text">
              <div class="hero-meta">
                <span class="hero-meta-greeting">{{ greeting }}</span>
                <span class="hero-meta-dot" aria-hidden="true">·</span>
                <span class="hero-meta-date">{{ todayLabel }}</span>
              </div>
              <h1 class="hero-name">{{ auth.user?.name ?? '我' }}</h1>
              <p class="hero-subtitle">{{ heroSubtitle }}</p>
            </div>
            <div class="hero-clock" aria-label="当前时间">
              <time class="clock-time" :datetime="now.toISOString()">{{ clockText }}</time>
              <div
                class="clock-progress"
                role="progressbar"
                :aria-valuenow="Math.round(dayProgress * 100)"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div class="clock-progress-bar" :style="{ width: (dayProgress * 100) + '%' }"></div>
              </div>
              <div class="clock-label">今日已过 {{ Math.round(dayProgress * 100) }}%</div>
            </div>
          </header>

      <!-- Error banner with retry -->
      <div v-if="error" class="dash-error" role="alert">
        <span class="material-symbols-outlined">error</span>
        <span>{{ error }}</span>
        <button class="link-btn" type="button" @click="refresh">重试</button>
      </div>

      <!-- ====================== @提到我 ====================== -->
      <section id="section-mentions" class="dash-section">
        <header class="section-head">
          <h2 class="section-title">
            <span class="material-symbols-outlined section-icon mention-icon">alternate_email</span>
            @提到我
          </h2>
          <span class="section-meta">{{ payload?.mentions.length ?? 0 }} 条未读</span>
        </header>

        <div v-if="loading && !payload" class="section-loading">
          <div v-for="i in 3" :key="i" class="row-skeleton">
            <Skeleton circle :width="32" :height="32" />
            <div class="row-skeleton-text">
              <Skeleton :width="`${55 + i * 7}%`" :height="14" />
              <Skeleton :width="`${30 + i * 5}%`" :height="11" />
            </div>
          </div>
        </div>
        <ul v-else-if="hasMentions" class="section-list">
          <li v-for="n in payload!.mentions" :key="n.id">
            <DashboardCard
              variant="mention"
              :notification="n"
              @open-mention="(pageId, commentId) => openMention(pageId, commentId)"
            />
          </li>
        </ul>
        <EmptyState
          v-else
          icon="forum"
          title="没有被 @ 提到"
          hint="有人在评论里 @ 你时会出现在这里。"
          size="sm"
        />
      </section>

      <!-- ====================== 我的个人空间 ====================== -->
      <section id="section-personal" class="dash-section">
        <header class="section-head">
          <h2 class="section-title">
            <span class="material-symbols-outlined section-icon personal-icon">lock</span>
            我的个人空间
          </h2>
          <span class="section-meta">最近 {{ payload?.personalSpace.length ?? 0 }} 个</span>
        </header>

        <div v-if="loading && !payload" class="section-loading">
          <div v-for="i in 2" :key="i" class="row-skeleton">
            <Skeleton :width="32" :height="32" />
            <div class="row-skeleton-text">
              <Skeleton :width="`${60 + i * 8}%`" :height="14" />
              <Skeleton :width="`${30 + i * 5}%`" :height="11" />
            </div>
          </div>
        </div>
        <ul v-else-if="hasPersonalSpace" class="section-list">
          <li
            v-for="p in payload!.personalSpace"
            :key="p.id"
            @mouseenter="ensurePageLoaded(p)"
          >
            <DashboardCard
              variant="page"
              :page="p"
              :space-name="describeSpace(p.spaceId).name"
              :space-color="describeSpace(p.spaceId).color"
              :space-kind="describeSpace(p.spaceId).kind"
              @open-page="openPage"
            />
          </li>
        </ul>
        <EmptyState
          v-else
          icon="lock"
          title="个人空间是空的"
          hint="在个人空间写下想法,写完通过「移动到...」推到团队空间。"
          size="sm"
        />
      </section>

      <!-- ====================== 我创建的 ====================== -->
      <section id="section-created" class="dash-section">
        <header class="section-head">
          <h2 class="section-title">
            <span class="material-symbols-outlined section-icon">add_circle</span>
            我创建的
          </h2>
          <span class="section-meta">最近 {{ payload?.created.length ?? 0 }} 个</span>
        </header>

        <div v-if="loading && !payload" class="section-loading">
          <div v-for="i in 3" :key="i" class="row-skeleton">
            <Skeleton :width="32" :height="32" />
            <div class="row-skeleton-text">
              <Skeleton :width="`${50 + i * 7}%`" :height="14" />
              <Skeleton :width="`${30 + i * 5}%`" :height="11" />
            </div>
          </div>
        </div>
        <ul v-else-if="hasCreated" class="section-list">
          <li
            v-for="p in payload!.created"
            :key="p.id"
            @mouseenter="ensurePageLoaded(p)"
          >
            <DashboardCard
              variant="page"
              :page="p"
              :space-name="describeSpace(p.spaceId).name"
              :space-color="describeSpace(p.spaceId).color"
              :space-kind="describeSpace(p.spaceId).kind"
              @open-page="openPage"
            />
          </li>
        </ul>
        <EmptyState
          v-else
          icon="article"
          title="还没有创建过页面"
          hint="去任意空间创建你的第一页，会出现在这里。"
          size="sm"
        />
      </section>

        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ====================== Shell / 版心 ======================
 *
 * 跟 WatchedView / ReadView / EditView / HomeView 共用 .layout(.no-toc) +
 * .content + .content-inner 三层框架 —— sidebar 起点 (x=280) 跟其他页面
 * 在同一条 column 上,这是「版心位置一致」的硬约束(切换视图时 sidebar
 * 不跳)。
 *
 * 但 .content-inner 默认 max-width: 1680px 把内容居中,2K 宽下会留出
 * 196px 左边距 + 240px toc 预留 = 436px 空白,内容像被压在左半边。dashboard
 * 是密集 list-style view,3 个 section 卡片列需要更多 horizontal 呼吸空间,
 * 这里 override 把 max-width 拿掉,让 .dash-page 铺满整个 .content column。
 * 2560 下内容从 1648 → 2008,真正"用满"中间 column。 */
.dash-shell { min-height: calc(100vh - var(--topbar-h)); }
.dash-page {
  padding-top: 32px;
  padding-bottom: 64px;
  max-width: none;  /* override .content-inner 的 1680 cap */
}

/* ====================== Subheader refresh button ====================== */
.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border, #DFE1E6);
  border-radius: var(--radius, 4px);
  background: var(--bg, #FFFFFF);
  color: var(--text-2, #42526E);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background var(--duration-fast) ease-out,
    border-color var(--duration-fast) ease-out,
    color var(--duration-fast) ease-out;
}
.refresh-btn:hover:not(:disabled) {
  border-color: var(--accent, #0052CC);
  background: var(--accent-bg-soft, #E9F2FF);
  color: var(--accent, #0052CC);
}
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.refresh-btn:focus-visible {
  outline: 2px solid var(--focus-ring, #4C9AFF);
  outline-offset: 2px;
}
.refresh-btn .material-symbols-outlined { font-size: 18px; }
.is-loading { animation: spin 0.9s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* ====================== Hero ======================
 *
 * 纯排版页面标题 + 左侧 accent stripe + 右侧 inline live clock。
 *
 * 上一版 hero 在宽屏(2K)上太单薄 —— 32px H1 + 居左小字 + 右下角 clock,
 * 文本块跟 1800px+ 的内容宽相比像漂在白底。叠了三个修复:
 *   - 左侧 3px 蓝色 accent stripe ::before,给 text column 视觉锚
 *   - H1 拉到 44px,占据真正的标题重量
 *   - clock 缩到 22px inline 在 meta 行右,不再独立占一列
 *
 * 不画 box、不上 gradient、不挂 avatar(头像 TopBar 已有) —— 这条约束保留,
 * 区别于 Vue 后台模板。 */
.dash-hero {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas:
    "meta clock"
    "name clock"
    "sub  .";
  column-gap: 48px;
  row-gap: 6px;
  align-items: center;
  padding: 12px 0 36px;
  margin-bottom: 32px;
  border-bottom: 1px solid var(--border, #EBECF0);
}
.dash-hero-text {
  grid-area: meta / meta / sub / sub;
  position: relative;
  padding-left: 22px;
  min-width: 0;
}
.dash-hero-text::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--accent, #0052CC) 0%, var(--accent-bg-active, #B3D4FF) 100%);
}
.hero-meta {
  grid-area: meta;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--text-2, #42526E);
  letter-spacing: 0.01em;
}
.hero-meta-greeting {
  font-weight: 600;
  color: var(--text-1, #172B4D);
}
.hero-meta-dot {
  color: var(--text-3, #6B778C);
}
.hero-meta-date {
  font-weight: 500;
  color: var(--text-2, #42526E);
}
.hero-name {
  grid-area: name;
  margin: 0;
  font-size: 44px;
  font-weight: 700;
  color: var(--text-1, #172B4D);
  letter-spacing: -0.035em;
  line-height: 1.05;
}
.hero-subtitle {
  grid-area: sub;
  margin: 6px 0 0;
  font-size: 15px;
  color: var(--text-2, #42526E);
  line-height: 1.6;
  max-width: 68ch;
}

/* ====================== Live clock widget ======================
 *
 * 跟 meta 同一 y 轴右端内嵌,不再独立占一列跟 H1 抢视觉重。HH:MM:SS mono
 * tabular-nums,秒数跳不抖列宽。setInterval 在 unmount 时清理,不漏计时器。
 *
 * 数字 22px vs H1 44px —— clock 是配饰,不是平起平坐的元素。 */
.hero-clock {
  grid-area: clock;
  justify-self: end;
  text-align: right;
  width: 180px;
}
.clock-time {
  display: block;
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  color: var(--text-1, #172B4D);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.05em;
}
.clock-progress {
  margin-top: 10px;
  height: 4px;
  background: var(--bg-subtle, #F4F5F7);
  border-radius: 2px;
  overflow: hidden;
}
.clock-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-bg-active, #B3D4FF) 0%, var(--accent, #0052CC) 100%);
  transition: width 1s linear;
}
.clock-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-3, #6B778C);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}

.dash-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
  background: var(--error-soft, #FFEBE6);
  border: 1px solid var(--error, #DE350B);
  border-radius: var(--radius, 4px);
  color: var(--error, #DE350B);
  font-size: 14px;
}
.link-btn {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: var(--accent, #0052CC);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  text-decoration: underline;
}

/* Section 容器 —— 单页滚动,每个 section 留 24px 间距 */
.dash-section {
  margin-bottom: 20px;
  background: var(--bg, #FFFFFF);
  border: 1px solid var(--border, #EBECF0);
  border-radius: 10px;
  overflow: hidden;
  transition: box-shadow var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.dash-section:hover {
  border-color: var(--border-strong, #C1C7D0);
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(9, 30, 66, 0.06));
}
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #EBECF0);
  background: var(--bg, #FFFFFF);
}
.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1, #172B4D);
  margin: 0;
  flex: 1;
  min-width: 0;
}
.section-icon {
  font-size: 20px !important;
  color: var(--text-2, #44546F);
}
.section-icon.mention-icon { color: var(--danger); }
.section-icon.personal-icon { color: var(--accent, #0052CC); }
.section-meta {
  font-size: 12px;
  color: var(--text-3, #6B778C);
  background: var(--bg-subtle, #F4F5F7);
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}
.section-link {
  font-size: 13px;
  color: var(--accent, #0052CC);
  text-decoration: none;
  margin-left: auto;
  transition: color var(--duration-fast) ease-out;
}
.section-link:hover { color: var(--accent-hover, #0747A6); text-decoration: underline; }

.section-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.section-list > li:last-child .dash-card {
  border-bottom: 0;
}

.section-loading {
  padding: 8px 0;
}
.row-skeleton {
  display: grid;
  grid-template-columns: 32px 1fr;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #EBECF0);
}
.row-skeleton:last-child { border-bottom: 0; }
.row-skeleton-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>