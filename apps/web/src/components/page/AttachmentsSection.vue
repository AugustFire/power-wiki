<script setup lang="ts">
/**
 * AttachmentsSection — page 级附件列表的展示 + 下载 + 删除。
 *
 * 数据层 `usePageAttachments(pageId)`,自带 GET 缓存(30s TTL)与 pageId
 * 变化自动重拉;本组件只负责渲染。
 *
 * 视觉语义:与 ReadView 底部的 Labels / reactions / subpages 同级 —— 行内
 * 元数据 + 子资源。Count=0 时不渲染(零干扰),不学 CommentsSection 留
 * "暂无评论" 占位。
 *
 * 删除语义:attachment 是 page 级资产,page_versions.contentJSON 持有
 * attachment id —— 显式删 attachment 会让当前正文与历史快照同时断链,
 * 无法回滚。删除按钮走 `useConfirm` 强提示(danger 样式),文案逐条说明
 * 影响;确认后调 `usePageAttachments.remove(id)`(乐观更新 + 失败回滚 +
 * invalidatePrefix),失败用 toast 报错并保留行。
 *
 * 行布局:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ [缩略图或文件图标] 文件名(可点击下载)     ·  1.2 MB   ↓  🗑  │
 *   │                       上传者 · 时间                          │
 *   └──────────────────────────────────────────────────────────────┘
 * download / delete 按钮都 hover 才浮出(默认 opacity: 0),整行 hover 时
 * 浮出,避免整行 anchor 误触下载(同 ImageAttachmentView 文件卡的同款模式)。
 *
 * 缩略图:image 用 `/api/attachments/:id/raw` 的 inline 48×48 圆角;
 * 非 image 用 `fileIconFor(mime).icon/color`,与正文 file 卡片保持
 * 同一份颜色事实来源(apps/web/src/editor/attachmentIcon.ts)。
 */
import { computed, ref, toRef } from 'vue'
import type { Attachment } from '@power-wiki/shared'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatBytes } from '@/editor/imageAttachmentExtension'
import { fileIconFor } from '@/editor/attachmentIcon'
import { usePageAttachments } from '@/composables/usePageAttachments'
import { useConfirm } from '@/composables/useConfirm'
import { useToast } from '@/composables/useToast'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import Skeleton from '@/components/ui/Skeleton.vue'

const props = defineProps<{ pageId: string }>()

// pageId 走 prop ref(toRef),composable 内部 watch 会响应路由切页
const { items, loading, error, refresh, remove } = usePageAttachments(
  toRef(props, 'pageId'),
)
const { confirm } = useConfirm()
const toast = useToast()

/** 算 0 附件 → 不渲染(loading+empty → 也不渲染,免得闪一下骨架又消失)。 */
const visible = computed(
  () => !loading.value && !error.value && items.value.length > 0,
)

/** 当前正在删除的行 id(单行 in-flight,防止重复点击)。 */
const deletingId = ref<string | null>(null)

/**
 * 折叠状态 —— 默认折叠,点 header 切换。
 * 不持久化到 sessionStorage:用户明确说「默认隐藏」,所以每次新建
 * 组件实例(路由切页 → 视图重建)回到折叠。如果想保持跨页状态再说。
 */
const expanded = ref(false)
function toggle(): void {
  expanded.value = !expanded.value
}

function uploaderLabel(a: Attachment): string {
  return a.uploaderName?.trim() || a.uploaderId.slice(0, 6)
}

function isImageKind(a: Attachment): boolean {
  return a.kind === 'image' || a.mimeType.startsWith('image/')
}

function fileIcon(mime: string): { icon: string; color: string } {
  // image/* 走缩略图分支,这里只处理非 image
  if (mime.startsWith('image/')) return { icon: 'image', color: 'var(--accent)' }
  return fileIconFor(mime)
}

/**
 * 删除流程:先弹 confirm,文案逐条说明正文+历史版本断链 + 不可恢复;
 * 用户确认 → 乐观从 items 拿掉(用 composable.remove)→ 失败 toast + 回滚。
 * 删除时该行整行降透明度 + 禁用按钮,让用户看到 in-flight 状态。
 */
