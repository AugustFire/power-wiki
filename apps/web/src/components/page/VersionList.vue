<script setup lang="ts">
/**
 * VersionList — 页面历史的时间线列表(HistoryView 左栏)。
 *
 * 跟右栏 VersionDiffView 的关系:
 *   - 本组件只负责「列表」。选中一行 emit `select(version)`,由 HistoryView
 *     推到右栏 diff。所以列表里**不再**重复渲染 diff——避免双份对照。
 *   - 选中态(`vp-item.selected`)高亮当前右栏正在对比的那一行,dot 也
 *     描上 accent 边。
 *
 * 顺序约定:
 *   - API 已经按 `versionNumber DESC` 返回(后端 `pageVersions.ts:111`)。
 *   - **最新版本在列表最上方**(用户预期:点开历史 → 第一眼看到最近
 *     改了什么;asc 把"最初的版本"放最上违反直觉)。
 *   - 跟 Confluence / Notion / Google Drive / GitHub commits 一致。
 *   - idx === 0 → 最新(当前)版本(打「当前」tag);末尾 → 最早版本。
 *
 * 时间线连接线:每行单独画一段 line,首行 `top` 收在第一个 dot 的竖
 * 直中线,末行 `bottom` 收在最后一个 dot 的中线。这样无论行内展开与否,
 * 连接线都穿过每个 dot,首尾不留白。
 */
import { computed, ref, watch } from 'vue'
import { usePageVersions } from '@/composables/usePageVersions'
import { usePagesStore } from '@/stores/pages'
import { useUiStore } from '@/stores/ui'
import Skeleton from '@/components/ui/Skeleton.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { formatRelativeTime } from '@/lib/relativeTime'
import type { PageVersion } from '@power-wiki/shared'

const props = defineProps<{
  pageId: string
}>()

const emit = defineEmits<{
  /** 用户点了某一行;父视图把对应 version 推到右栏 diff。 */
  select: [version: PageVersion]
}>()

const ui = useUiStore()
const pagesStore = usePagesStore()
const versionsComposable = usePageVersions()

const state = computed(() => versionsComposable.state(props.pageId))

/** DESC 排序(后端 `pageVersions.ts:111` 已 DESC,这里再 def 一遍,
 *  防止以后后端改了 / 缓存旧数据让 idx===0 不再是当前版)。
 *  最新版本(idx===0)放最上方 —— 用户预期「点开历史先看最近改了什么」。 */
const sortedVersions = computed(() => {
  const vs = state.value.versions
  return [...vs].sort((a, b) => b.versionNumber - a.versionNumber)
})

const restoringId = ref<string | null>(null)
/** 选中态由父级管控(HistoryView 的 selectedVersion);本地镜像一份用于
 *  高亮 dot。 */
const selectedId = ref<string | null>(null)

async function refresh() {
  selectedId.value = null
  await versionsComposable.refresh(props.pageId)
}

watch(
  () => props.pageId,
  () => {
    void refresh()
  },
  { immediate: true },
)

/** 父级选了某个 version → 高亮它 */
watch(
  () => props.pageId,
  () => {
    selectedId.value = null
  },
)

async function loadMore() {
  await versionsComposable.loadMore(props.pageId)
}

function onRowClick(v: PageVersion) {
  selectedId.value = v.id
  emit('select', v)
}

async function restore(v: PageVersion) {
  if (restoringId.value) return
  restoringId.value = v.id
  try {
    // 后端 insert 一行新 version + 更新 page content。
    // 返回值(updated PageNode)就是「恢复后页面」的最新事实。
    const updated = await versionsComposable.restore(props.pageId, v.id)
    // 1) 把 updated 写回 pagesStore —— 这样用户回 /p/:id 时,ReadView
    //    立刻看到恢复出来的内容,不用刷新浏览器。
    //    不这么做的话,ReadView 会用 store 里旧的 PageNode,显示
    //    「恢复前」的内容,用户以为没生效 → 误点第二次 restore。
    pagesStore.syncPageFromServer(updated)
    // 2) 重拉 version 列表 —— 顶部会多一条「restored from vN」,
    //    用户立刻看到恢复生效。不刷新的话列表停留在恢复前,用户
    //    看着没变化,以为操作失败。
    await versionsComposable.refresh(props.pageId)
    // 3) 清掉本地图标(老 row 已被新 row 顶到 idx 1),HistoryView
    //    的默认选中逻辑会把 selectedVersion 设到 idx 1(刚 restore
    //    的源版本),展示「恢复结果」的差异。
    selectedId.value = null
  } catch (e) {
    ui.setError(`恢复失败: ${e instanceof Error ? e.message : '未知错误'}`)
  } finally {
    restoringId.value = null
  }
}

