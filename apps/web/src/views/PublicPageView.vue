<script setup lang="ts">
/**
 * PublicPageView — Phase D 公开链接匿名只读渲染。
 *
 * 路由 `/public/pages/:token`(meta.public=true 不进 requireAuth)。
 * 拿 `:token` 调 GET /api/public/pages/:token 拿 public DTO,渲染
 * Tiptap contentHTML(SSR-safe:contentHTML 是后端预生成的 HTML 字符串,
 * 不用前端组装 prosemirror JSON)。
 *
 * 视觉风格:
 *   - 复用 ReadView 的 .prose typography(token-based)
 *   - header 用 BrandLogo + "公开分享" caption,跟登录页保持一致
 *   - 顶部一个细的 "公开链接 · 只读" hint banner,让匿名访客清楚自己
 *     拿到的是临时链接(给登录入口 power-wiki link 作为 affordance)
 *   - 失败态细分:link_off(失效 / 撤销 / 过期)/ broken_link(无效)
 *     EmptyState 图标,EmptyState 中央对齐、icon + title + hint 三段
 *
 * 设计要点:
 *   - 无 auth,无侧栏,无面包屑导航;只一屏「作者 + 标题 + 内容」
 *   - 不挂 PageRestrictionsDialog / ShareDialog / 编辑按钮
 *   - 公开页跟工作区 UI 完全脱钩,纯只读
 */
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { humanizeApiError } from '@/lib/humanizeApiError'
import { useDocumentTitle } from '@/composables/useDocumentTitle'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import BrandLogo from '@/components/ui/BrandLogo.vue'
import type { PublicPage } from '@power-wiki/shared'

const route = useRoute()
const token = () => String(route.params['token'] ?? '')

const page = ref<PublicPage | null>(null)
const loading = ref(false)
const error = ref<
  | { kind: 'invalid' | 'expired' | 'revoked' | 'trashed' | 'forbidden' | 'load'; message: string; hint?: string }
  | null
>(null)

useDocumentTitle(() => (page.value ? `${page.value.title} · 公开分享` : '公开分享'))

async function load() {
  const t = token()
  if (!t) {
    error.value = { kind: 'invalid', message: '链接无效', hint: '请向分享人索取新链接' }
    return
  }
  loading.value = true
  error.value = null
  try {
    page.value = await api.public.getPage(t)
  } catch (e) {
    if (e instanceof ApiError) {
      const code = (e.body as { code?: string } | null)?.code
      if (code === 'share_expired') {
        error.value = { kind: 'expired', message: '该分享链接已过期', hint: '请向分享人索取新链接' }
      } else if (code === 'share_revoked') {
        error.value = { kind: 'revoked', message: '该分享链接已被撤销', hint: '请向分享人索取新链接' }
      } else if (code === 'share_forbidden') {
        error.value = {
          kind: 'forbidden',
          message: '该页面不可分享',
          hint: '仅共享空间、无查看限制的页面才能生成分享链接',
        }
      } else if (code === 'share_invalid' || e.status === 404 || e.status === 410) {
        error.value = { kind: 'invalid', message: '该分享链接无效', hint: '请向分享人索取新链接' }
      } else {
        error.value = { kind: 'load', message: humanizeApiError(e) }
      }
    } else {
      error.value = { kind: 'load', message: '网络错误,请稍后重试' }
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => route.params['token'], load)

/**
 * 完整时间戳(YYYY-MM-DD HH:mm)用于「最后更新于 X」展示。比
 * `toLocaleString()` 的本地化长格式(`2026/7/22 14:30:00`)更紧凑,
 * 更适合公开页这种「展示用」场景。hover 由 :title 显示更精确的时间。
 */
function formatFullTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="public-shell">
    <header class="public-bar">
      <RouterLink :to="{ name: 'login' }" class="public-brand" aria-label="power-wiki 首页">
        <BrandLogo :size="24" with-wordmark />
      </RouterLink>
      <span class="public-bar-divider" aria-hidden="true" />
      <span class="public-bar-caption">
        <span class="material-symbols-outlined" aria-hidden="true">link</span>
        公开分享
      </span>
    </header>

    <div class="public-hint" role="status">
      <span class="material-symbols-outlined" aria-hidden="true">visibility</span>
      <span>这是一份<strong>只读</strong>的公开分享 — 任何拿到链接的人都可以访问,无需登录。</span>
      <RouterLink :to="{ name: 'login' }" class="hint-cta">登录 power-wiki</RouterLink>
    </div>

    <main class="public-main">
      <div v-if="loading" class="public-state">
        <span class="material-symbols-outlined spinning">progress_activity</span>
        加载中…
      </div>

      <div v-else-if="error" class="public-state public-state-error">
        <EmptyState
          :title="error.message"
          :icon="
            error.kind === 'expired' || error.kind === 'revoked' || error.kind === 'trashed'
              ? 'link_off'
              : error.kind === 'forbidden'
                ? 'lock'
                : 'broken_link'
          "
          :hint="error.hint ?? '如果您认为这是错误,请联系分享人'"
        />
      </div>

      <article v-else-if="page" class="public-article">
        <header class="meta">
          <UserAvatar
            :label="page.authorName ?? '?'"
            :size="40"
            :color="page.authorColor ?? ''"
            :avatar-kind="page.authorAvatarKind ?? null"
            :avatar-ref="page.authorAvatarRef ?? null"
            :user-id="page.authorId"
          />
          <div class="meta-text">
            <div class="author-row">
              <span class="author-name">{{ page.authorName ?? page.authorId }}</span>
              <span class="meta-dot" aria-hidden="true">·</span>
              <span class="space-name">
                <span class="material-symbols-outlined inline-icon" aria-hidden="true">folder</span>
                {{ page.spaceName }}
              </span>
            </div>
            <div class="updated-row" :title="`最后更新: ${formatFullTime(page.updatedAt)}`">
              最后更新于 {{ formatFullTime(page.updatedAt) }}
            </div>
          </div>
        </header>

        <h1 class="title">{{ page.title }}</h1>

        <div class="prose" v-html="page.contentHTML" />

        <footer class="public-footer">
          <div class="public-footer-inner">
            <BrandLogo :size="16" />
            <span>通过 <strong>power-wiki</strong> 公开分享访问</span>
          </div>
          <RouterLink :to="{ name: 'login' }" class="login-cta">
            <span class="material-symbols-outlined" aria-hidden="true">login</span>
            登录 power-wiki
          </RouterLink>
        </footer>
      </article>
    </main>
  </div>
</template>

<style scoped>
.public-shell {
  min-height: 100vh;
  background: var(--bg-canvas);
  display: flex;
  flex-direction: column;
  color: var(--text-1);
}

.public-bar {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}

.public-brand {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  color: var(--accent);
  transition: color var(--duration-fast) var(--ease-out);
}

.public-brand:hover {
  color: var(--accent-hover);
}

.public-bar-divider {
  width: 1px;
  height: 18px;
  background: var(--border-strong);
}

.public-bar-caption {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}

.public-bar-caption .material-symbols-outlined {
  font-size: 18px;
  color: var(--text-3);
}

.public-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--accent-softer);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
  border-bottom: 1px solid var(--border);
}

