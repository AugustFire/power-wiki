<script setup lang="ts">
/**
 * PageLinkPreview — 内部 wiki 链接 hover 卡片预览.
 *
 * 设计动机:Wiki 页面之间交叉引用频繁,点开 + 看完 + 返回这套动作
 * 打断阅读流。Notion / Linear / Confluence 都做了"hover 链接 0.5s
 * 弹卡片"——内部使用场景特别需要。
 *
 * 工作流:
 *   1. sanitize.ts 在内部 /p/:id 链接上加 .internal-page-link + data-page-id
 *   2. ReadView 监听 .internal-page-link 的 mouseenter/leave,500ms 后挂载本组件
 *   3. 本组件 mount 后立即调 api.pages.get(id),数据返回后渲染
 *   4. 父组件清掉 v-if → 卸载
 *
 * 缓存策略:模块级 Map<pageId, PreviewEntry>,5 分钟 TTL,避免重复
 * hover 同一页时反复打 API。失败 / 404 / null 都缓存为 entry 防止
 * "打开失败页"反复打。
 *
 * 定位:跟 UserPopover 同套 —— anchor.getBoundingClientRect() 算
 * 居中位置,边界检测贴 viewport 边。Teleport 到 body 避免受 scoped
 * overflow 影响。
 *
 * 不做的事:
 *   - 不做滚动跟随(打开卡片后页面滚动,卡片留在原地,符合行业惯例)
 *   - 不做嵌套(卡片里再有内部链接不二次触发)
 *   - 不做 pageRef 块级卡片支持(初版只做行内 <a>,block 跳过)
 */
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/lib/api'
import type { PageNode } from '@power-wiki/shared'

const props = withDefaults(
  defineProps<{
    pageId: string
    anchor?: HTMLElement | null
  }>(),
  { anchor: null },
)

interface PreviewEntry {
  page: PageNode | null
  ts: number
}
const CACHE = new Map<string, PreviewEntry>()
const TTL_MS = 5 * 60 * 1000

const page = ref<PageNode | null>(null)
const loading = ref(true)
const popRef = ref<HTMLElement | null>(null)
const style = ref<{ top: string; left: string }>({ top: '0px', left: '0px' })

/** 从 contentHTML 抽纯文本前 100 字做摘要。 */
function extractExcerpt(html: string): string {
  if (!html) return ''
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  // 移除 callout / blockquote 等装饰元素的纯文本噪音
  const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim()
  return text.length > 100 ? text.slice(0, 100) + '…' : text
}

const excerpt = computed(() => (page.value ? extractExcerpt(page.value.contentHTML) : ''))

async function loadPage(id: string) {
  loading.value = true
  const cached = CACHE.get(id)
  if (cached && Date.now() - cached.ts < TTL_MS) {
    page.value = cached.page
    loading.value = false
    return
  }
  try {
    const data = await api.pages.get(id)
    page.value = data
    CACHE.set(id, { page: data, ts: Date.now() })
  } catch {
    // 失败缓存为 null entry,避免反复打
    page.value = null
    CACHE.set(id, { page: null, ts: Date.now() })
  } finally {
    loading.value = false
  }
}

function position() {
  const anchor = props.anchor
  const pop = popRef.value
  if (!anchor || !pop) return
  const aRect = anchor.getBoundingClientRect()
  const pRect = pop.getBoundingClientRect()
  const GAP = 10
  const vw = window.innerWidth
  const vh = window.innerHeight

  // 默认浮在 anchor 上方,空间不够翻到下方
  let top = aRect.top - pRect.height - GAP
  if (top < 8) top = aRect.bottom + GAP

  // 水平居中,出 viewport 贴边
  let left = aRect.left + aRect.width / 2 - pRect.width / 2
  if (left < 8) left = 8
  if (left + pRect.width > vw - 8) left = vw - pRect.width - 8

  // 垂直兜底
  if (top + pRect.height > vh - 8) top = Math.max(8, vh - pRect.height - 8)

  style.value = { top: `${top}px`, left: `${left}px` }
}

onMounted(() => {
  loadPage(props.pageId)
  position()
})

watch(() => props.anchor, () => requestAnimationFrame(() => position()))
watch(() => props.pageId, (id) => loadPage(id))
</script>

<template>
  <Teleport to="body">
    <div
      ref="popRef"
      class="page-link-preview"
      :style="{ top: style.top, left: style.left }"
      role="tooltip"
    >
      <div v-if="loading" class="plp-loading">
        <span class="plp-spinner" aria-hidden="true"></span>
        加载中…
      </div>
      <div v-else-if="!page" class="plp-empty">无法预览此页</div>
      <div v-else class="plp-content">
        <div class="plp-header">
          <span class="material-symbols-outlined plp-icon" aria-hidden="true">
            {{ page.icon || 'description' }}
          </span>
          <span class="plp-title">{{ page.title || '无标题' }}</span>
        </div>
        <div v-if="excerpt" class="plp-excerpt">{{ excerpt }}</div>
        <div v-if="page.authorName" class="plp-author">
          <span class="plp-author-avatar" :style="{ background: page.authorColor || 'var(--accent)' }">
            {{ page.authorName.slice(0, 1).toUpperCase() }}
          </span>
          {{ page.authorName }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.page-link-preview {
  position: fixed;
  z-index: var(--z-popover, 1000);
  width: 320px;
  max-width: calc(100vw - 16px);
  padding: 12px 14px;
  background: var(--bg, #fff);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 6px);
  box-shadow: var(--shadow-lg);
  pointer-events: none;
  animation: plp-fade 140ms cubic-bezier(0.16, 1, 0.3, 1);
}
.plp-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-sm, 13px);
  color: var(--text-3);
  padding: 4px 0;
}
.plp-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: plp-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes plp-spin { to { transform: rotate(360deg); } }
.plp-empty {
  font-size: var(--text-sm, 13px);
  color: var(--text-3);
  padding: 4px 0;
}
.plp-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plp-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plp-icon {
  font-size: 20px;
  color: var(--accent);
  flex-shrink: 0;
}
.plp-title {
  font-size: var(--text-base, 14px);
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.plp-excerpt {
  font-size: var(--text-sm, 13px);
  color: var(--text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.plp-author {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs, 12px);
  color: var(--text-3);
  margin-top: 2px;
}
.plp-author-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-invert);
  flex-shrink: 0;
}
@keyframes plp-fade {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>