/** 给 row 一个二级标签 —— 手动 restore 出来的标「从历史恢复」,
 *  自动 snapshot 走 change note(通常空着),留空让阅读位不被占。 */
function noteFor(v: PageVersion): string {
  if (v.changeNote?.startsWith('restored from v')) return '从历史恢复'
  if (v.changeNote && v.changeNote.trim()) return v.changeNote.trim()
  return '自动快照'
}
</script>

<template>
  <div class="version-list">
    <div v-if="state.loading && sortedVersions.length === 0" class="vp-skeleton">
      <Skeleton v-for="i in 5" :key="i" height="68px" radius="8px" />
    </div>
    <div v-else-if="sortedVersions.length === 0" class="vp-empty">
      <span class="material-symbols-outlined">history_toggle_off</span>
      <p>暂无历史版本</p>
      <small>编辑页面后,空闲 30 秒或离开页面会自动创建一个快照。</small>
    </div>
    <template v-else>
      <ol class="vp-list">
        <li
          v-for="(v, idx) in sortedVersions"
          :key="v.id"
          class="vp-item"
          :class="{
            current: idx === 0,
            selected: selectedId === v.id,
            restoring: restoringId === v.id,
          }"
        >
          <button class="vp-row" type="button" @click="onRowClick(v)">
            <span class="vp-timeline-node" aria-hidden="true"></span>
            <div class="vp-main">
              <div class="vp-line-1">
                <span class="vp-version">v{{ v.versionNumber }}</span>
                <!-- idx 0 是当前版;如果是刚 restore 出来的(idx 0 + changeNote 命中
                     「restored from v」),把"当前版本"换成"已恢复"标签,让用户
                     一眼看到这次当前状态是手动恢复出来的,不是普通的边界 snapshot。
                     否则(普通 snapshot / idle / route-leave 自动打),维持"当前版本"。 -->
                <span
                  v-if="idx === 0 && noteFor(v) === '从历史恢复'"
                  class="vp-tag restored"
                >已恢复</span>
                <span
                  v-else-if="idx === 0"
                  class="vp-tag current"
                >当前版本</span>
                <span
                  v-else-if="noteFor(v) === '从历史恢复'"
                  class="vp-tag restored"
                >已恢复</span>
                <span class="vp-time">{{ formatRelativeTime(v.editedAt) }}</span>
              </div>
              <div class="vp-line-2">
                <UserAvatar
                  :size="20"
                  :color="v.editedByColor ?? 'var(--text-3)'"
                  :label="v.editedByName ?? v.editedBy"
                  :avatar-kind="v.editedByAvatarKind ?? null"
                  :avatar-ref="v.editedByAvatarRef ?? null"
                  :user-id="v.editedBy ?? null"
                />
                <span class="vp-author">{{ v.editedByName ?? '未知作者' }}</span>
                <span class="vp-line-2-dot" aria-hidden="true">·</span>
                <span class="vp-line-2-action">{{ noteFor(v) }}</span>
              </div>
            </div>
            <!-- 非首行(非当前版本)右侧显示一个紧凑的恢复图标按钮,inline
                 跟时间对齐 —— 所有行等高,时间线节奏统一。整行点击进入
                 diff,这个按钮单独 click 触发 restore,用 @click.stop 防止
                 冒泡到 vp-row 的选中。 -->
            <span v-if="idx !== 0" class="vp-restore-slot">
              <button
                class="restore-icon-btn"
                type="button"
                :disabled="restoringId === v.id"
                :title="restoringId === v.id ? '恢复中…' : `恢复到 v${v.versionNumber}`"
                :aria-label="`恢复到 v${v.versionNumber}`"
                @click.stop="restore(v)"
              >
                <span class="material-symbols-outlined">settings_backup_restore</span>
              </button>
            </span>
          </button>
        </li>
      </ol>
      <div v-if="state.hasMore" class="vp-load-more">
        <button
          class="vp-load-more-btn"
          type="button"
          :disabled="state.loading"
          @click="loadMore"
        >
          {{ state.loading ? '加载中…' : '加载更早的版本' }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.version-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.vp-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px;
}

