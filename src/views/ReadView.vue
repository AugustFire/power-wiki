<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useRouter } from 'vue-router'
import Sidebar from '@/components/layout/Sidebar.vue'
import TocPanel from '@/components/layout/TocPanel.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { sanitizeAndHardenLinks } from '@/lib/sanitize'
import { highlightCodeBlocks } from '@/lib/renderHighlight'
import { addHeadingAnchors } from '@/lib/headingAnchors'
import { htmlToJson } from '@/editor/htmlToJson'
import { charCount } from '@/lib/textMetrics'

const props = defineProps<{ id: string }>()
const pagesStore = usePagesStore()
const router = useRouter()

const page = computed(() => pagesStore.getPage(props.id))
const subPages = computed(() => pagesStore.getChildren(props.id))
const safeHtml = computed(() => sanitizeAndHardenLinks(page.value?.contentHTML ?? ''))
const contentEl = ref<HTMLElement | null>(null)

// 面包屑链路(根 → 当前页)
const breadcrumb = computed(() => {
  const chain: { id: string; title: string }[] = []
  let cur = page.value
  while (cur) {
    chain.unshift({ id: cur.id, title: cur.title })
    cur = cur.parentId ? pagesStore.getPage(cur.parentId) : undefined
  }
  return chain
})

// 面包屑溢出处理:超过 3 段就折叠成 ...+最后一截
const visibleBreadcrumb = computed(() => {
  const arr = breadcrumb.value
  if (arr.length <= 3) return { head: arr, ellipsis: false, tail: [] as typeof arr }
  return {
    head: [arr[0]],
    ellipsis: true,
    tail: arr.slice(-2),
  }
})