async function onDelete(a: Attachment): Promise<void> {
  if (deletingId.value) return
  const ok = await confirm({
    title: '删除附件?',
    message:
      `「${a.originalFilename}」将被永久删除,无法恢复。\n\n` +
      `• 当前正文中引用此文件的地方会显示为占位 / 404\n` +
      `• 此页所有历史快照(版本历史中的内容)将同时失效\n` +
      `• 复制 / 导出 / 还原到含此附件的旧版本都会断链`,
    danger: true,
    confirmText: '永久删除',
    cancelText: '取消',
  })
  if (!ok) return
  deletingId.value = a.id
  try {
    await remove(a.id)
    toast.success(`已删除 ${a.originalFilename}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '未知错误'
    toast.error(`删除失败: ${msg}`)
  } finally {
    deletingId.value = null
  }
}
</script>

<template>
  <section v-if="visible" class="attachments-section" aria-label="页面附件">
    <div
      class="as-header"
      role="button"
      tabindex="0"
      :title="expanded ? '收起附件' : '展开附件'"
      :aria-label="`附件 (${items.length})`"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="as-title">
        <span class="material-symbols-outlined as-title-icon">attach_file</span>
        <span class="as-count">({{ items.length }})</span>
      </span>
      <span class="material-symbols-outlined as-chevron">{{ expanded ? 'expand_less' : 'expand_more' }}</span>
    </div>

    <div class="as-list-wrap" :class="{ 'is-expanded': expanded }">
      <ul class="as-list">
      <li
        v-for="a in items"
        :key="a.id"
        class="as-row"
        :class="{
          'as-row-image': isImageKind(a),
          'as-row-file': !isImageKind(a),
          'is-deleting': deletingId === a.id,
        }"
      >
        <!-- 缩略图 / 文件图标 -->
        <div class="as-thumb">
          <img
            v-if="isImageKind(a)"
            :src="api.attachments.getRawUrl(a.id)"
            :alt="a.originalFilename"
            loading="lazy"
            class="as-thumb-img"
          />
          <span
            v-else
            class="material-symbols-outlined as-thumb-icon"
            :style="{ color: fileIcon(a.mimeType).color }"
          >{{ fileIcon(a.mimeType).icon }}</span>
        </div>

        <!-- 文件名 + 元数据(可点击下载,与 download 按钮共享同一 url) -->
        <div class="as-body">
          <a
            :href="api.attachments.getRawUrl(a.id)"
            :download="a.originalFilename"
            class="as-name"
            :title="a.originalFilename"
            @mousedown.stop
          >{{ a.originalFilename }}</a>
          <div class="as-meta">
            <span class="as-uploader">
              <UserAvatar
                :size="20"
                :label="uploaderLabel(a)"
                :color="'var(--text-3)'"
                :user-id="a.uploaderId"
              />
              <span class="as-uploader-name">{{ uploaderLabel(a) }}</span>
            </span>
            <span class="as-dot">·</span>
            <span class="as-size">{{ formatBytes(a.sizeBytes) }}</span>
            <span class="as-dot">·</span>
            <span class="as-time">{{ formatRelativeTime(a.createdAt) }}</span>
          </div>
        </div>

        <!-- hover 才浮出的下载按钮(显式,与整行可点 anchor 错开,避免误触) -->
        <a
          :href="api.attachments.getRawUrl(a.id)"
          :download="a.originalFilename"
          class="as-download"
          :title="`下载 ${a.originalFilename}`"
          :aria-label="`下载 ${a.originalFilename}`"
          @mousedown.prevent
        >
          <span class="material-symbols-outlined">download</span>
        </a>

        <!-- hover 才浮出的删除按钮(显式危险操作,confirm 兜底) -->
        <button
          type="button"
          class="as-delete"
          :title="`删除 ${a.originalFilename}`"
          :aria-label="`删除 ${a.originalFilename}`"
          :disabled="deletingId === a.id"
          @click="onDelete(a)"
        >
          <span class="material-symbols-outlined">delete</span>
        </button>
      </li>
    </ul>
    </div>
  </section>

  <!-- 错误态:不阻塞正文,只一行紧凑提示,给个重试按钮 -->
  <div v-else-if="error" class="attachments-error" role="status">
    <span class="material-symbols-outlined as-err-icon">error</span>
    <span class="as-err-text">附件列表加载失败</span>
    <button type="button" class="as-retry" @click="refresh()">重试</button>
  </div>

  <!-- loading + 0 行的初次空态:画 3 行 skeleton 占位,跟 CommentsSection 同款模式 -->
  <section
    v-else-if="loading && items.length === 0"
    class="attachments-section"
    aria-busy="true"
  >
    <h3 class="as-title">
      <span class="material-symbols-outlined as-title-icon">attach_file</span>
      <span class="as-count">&nbsp;</span>
    </h3>
    <Skeleton :count="3" height="40px" />
  </section>
</template>

<style scoped>
/* ── 折叠 header —— 行级元数据标题,跟 .subpages-title / .page-reactions
     同款克制风格:不画 button 化的灰底 / 圆角 / padding,只保留
     cursor + hover 时文字变 accent,跟「行内链接」同语义 ── */
.attachments-section { margin-top: 24px; }
.as-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 4px 0;
  margin: 0 0 8px;
  background: transparent;
  border: 0;
  cursor: pointer;
  user-select: none;
  font: inherit;
  color: inherit;
}
.as-title {
  font-size: var(--text-base, 14px);
  font-weight: 600;
  color: var(--text-1, #172b4d);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.as-title-icon {
  font-size: 18px;
  color: var(--text-3, #6b778c);
  transition: color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.as-count {
  font-weight: 400;
  color: var(--text-3, #6b778c);
  font-size: var(--text-sm, 13px);
}
.as-chevron {
  font-size: 18px;
  color: var(--text-3, #6b778c);
  transition: color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.as-header:hover .as-title,
.as-header:hover .as-title-icon,
.as-header:hover .as-chevron { color: var(--accent, #0052cc); }
.as-header:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 2px;
}

/* ── 折叠容器:CSS Grid 0fr ↔ 1fr 平滑展开,内容自适应高度 ── */
.as-list-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 200ms var(--ease-out, ease);
}
.as-list-wrap.is-expanded { grid-template-rows: 1fr; }
.as-list-wrap > .as-list { min-height: 0; overflow: hidden; }

/* ── 行 —— 单行水平,无外框、无行间 border,跟 .subpage-row /
     .comment-item 同款:靠 padding + row 间小间距区分,hover bg 是
     唯一视觉反馈。无卡片感,跟文章主区融为一体 ── */
.as-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.as-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border-radius: var(--radius-md, 4px);
  transition: background var(--duration-fast, 120ms) var(--ease-out, ease);
}
.as-row + .as-row { margin-top: 2px; }
.as-row:hover { background: var(--accent-bg-soft, rgba(0, 82, 204, 0.04)); }
/* 删除中:整行降透明度,提示用户 in-flight;按钮已 disabled 兜底防重复点击。 */
.as-row.is-deleting {
  opacity: 0.55;
  pointer-events: none;
}

.as-thumb {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-subtle, #ebecf0);
  border-radius: var(--radius-md, 4px);
  overflow: hidden;
}
.as-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.as-thumb-icon {
  font-size: 22px;
}

/* ── 中间文字区(文件名 + 元数据)—— 撑开剩余空间,文件名单行省略 ── */
.as-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.as-name {
  font-size: var(--text-sm, 13px);
  font-weight: 500;
  color: var(--text-1, #172b4d);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  display: inline-block;
}
.as-name:hover {
  color: var(--accent, #0052cc);
  text-decoration: underline;
}
.as-name:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 1px;
  border-radius: 2px;
}

.as-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs, 12px);
  color: var(--text-3, #6b778c);
  min-width: 0;
}
.as-uploader {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.as-uploader-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}
.as-dot { color: var(--text-3, #6b778c); }
.as-size, .as-time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ── hover 才浮出的 download 按钮 —— 避免整行 anchor 误触下载 ── */
.as-download {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md, 4px);
  color: var(--text-3, #6b778c);
  text-decoration: none;
  opacity: 0;
  transition: opacity var(--duration-fast, 120ms) var(--ease-out, ease),
              background var(--duration-fast, 120ms) var(--ease-out, ease),
              color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.as-download .material-symbols-outlined { font-size: 18px; }
.as-row:hover .as-download,
.as-download:focus-visible { opacity: 1; }
.as-download:hover {
  background: var(--accent-bg-active, rgba(0, 82, 204, 0.16));
  color: var(--accent, #0052cc);
}
.as-download:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 1px;
}

/* ── hover 才浮出的 delete 按钮 —— 与 .as-download 同款浮出逻辑,danger 色 ── */
.as-delete {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  border-radius: var(--radius-md, 4px);
  color: var(--text-3, #6b778c);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--duration-fast, 120ms) var(--ease-out, ease),
              background var(--duration-fast, 120ms) var(--ease-out, ease),
              color var(--duration-fast, 120ms) var(--ease-out, ease);
}
.as-delete .material-symbols-outlined { font-size: 18px; }
.as-row:hover .as-delete,
.as-delete:focus-visible { opacity: 1; }
.as-delete:hover {
  background: var(--danger-soft, #ffebe6);
  color: var(--danger, #de350b);
}
.as-delete:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 1px;
}
.as-delete:disabled { cursor: not-allowed; }

/* ── 错误行 —— 单行紧凑 ── */
.attachments-error {
  margin-top: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--danger-soft, #ffebe6);
  border-radius: var(--radius-md, 4px);
  color: var(--danger, #de350b);
  font-size: var(--text-sm, 13px);
}
.as-err-icon { font-size: 18px; }
.as-err-text { flex: 1; }
.as-retry {
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  font-size: var(--text-xs, 12px);
  font-weight: 600;
  padding: 2px 10px;
  border-radius: var(--radius-md, 4px);
  cursor: pointer;
}
.as-retry:hover { background: rgba(222, 53, 11, 0.08); }
</style>
