/**
 * 渲染端代码块语法高亮 + header(语言标签 + 复制按钮)。
 *
 * 背景:Tiptap 的 CodeBlockLowlight 在编辑器里用 ProseMirror decorations 上色,
 * 但 editor.getHTML() 序列化时不包含 decorations,所以存进 contentHTML 的
 * 代码块是纯文本。
 *
 * 读视图拿到 contentHTML 渲染后,我们用 lowlight 重新解析每个
 * <pre><code class="language-xxx"> 块,把 token 替换为 <span class="hljs-xxx">,
 * 同时在每个 pre 前注入一个 header 栏(语言 + 复制按钮)。
 *
 * 设计目标:
 *   - 幂等(多次调用结果一致)
 *   - 已高亮的 <pre> 跳过(用 data-hljs-applied 标记)
 *   - 已注入 header 的 <pre> 跳过(用 data-header-applied 标记)
 *   - 失败降级:不动原文本,只警告一次
 */
import { common, createLowlight } from 'lowlight'

const lowlight = createLowlight(common)

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function highlightToHTML(code: string, language: string): string {
  try {
    const result = lowlight.highlight(language, code)
    // lowlight v3 返回对象树,自己渲染成 HTML
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const render = (node: any): string => {
      // 文本节点:lowlight v3 用 value 字段存放文字
      if (node.type === 'text') {
        return escapeHTML(String(node.value ?? ''))
      }
      // root / element:递归渲染 children
      const inner = (node.children || []).map(render).join('')
      if (node.type === 'element') {
        const cls = Array.isArray(node.properties?.className)
          ? node.properties.className.join(' ')
          : node.properties?.className || ''
        if (cls) return `<span class="${cls}">${inner}</span>`
        return inner
      }
      // root / 其它
      return inner
    }
    return render(result)
  } catch (err) {
    console.warn('[renderHighlight] highlight failed for language=' + language, err)
    return escapeHTML(code)
  }
}

function detectLanguageFromClass(code: HTMLElement): string | null {
  const cls = code.className || ''
  // 匹配 class="language-typescript" 或 class="hljs language-typescript"
  const m = cls.match(/language-([\w-]+)/i)
  if (m) return m[1]
  // 没有 class,从父 pre 或 code 的 data-language 拿
  const dataLang = code.getAttribute('data-language') || code.parentElement?.getAttribute('data-language')
  if (dataLang) return dataLang
  return null
}

function injectCodeBlockHeader(pre: HTMLElement, lang: string): void {
  if (pre.dataset['headerApplied'] === '1') return
  const parent = pre.parentElement
  if (!parent) return
  // 已被 NodeView 或外部包成 .code-block 的不动
  if (parent.classList.contains('code-block')) {
    pre.dataset['headerApplied'] = '1'
    return
  }

  const wrapper = document.createElement('div')
  wrapper.className = 'code-block'

  const header = document.createElement('div')
  header.className = 'code-block-header'

  const langLabel = document.createElement('span')
  langLabel.className = 'code-block-lang'
  langLabel.textContent = lang || '纯文本'

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'code-block-copy'
  copyBtn.setAttribute('aria-label', '复制代码')
  copyBtn.setAttribute('title', '复制代码')
  const originalLabel = `<span class="material-symbols-outlined copy-icon" style="font-size:14px">content_copy</span><span>复制</span>`
  copyBtn.innerHTML = originalLabel
  copyBtn.addEventListener('click', async () => {
    const code = wrapper.querySelector('code')
    const text = code?.textContent || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      copyBtn.classList.add('copied')
      copyBtn.innerHTML = `<span class="material-symbols-outlined copy-icon" style="font-size:14px">check</span><span>已复制</span>`
      window.setTimeout(() => {
        copyBtn.classList.remove('copied')
        copyBtn.innerHTML = originalLabel
      }, 1500)
    } catch (err) {
      console.warn('[renderHighlight] copy failed', err)
    }
  })

  header.appendChild(langLabel)
  header.appendChild(copyBtn)
  wrapper.appendChild(header)

  // 行号 gutter(跟编辑器 CodeBlockView 保持一致)
  const body = document.createElement('div')
  body.className = 'code-block-body'
  const gutter = document.createElement('div')
  gutter.className = 'code-block-gutter'
  gutter.setAttribute('aria-hidden', 'true')
  const codeEl = pre.querySelector('code')
  const rawText = codeEl?.textContent || ''
  const lineCount = rawText === '' ? 1 : rawText.split('\n').length
  for (let i = 1; i <= lineCount; i++) {
    const num = document.createElement('div')
    num.className = 'cb-line-num'
    num.textContent = String(i)
    gutter.appendChild(num)
  }
  body.appendChild(gutter)
  wrapper.appendChild(body)

  parent.insertBefore(wrapper, pre)
  body.appendChild(pre)
  pre.dataset['headerApplied'] = '1'
}

/**
 * 给容器内的所有 <pre><code> 块上色,并注入 header(语言标签 + 复制按钮)。
 * 直接修改 DOM;调用方负责传入已挂载的根元素。
 */
export function highlightCodeBlocks(root: HTMLElement | null | undefined): void {
  if (!root) return
  const blocks = root.querySelectorAll<HTMLElement>('pre > code')
  blocks.forEach((code) => {
    const pre = code.parentElement as HTMLElement | null
    if (!pre) return
    // 1) 注入 header(即使没语言也要让用户能复制)
    const lang = detectLanguageFromClass(code) || ''
    injectCodeBlockHeader(pre, lang)

    // 2) 高亮代码体
    if (code.dataset['hljsApplied'] === '1') return
    if (!lang) {
      code.dataset['hljsApplied'] = '1'
      return
    }
    const text = code.textContent || ''
    const html = highlightToHTML(text, lang)
    code.innerHTML = html
    code.dataset['hljsApplied'] = '1'
  })
}