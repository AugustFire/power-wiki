<script setup lang="ts">
/**
 * HistoryView — Confluence 风格的独立「页面历史」路由(/p/:id/history)。
 *
 * 布局:左中右三列 grid(280 sidebar / 340 list / 1fr diff),跟 ReadView
 * 一样保留 Sidebar chrome —— 「历史是同一页的另一个角度」,导航不漂。
 *
 * 数据契约:
 *   - 选中的版本由父级决定,点 VersionList 上的某一行 → onSelect
 *     → selectedVersion.value = v,然后右栏 VersionDiffView 用
 *     previousVersion(v_{n-1})的 contentHTML 作为基线 + selectedVersion
 *     的 contentHTML 作为新版,重新算 diff —— 展示「这次提交本身改了什么」。
 *   - 默认选中:有 ≥ 2 条时选「非 current 的最新一条」(DESC 排序的 idx===1),
 *     这样进页面就能看到「最近一次提交改了什么」,而不是空 diff。跟
 *     Confluence / Notion / GitHub 一致。
 *
 * Auto-save 行为:从 /p/:id/edit 跳到 /p/:id/history 时,EditView 的
 * onBeforeRouteLeave 已经先 await 了 flushPendingSave,所以本页打开时
 * 内容永远是 last persisted,没有「草稿触发的边界 snapshot 跟本页最新
 * 一致」这种边界问题。如果用户从 ReadView 来,自然没有快照问题。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import VersionList from '@/components/page/VersionList.vue'
import VersionDiffView from '@/components/page/VersionDiffView.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { usePageVersions } from '@/composables/usePageVersions'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import type { PageVersion } from '@power-wiki/shared'

const props = defineProps<{ id: string }>()
const pagesStore = usePagesStore()
const router = useRouter()
const versionsComposable = usePageVersions()

const page = computed(() => pagesStore.getPage(props.id))

/** 浏览器 tab 标题:"<页面名> · 历史版本 · power-wiki"。page 没解析出时退 BASE。 */
useDocumentTitle(() => (page.value ? `${page.value.title} · 历史版本` : null))

/**
 * `state` 直接调 versionsComposable.state(id) —— 不包 computed。
 *
 * 早期(已修)有个 bug:`state` 包了 computed + refresh() 调
 * byPage.delete(id),导致 fetch 完成后 get(id) 拿到一个**新** reactive
 * 写入数据,但 HistoryView 的 `state` computed 缓存的是**旧** reactive
 * 引用,template 永远读旧对象 —— 经典的「响应式断链」,history 页全空白。
 * 修复:refresh 不再 byPage.delete,数据写到同一个 reactive 上,引用稳定;
 * 同时这里继续用 function 而非 computed(更直白,不需要缓存)。
 * 性能:一页历史就 20-30 个 version,get(id) 是 Map.get O(1),可以忽略。
 */
function getState() {
  return versionsComposable.state(props.id)
}

const selectedVersion = ref<PageVersion | null>(null)

/**
 * 给定 sortedVersions (DESC),根据当前选中的 version 找出 prev。
 * DESC 排列下,选中 v_n,prev 就是「版本号 = n-1」的那条。
 *   - 选中 v3 → prev = v2
 *   - 选中 v1 → prev = null
 *   - 选中 current(row idx===0,versionNumber === 列表中最大)→ prev = v_{max-1}
 *     但 current 永远跟 prev 不同(diff 才有意义),所以 prev 仍可算;不过
 *     UI 上我们让 current row 不进入「selectedVersion」流程(idx===0 时
 *     VersionList 不让点,所以选中态只能是 idx>=1 的 row)。
 *
 * 用 Map by id 一次建,多次查找 O(1) —— sortedVersions 频繁变,computed
 * 每次重算时重建 O(N) 太浪费。
 */
const versionByNumber = computed(() => {
  const m = new Map<number, PageVersion>()
  for (const v of sortedVersions.value) m.set(v.versionNumber, v)
  return m
})

