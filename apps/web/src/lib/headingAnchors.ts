/**
 * 给容器内的 H2/H3 标题加 `#` 锚点链接。
 *
 * 行为:
 *   - 给每个 h2/h3 注入稳定 id(基于文本 slug,缺失时补)
 *   - 在标题前/后注入一个 `<a class="heading-anchor">#</a>` 链接
 *   - 点击:阻止默认跳转,复制 `location.origin + path + #id` 到剪贴板
 *   - CSS 控制 hover 才显示(已写在 components.css 里 .anchor-link)
 *
 * 幂等:已注入的标题跳过(用 data-anchor-applied 标记)。
 */

const ANCHOR_SELECTOR = 'h1, h2, h3'

function slugify(text: string, fallback: string): string {
  const cleaned = text
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w一-龥\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40)
  return cleaned || fallback
}

function ensureId(el: HTMLElement, usedIds: Set<string>): string {
  let id = el.id
  // 已存在的 id 不强制加 h- 前缀 — 让外部已经合理命名的元素保持原样,
  // 但 ensureId 是兜底路径,新生成的 id 必须带 h- 前缀以便与 #comment-xxx 等
  // 其它 anchor 区分(TocPanel scrollTo / ReadView route.hash watcher 都依赖
  // 这个区分)。
  if (id && !usedIds.has(id)) {
    usedIds.add(id)
    return id
  }
  const base = `h-${slugify(el.textContent || '', `heading-${usedIds.size}`)}`
  let candidate = base
  let n = 1
  while (usedIds.has(candidate)) {
    n++
    candidate = `${base}-${n}`
  }
  el.id = candidate
  usedIds.add(candidate)
  return candidate
}

function injectAnchor(el: HTMLElement, id: string): void {
  if (el.dataset['anchorApplied'] === '1') {
    // 已存在就只更新 href,避免重复
    const existing = el.querySelector(':scope > a.heading-anchor') as HTMLAnchorElement | null
    if (existing) existing.dataset['anchorId'] = id
    return
  }
  const a = document.createElement('a')
  a.className = 'heading-anchor'
  a.href = `#${id}`
  a.setAttribute('aria-label', '复制链接到剪贴板')
  a.title = '复制链接到剪贴板'
  a.textContent = '#'
  a.dataset['anchorId'] = id
  a.addEventListener('click', async (e) => {
    e.preventDefault()
    const url = `${location.origin}${location.pathname}#${id}`
    try {
      await navigator.clipboard.writeText(url)
      a.classList.add('copied')
      a.textContent = '✓'
      window.setTimeout(() => {
        a.classList.remove('copied')
        a.textContent = '#'
      }, 1200)
      // 平滑滚到对应位置
      const target = document.getElementById(id)
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (err) {
      console.warn('[headingAnchors] copy failed', err)
    }
  })
  // 插到标题最前面 — 视觉上靠近标题文字,不会被挤到末尾
  el.insertBefore(a, el.firstChild)
  el.dataset['anchorApplied'] = '1'
}

/**
 * 给容器内的 H1/H2/H3 注入锚点。
 * 直接修改 DOM;调用方负责传入已挂载的根元素。
 */
export function addHeadingAnchors(root: HTMLElement | null | undefined): void {
  if (!root) return
  const usedIds = new Set<string>()
  root.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR).forEach((el) => {
    const id = ensureId(el, usedIds)
    injectAnchor(el, id)
  })
}