.vp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 16px;
  color: var(--text-3);
}
.vp-empty .material-symbols-outlined {
  font-size: 36px;
  opacity: 0.5;
  margin-bottom: 8px;
}
.vp-empty p {
  margin: 4px 0;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
}
.vp-empty small {
  font-size: 12px;
  line-height: 1.55;
}

.vp-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.vp-item {
  position: relative;
  padding: 0 8px;
  margin-bottom: 4px;
}
/* 每行一段 connector 线 —— 上下贯通整行高度。
   dot 中心在 row 内 16.5px(7 + 9/2 + 2 border),所以首行 line 从
   16.5px 开始,末行 line 收在 16.5px,首尾都不露白段。 */
.vp-item::before {
  content: '';
  position: absolute;
  left: 22px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
  z-index: 0;
}
.vp-item:first-child::before {
  top: 16px;
}
.vp-item:last-child::before {
  bottom: 16px;
}

.vp-row {
  position: relative;
  display: grid;
  /* 三列:dot 槽 / 内容 / 恢复按钮槽(末行留空槽,所有行等高) */
  grid-template-columns: 44px 1fr auto;
  align-items: stretch;
  gap: 0;
  width: 100%;
  padding: 10px 10px 10px 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.vp-row:hover { background: var(--bg-subtle); }
.vp-item.selected > .vp-row { background: var(--bg-subtle); }
.vp-item.selected > .vp-row:hover { background: var(--bg-subtle); }

/* dot 节点 —— 占据整行高(stretch),让 dot 永远在行内第一行(line-1)
   高度(≈22px)中线 ≈ 11px;dot 真实中心 9/2+border=7px,放在 top:7
   即可。横向 18+9/2+border=22.5px 对齐 connector line 的 22px。 */
.vp-timeline-node {
  position: relative;
  width: 44px;
  flex-shrink: 0;
  min-height: 1px;
}
.vp-timeline-node::before {
  content: '';
  position: absolute;
  left: 18px;
  top: 7px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--bg);
  border: 2px solid var(--border-strong);
  z-index: 1;
  box-sizing: border-box;
}
.vp-item.current .vp-timeline-node::before {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.vp-item.selected .vp-timeline-node::before {
  border-color: var(--accent);
}

.vp-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 2px 0;
}

.vp-line-1 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-1);
  min-width: 0;
}
.vp-line-2 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  /* Author + change note 是「谁 + 改了什么」,主信息。但 change note
     跟 author 视觉权重应有差异 —— author 用 text-2,note 用 text-3。 */
  font-weight: 500;
}
.vp-line-2-dot {
  color: var(--text-3);
  font-weight: 400;
  margin: 0 2px;
}
.vp-line-2-action {
  color: var(--text-3);
  font-weight: 400;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.vp-version {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.vp-tag {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}
.vp-tag.current {
  background: var(--accent-soft);
  color: var(--accent);
}
.vp-tag.restored {
  background: rgba(54, 179, 126, 0.12);
  color: var(--success);
}
.vp-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-2);
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
  padding-right: 8px;
}
.vp-author {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 「恢复此版本」—— inline 在 row 右侧的 icon-only 按钮,所有行等高
   (末行槽位留空,但 grid auto 列占位,时间线节奏不变)。
   hover 时填 accent 强调 —— icon-only 比带文字的版本紧凑得多,
   也避免「恢复此版本」四个字占掉时间标签的视觉重量。 */
.vp-restore-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px 0 0;
}
.restore-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
  transition: background 80ms ease, color 80ms ease, border-color 80ms ease;
}
.restore-icon-btn .material-symbols-outlined {
  font-size: 18px;
}
.restore-icon-btn:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent-soft);
}
.restore-icon-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
/* selected 行:icon 按钮变实心,跟之前 .vp-row-action 实心按钮语义一致 */
.vp-item.selected .restore-icon-btn {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.vp-item.selected .restore-icon-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: white;
}

.vp-load-more {
  padding: 8px 0 4px;
  text-align: center;
}
.vp-load-more-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  font-family: inherit;
}
.vp-load-more-btn:hover:not(:disabled) {
  background: var(--bg-subtle);
  color: var(--text-1);
  border-color: var(--border-strong);
}
.vp-load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