const previousVersion = computed<PageVersion | null>(() => {
  const sel = selectedVersion.value
  if (!sel) return null
  return versionByNumber.value.get(sel.versionNumber - 1) ?? null
})

/**
 * 列表的展示顺序:DESC(最新 → 最早)。
 * - 跟 VersionList.sortedVersions 同算法,必须保持一致,否则
 *   HistoryView 跟 VersionList 的选中态会错位。
 * - 后端已经按 DESC 返,这里再 def 一次保证 idx===0 是当前版。
 */
const sortedVersions = computed(() => {
  const vs = getState().versions
  return [...vs].sort((a, b) => b.versionNumber - a.versionNumber)
})

/**
 * 默认选中的版本:
 *   - 如果只有 1 条(就是当前版):选它(diff 区域会把 v1 整段内容当作新增
 *     渲染,看到的是首版时的初始内容)
 *   - 如果有 ≥ 2 条:选**最新历史版本**(非当前版的最新一次) —— 这样右侧
 *     立刻能展示「这次提交相对前一版的差异」,而不是空 diff。
 *   - 这是 Confluence / Notion / Google Docs 的默认行为:「最近改了什么」是
 *     用户进入历史页最想看的。
 *   - 不要选第一条(当前版):current row 永远没有 previous,渲染为「整段
 *     当作新增」,跟 v1 一致 —— 但 default 选 idx 1 更能直接展示「最近
 *     一次提交」的内容,信息量更大。
 *   - 不要选最后一条(最早版):跨度过大,差异不直观。
 */
watch(
  () => sortedVersions.value,
  (vs) => {
    if (vs.length > 0 && !selectedVersion.value) {
      const target = vs.length >= 2 ? vs[1] : vs[0]
      if (target) selectedVersion.value = target
    }
  },
  { immediate: true },
)

/**
 * 路由进入 history 时,无条件重拉(清缓存 → 拉新)。
 *
 * 为什么不能复用缓存:
 *  - 用户在 read 视图编辑 → idle 30s 自动打 snapshot → 此时进 history
 *    应该看到刚刚的 snapshot;但 usePageVersions 的 module-level 缓存
 *    可能还停留在 read 期间的状态。
 *  - 别人(同 space 成员)可能在写当前页;用户切到 history 应该看到
 *    最新一次编辑。
 *  - 跟 EditView 的「边界快照」契约配套:进 history 的瞬间,「最新版本」
 *    必须等于「后端实际最新版本」,不能是 read 期间拉过的那一份。
 *
 * VersionList 内部的 watch + refresh 不删 —— 那是给「同路由 hot reload」
 * / 子组件重挂的场景兜底。这里是路由级 + view 级的更早一环,保证先
 * 把数据洗到最新,再让子组件 watch 触发。
 */
onMounted(() => {
  void versionsComposable.refresh(props.id)
})

/** 切换 page id(同一 history 路由,理论上 :id 不会变,但留个保险) */
watch(
  () => props.id,
  () => {
    selectedVersion.value = null
    void versionsComposable.refresh(props.id)
  },
)

function onSelect(v: PageVersion) {
  selectedVersion.value = v
}

function goBack() {
  router.push(`/p/${props.id}`)
}

/** 把 changeNote 翻译成中文标签 —— 跟 VersionList.noteFor 同算法,
 *  集中在这一个函数里方便 diff header 复用。空 note / 自动 snapshot
 *  都标「自动快照」,用户主动 restore 出来的标「从历史恢复」。 */
function formatChangeNote(note: string | null | undefined): string {
  if (note?.startsWith('restored from v')) return '从历史恢复'
  if (note && note.trim()) return note.trim()
  return '自动快照'
}
</script>