function goEdit() {
  if (page.value) router.push(`/p/${page.value.id}/edit`)
}
function goPage(id: string) {
  router.push(`/p/${id}`)
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

watch(page, async () => {
  await new Promise((r) => setTimeout(r, 50))
  contentEl.value = document.querySelector('.read-content')
})

// v-html 之后跑一道语法高亮(read 端没有 decorations,需要手动补)
// 监听 props.id:页面切换时,safeHtml 也会变,但 props.id 更稳定地反映路由切换。
// immediate:true 保证首次挂载也跑一次。
watch(
  () => props.id,
  async () => {
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const root = document.querySelector('.read-content') as HTMLElement | null
    contentEl.value = root
    if (root) {
      highlightCodeBlocks(root)
      addHeadingAnchors(root)
    }
  },
  { flush: 'post', immediate: true },
)

// read 视图下点击 task checkbox → 立即 toggle DOM + 写回 store,
// 刷新或下次进入该页仍保留状态。
//
// 流程:
//  1. 拦截 .read-content 内 input[type=checkbox] 的 click,preventDefault 阻止浏览器默认 toggle
//  2. 找到最近 li[data-type=taskItem],切换 data-checked + input.checked
//  3. 克隆 .read-content(去掉 addHeadingAnchors 注入的 a.heading-anchor),
//     拿 innerHTML 作为新的 contentHTML
//  4. 用 htmlToJson 重新生成 contentJSON
//  5. updatePage({ contentJSON, contentHTML }) → store 持久化到 localStorage
//
// 用 WeakSet 跟踪已挂监听器的 DOM,避免重复绑定(同 div 在多次 pageKey 切换时复用)
const boundRoots = new WeakSet<HTMLElement>()
function onContentClick(e: MouseEvent) {
  const root = contentEl.value
  if (!root) return
  const target = e.target as HTMLElement | null
  if (!target || target.tagName !== 'INPUT') return
  const input = target as HTMLInputElement
  if (input.type !== 'checkbox') return
  const li = input.closest('li[data-type="taskItem"]') as HTMLElement | null
  if (!li) return
  e.preventDefault()
  const wasChecked = li.dataset['checked'] === 'true'
  const willChecked = !wasChecked
  li.dataset['checked'] = String(willChecked)
  input.checked = willChecked
  if (willChecked) input.setAttribute('checked', 'checked')
  else input.removeAttribute('checked')
  // 写回 store
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('a.heading-anchor').forEach((a) => a.remove())
  const newHTML = clone.innerHTML
  const p = page.value
  if (!p) return
  pagesStore.updatePage(p.id, {
    contentJSON: htmlToJson(newHTML) as Record<string, unknown>,
    contentHTML: newHTML,
  })
}
function bindContentClick(root: HTMLElement) {
  if (boundRoots.has(root)) return
  root.addEventListener('click', onContentClick)
  boundRoots.add(root)
}
watch(
  contentEl,
  (root) => {
    if (root) bindContentClick(root)
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="read-shell">
    <div class="subheader">
      <div class="breadcrumb">
        <a href="#/">我的知识库</a>
        <template v-for="(c, i) in visibleBreadcrumb.head" :key="'h-' + i">
          <span class="sep">/</span>
          <span class="crumb-item" :class="{ current: i === visibleBreadcrumb.head.length - 1 && !visibleBreadcrumb.ellipsis && visibleBreadcrumb.tail.length === 0 }">
            {{ c.title }}
          </span>
        </template>
        <template v-if="visibleBreadcrumb.ellipsis">
          <span class="sep">/</span>
          <span class="crumb-item ellipsis" title="省略中间层级">…</span>
          <template v-for="(c, i) in visibleBreadcrumb.tail" :key="'t-' + i">
            <span class="sep">/</span>
            <span class="crumb-item" :class="{ current: i === visibleBreadcrumb.tail.length - 1 }">
              {{ c.title }}
            </span>
          </template>
        </template>
      </div>
      <div class="page-actions">
        <button class="btn primary" @click="goEdit">
          <span class="material-symbols-outlined" style="font-size:18px">edit</span>
          编辑
        </button>
      </div>
    </div>

    <div class="layout">
      <Sidebar />

      <div class="content">
        <div class="content-inner read-page">
          <div v-if="page">
            <!-- 标签条(紧凑版) — 只显示有真实数据支撑的状态 -->
            <div class="page-tags">
              <span class="status-pill success">
                <span class="material-symbols-outlined" style="font-size:14px">check_circle</span>
                已发布
              </span>
              <span class="status-pill purple">
                <span class="material-symbols-outlined" style="font-size:14px">account_circle</span>
                {{ page.authorId === 'me' ? '我' : page.authorId }}
              </span>
              <span class="status-pill">
                <span class="material-symbols-outlined" style="font-size:14px">update</span>
                {{ relativeTime(page.updatedAt) }} 编辑
              </span>
            </div>

            <h1 class="page-title">{{ page.title }}</h1>
            <div class="page-byline">
              <span class="author"><UserAvatar :size="20" /> 我</span>
              <span class="dot">·</span>
              <span>创建于 {{ new Date(page.createdAt).toLocaleDateString('zh-CN') }}</span>
              <span class="dot">·</span>
              <span>{{ charCount(page.contentHTML) }} 字</span>
            </div>

            <div ref="contentEl" class="prose read-content" v-html="safeHtml"></div>

            <div v-if="subPages.length > 0" class="subpages">
              <div class="subpages-title">
                <span>子页面</span>
                <span class="count">{{ subPages.length }}</span>
              </div>
              <div
                v-for="sp in subPages"
                :key="sp.id"
                class="subpage-row"
                @click="goPage(sp.id)"
              >
                <span class="material-symbols-outlined doc-icon" style="font-size:18px">description</span>
                <span class="label">{{ sp.title }}</span>
                <span class="updated">{{ relativeTime(sp.updatedAt) }}</span>
              </div>
            </div>

            <div class="reactions">
              <button class="reaction-pill">
                <span>👍</span>
                <span>3</span>
              </button>
              <button class="reaction-pill">
                <span>🎉</span>
                <span>1</span>
              </button>
              <button class="reaction-pill">
                <span>❤️</span>
                <span>2</span>
              </button>
              <button class="reaction-pill add">
                <span class="material-symbols-outlined" style="font-size:16px">add</span>
                <span>添加反应</span>
              </button>
            </div>

            <div class="comments">
              <div class="subpages-title">评论</div>
              <textarea class="comment-input" placeholder="添加评论…" disabled></textarea>
            </div>
          </div>
          <div v-else class="empty">
            <div class="empty-icon">
              <span class="material-symbols-outlined" style="font-size:40px">search_off</span>
            </div>
            <h2>页面不存在</h2>
            <p>该页面已被删除,或链接错误。</p>
            <button class="btn primary" @click="router.push('/')">返回首页</button>
          </div>
        </div>
      </div>

      <TocPanel :content-ref="contentEl" :page-key="page?.id" />
    </div>
  </div>
</template>

<style scoped>
.read-shell { min-height: calc(100vh - var(--topbar-h)); }
.read-page { padding-top: 24px; }

.page-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.crumb-item.ellipsis {
  color: var(--text-3);
  cursor: default;
  font-weight: 600;
  padding: 0 4px;
}

.subpages-title .count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  margin-left: 6px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}
</style>