.public-hint strong {
  font-weight: 600;
  color: var(--text-1);
}

.public-hint .material-symbols-outlined {
  font-size: 18px;
  color: var(--accent);
  flex-shrink: 0;
}

.hint-cta {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius);
  transition: background var(--duration-fast) var(--ease-out);
}

.hint-cta:hover {
  background: var(--accent-soft);
  text-decoration: none;
}

.public-main {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 40px 24px 64px;
}

.public-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 80px 24px;
  color: var(--text-3);
  font-size: 14px;
  width: 100%;
  max-width: 720px;
}

.public-state-error {
  width: 100%;
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.public-article {
  width: 100%;
  max-width: 880px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  background: var(--bg);
  /* 4px accent 顶条 + 强阴影 ——「品牌化公开文档」的视觉锚点,跟
     内部 ReadView 的 card 区别开:内部页不需要强调「这是对外的」,
     公开页需要让匿名访客一眼看出「这是 power-wiki 渲染的文档」。 */
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 0;
  overflow: hidden;
}

.meta {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 28px 56px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-canvas);
}

.meta-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.author-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--text-1);
}

.author-name {
  font-weight: 600;
  color: var(--text-1);
}

.meta-dot {
  color: var(--text-3);
  font-weight: 500;
}

.space-name {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-2);
  font-size: 13px;
}

.inline-icon {
  font-size: 14px;
  color: var(--text-3);
}

.updated-row {
  font-size: 12px;
  color: var(--text-3);
}

.title {
  margin: 0;
  padding: 32px 56px 0;
  font-size: 36px;
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.15;
  letter-spacing: -0.5px;
}

.prose {
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-1);
  padding: 0 56px;
}

/* 跟 ReadView 的 .prose 同款 typography —— token-based */
.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3),
.prose :deep(h4) {
  margin-top: 1.6em;
  margin-bottom: 0.4em;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-1);
}
.prose :deep(h1) { font-size: 24px; }
.prose :deep(h2) { font-size: 20px; }
.prose :deep(h3) { font-size: 17px; }
.prose :deep(h4) { font-size: 15px; }
.prose :deep(p) { margin: 0.6em 0; }
.prose :deep(ul),
.prose :deep(ol) { padding-left: 1.5em; }
.prose :deep(li) { margin: 0.2em 0; }
.prose :deep(blockquote) {
  margin: 0.8em 0;
  padding: 4px 0 4px 16px;
  border-left: 3px solid var(--border);
  color: var(--text-2);
}
.prose :deep(code) {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--bg-subtle);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
}
.prose :deep(pre) {
  background: var(--bg-code);
  color: var(--text-invert);
  padding: 12px 14px;
  border-radius: var(--radius-md);
  overflow-x: auto;
}
.prose :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
}
.prose :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.prose :deep(a:hover) {
  text-decoration: underline;
}
.prose :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-md);
}
.prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
}
.prose :deep(table th),
.prose :deep(table td) {
  padding: 8px 12px;
  border: 1px solid var(--border);
  text-align: left;
}
.prose :deep(table th) {
  background: var(--bg-subtle);
  font-weight: 600;
}
.prose :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1.5em 0;
}

.public-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0;
  padding: 20px 56px 24px;
  border-top: 1px solid var(--border);
  background: var(--bg-canvas);
  flex-wrap: wrap;
}

.public-footer-inner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3);
}

.public-footer-inner strong {
  color: var(--text-2);
  font-weight: 600;
}

.login-cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: #fff;
  background: var(--accent);
  text-decoration: none;
  padding: 6px 14px;
  border-radius: var(--radius);
  transition: background var(--duration-fast) var(--ease-out);
}

.login-cta:hover {
  background: var(--accent-hover);
  text-decoration: none;
  color: #fff;
}

.login-cta .material-symbols-outlined {
  font-size: 16px;
}
</style>