<template>
  <div class="history-shell">
    <div class="subheader">
      <div class="left-actions">
        <button
          type="button"
          class="btn ghost back-link"
          :title="`返回 ${page?.title ?? '页面'}`"
          aria-label="返回页面"
          @click="goBack"
        >
          <span class="material-symbols-outlined">arrow_back</span>
          返回页面
        </button>
      </div>
      <div class="page-context">
        <span class="material-symbols-outlined page-context-icon">history</span>
        <span class="history-page-title">{{ page?.title ?? '加载中…' }}</span>
        <span class="page-context-sep">·</span>
        <span class="page-context-label">版本历史</span>
      </div>
      <div class="page-actions">
        <span v-if="getState().versions.length > 0" class="vp-count">
          共 {{ getState().versions.length }} 个版本
        </span>
      </div>
    </div>

    <div class="layout history-layout">
      <Sidebar />

      <section class="history-list-pane" aria-label="版本列表">
        <div class="history-list-header">
          <span class="material-symbols-outlined">schedule</span>
          <span>时间线</span>
        </div>
        <div class="history-list-body">
          <VersionList
            v-if="page"
            :page-id="props.id"
            @select="onSelect"
          />
        </div>
      </section>

      <section class="history-diff-pane" aria-label="差异预览">
        <div class="history-diff-header">
          <template v-if="selectedVersion">
            <span class="diff-label">
              <span class="material-symbols-outlined">compare_arrows</span>
              <template v-if="previousVersion">
                v{{ previousVersion.versionNumber }} → v{{ selectedVersion.versionNumber }}
                的变更
              </template>
              <template v-else>
                v{{ selectedVersion.versionNumber }} (初始版本)
              </template>
            </span>
            <span class="diff-meta">
              {{ selectedVersion.editedByName ?? '未知作者' }}
              · {{ formatChangeNote(selectedVersion.changeNote) }}
            </span>
          </template>
          <template v-else>
            <span class="diff-label">
              <span class="material-symbols-outlined">compare_arrows</span>
              选择左侧版本查看差异
            </span>
          </template>
        </div>
        <div class="history-diff-body">
          <template v-if="selectedVersion !== null && page">
            <VersionDiffView
              :version="selectedVersion"
              :previous-version="previousVersion"
            />
          </template>
          <div v-else class="diff-placeholder">
            <Skeleton height="120px" radius="8px" />
            <Skeleton height="120px" radius="8px" />
            <Skeleton height="120px" radius="8px" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.history-shell {
  min-height: calc(100vh - var(--topbar-h));
}

.subheader {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px;
}
.left-actions { display: inline-flex; align-items: center; }
.back-link {
  gap: 4px;
  font-weight: 500;
}
.back-link .material-symbols-outlined {
  font-size: 18px;
}

.page-context {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  font-size: 14px;
  color: var(--text-2);
}
.page-context-icon {
  font-size: 18px;
  color: var(--text-3);
}
.history-page-title {
  /* breadcrumb 形态的页面名 —— 跟 ReadView 大标题(.page-title,
   * components.css 里 36px)区分,避免命名冲突。父级 .page-context
   * 设了 14px,这里不重复设 font-size,直接继承。 */
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}
.page-context-sep {
  color: var(--text-3);
}
.page-context-label {
  color: var(--text-3);
  font-size: 13px;
}

.page-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.vp-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  background: var(--bg-subtle);
  border-radius: 10px;
  padding: 1px 8px;
}

/* 三列 grid:sidebar / 340 list / 1fr diff。高度跟 ReadView 一致,
 * 子面板各自 overflow-y 滚动。 */
.history-layout {
  display: grid;
  grid-template-columns: var(--sidebar-w) 340px 1fr;
  height: calc(100vh - var(--topbar-h) - var(--sub-h));
  column-gap: 0;
}

.history-list-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
}
.history-list-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px;
  height: 48px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.history-list-header .material-symbols-outlined {
  font-size: 16px;
}
.history-list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.history-diff-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
}
.history-diff-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  height: 48px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}
.diff-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}
.diff-label .material-symbols-outlined {
  font-size: 18px;
  color: var(--accent);
}
.diff-meta {
  font-size: 12.5px;
  color: var(--text-3);
  margin-left: auto;
}
.history-diff-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px 32px;
}

.diff-placeholder {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}
</style>
