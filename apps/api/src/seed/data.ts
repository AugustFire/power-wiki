/**
 * Seed data for `apps/api` — 14 pages that exhaustively demonstrate every
 * editor capability (callouts / toggles / tables / code blocks / pageRef /
 * dateInline / task lists / colored text + highlights).
 *
 * This file is the single source of truth for seed content. The corresponding
 * runner `run.ts` POSTs each page to /api/pages.
 *
 * History: this data lived in apps/web/src/stores/pages.ts during the MVP era
 * when pages were localStorage-only. Once pages moved to Postgres (Stage 2+),
 * the right home for a one-shot import script is the backend — the frontend
 * never auto-seeds and starts from an empty DB.
 *
 * IDs use the same 31-char alphabet as apps/web/src/lib/id.ts so any pre-existing
 * pageRef cards in seed HTML still resolve to a real page.
 */

import { customAlphabet } from 'nanoid'
import type { PageNode } from '@power-wiki/shared'

const newId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10)

export function seedPages(defaultSpaceId: string): PageNode[] {
  const now = Date.now()
  // 先生成所有 id,后面 pageRef 卡片 / 父子关系都能引用
  const ids = {
    home: newId(),
    editorDemo: newId(),
    atlas: newId(),
    atlasPrinciples: newId(),
    atlasTokens: newId(),
    atlasRoadmap: newId(),
    rfc: newId(),
    rfcMigration: newId(),
    rfcPerf: newId(),
    okr: newId(),
    okrW21: newId(),
    okrW22: newId(),
    onboarding: newId(),
  }

  const pages: PageNode[] = []
  const mk = (
    parentId: string | null,
    title: string,
    contentHTML: string,
    daysAgo: number,
    order: number,
    id: string,
  ): PageNode => ({
    id,
    parentId,
    spaceId: defaultSpaceId,
    title,
    contentJSON: {},
    contentHTML,
    order,
    createdAt: now - 86400000 * daysAgo,
    updatedAt: now - 3600000 * daysAgo,
    authorId: 'me',
  })

  // 一些可复用的 HTML 片段 ─────────────────────────────────────
  // 链接:跳到子页面
  const refEditorDemo = `<a class="page-ref-card" data-page-id="${ids.editorDemo}" href="#/p/${ids.editorDemo}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">编辑器功能速查</span></a>`
  const refAtlas = `<a class="page-ref-card" data-page-id="${ids.atlas}" href="#/p/${ids.atlas}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">Atlas 设计系统 v3.0 版本</span></a>`
  const refAtlasTokens = `<a class="page-ref-card" data-page-id="${ids.atlasTokens}" href="#/p/${ids.atlasTokens}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">颜色令牌</span></a>`
  const refAtlasPrinciples = `<a class="page-ref-card" data-page-id="${ids.atlasPrinciples}" href="#/p/${ids.atlasPrinciples}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">设计原则</span></a>`
  const refAtlasRoadmap = `<a class="page-ref-card" data-page-id="${ids.atlasRoadmap}" href="#/p/${ids.atlasRoadmap}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">组件库升级路线图</span></a>`
  const refRfc = `<a class="page-ref-card" data-page-id="${ids.rfc}" href="#/p/${ids.rfc}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">工程 RFC:本地存储 → IndexedDB 迁移</span></a>`
  const refRfcMigration = `<a class="page-ref-card" data-page-id="${ids.rfcMigration}" href="#/p/${ids.rfcMigration}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">数据迁移策略详解</span></a>`
  const refRfcPerf = `<a class="page-ref-card" data-page-id="${ids.rfcPerf}" href="#/p/${ids.rfcPerf}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">性能基准</span></a>`
  const refOkr = `<a class="page-ref-card" data-page-id="${ids.okr}" href="#/p/${ids.okr}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">2026 Q2 OKR 与会议纪要</span></a>`
  const refOkrW21 = `<a class="page-ref-card" data-page-id="${ids.okrW21}" href="#/p/${ids.okrW21}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">W21 周会纪要</span></a>`
  const refOnboarding = `<a class="page-ref-card" data-page-id="${ids.onboarding}" href="#/p/${ids.onboarding}"><span class="material-symbols-outlined page-ref-icon">description</span><span class="page-ref-title">新成员入职指南</span></a>`

  // ──────────────────────────────────────────────────────────
  // 1) 首页 — 我的知识库
  //    展示:文字颜色 / 高亮 / emoji / 引用 / 列表 / 任务 / 表格 / 4 种 callout
  //         链接 / pageRef / dateInline / 居中标题
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(
      null,
      '我的知识库',
      `<p style="text-align: center">👋 欢迎来到 <strong>power-wiki</strong> — 团队中央知识库,本文已更新于 <time class="date-inline" data-date-mode="now" data-date="2026-06-25T09:00:00.000Z" datetime="2026-06-25T09:00:00.000Z">2026/06/25</time>。</p>

<div class="callout info">
  <span class="material-symbols-outlined icon">lightbulb</span>
  <div>
    <div class="callout-title">快速上手</div>
    <p>光标落在任意段落后,顶部会浮现 <strong>工具栏</strong>(B/I 颜色 列表 表格 …);输入 <code>/</code> 唤起 <strong>斜杠菜单</strong> 插入块;点击 <span style="color: var(--accent)">日期芯片</span> 可改日期。完整演示见:</p>
    <p>${refEditorDemo}</p>
  </div>
</div>

<h2>导航速览</h2>
<p>知识库按主题分为以下 5 个根页面,所有内容都保存在浏览器本地 (<code>localStorage</code>),<mark data-color="#FFE380">刷新不丢失</mark>。</p>
<ul>
  <li>${refEditorDemo}</li>
  <li>${refAtlas}</li>
  <li>${refRfc}</li>
  <li>${refOkr}</li>
  <li>${refOnboarding}</li>
</ul>

<h2>本周要点</h2>
<ol>
  <li><strong style="color: #36B37E">Atlas v3.0</strong> 正式发布 🎉,Figma → Code 一致率达到 <span class="badge badge-success">97%</span></li>
  <li>IndexedDB 迁移方案进入 <span class="badge badge-warning">评审</span> 阶段,Demo 时间 <time class="date-inline" data-date-mode="fixed" data-date="2026-06-25T14:00:00.000Z" datetime="2026-06-25T14:00:00.000Z">2026/06/25</time></li>
  <li>Onboarding 漏斗优化上线,<s>首次创建时长 140s</s> 已降到 <strong style="color: #0052CC">110s</strong></li>
</ol>

<h2>本周待办</h2>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>完成 <strong>Atlas 颜色令牌</strong> 与 Figma 同步 <span class="badge badge-success">done</span></div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>种子页面扩充到 14 篇,展示编辑器所有能力</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>写一篇 <em>"我是怎么用 Tiptap 写编辑器的"</em> 博客</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>W23 周会前把 <a href="#/">Q3 规划</a> 草稿发出来</div></li>
</ul>

<blockquote>💡 提示:左侧树状目录支持拖拽节点重排父子关系,点 <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">more_horiz</span> 唤出上下文菜单。</blockquote>

<h2>团队近况</h2>
<table>
  <thead>
    <tr><th>成员</th><th>在做的事</th><th>进度</th><th>状态</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><span class="avatar" style="background:#FF5630">ZS</span> 张三</td>
      <td>Atlas 组件库 v3.0</td>
      <td>v3.0 已发布,v3.1 启动中</td>
      <td><span class="badge badge-success">进行中</span></td>
    </tr>
    <tr>
      <td><span class="avatar" style="background:#0052CC">LS</span> 李四</td>
      <td>IndexedDB 迁移 PoC</td>
      <td>Demo 准备中</td>
      <td><span class="badge badge-warning">评审</span></td>
    </tr>
    <tr>
      <td><span class="avatar" style="background:#36B37E">WW</span> 王五</td>
      <td>Onboarding 漏斗优化</td>
      <td>数据收集 7 天</td>
      <td><span class="badge badge-info">观察</span></td>
    </tr>
    <tr>
      <td><span class="avatar" style="background:#403294">ZL</span> 赵六</td>
      <td>客户案例库</td>
      <td>需求收集中</td>
      <td><span class="badge badge-purple">规划</span></td>
    </tr>
  </tbody>
</table>

<div class="callout success">
  <span class="material-symbols-outlined icon">celebration</span>
  <div>
    <div class="callout-title">里程碑</div>
    <p>Q2 即将结束,本月 <strong>14 篇种子页面</strong> + <strong>8 个</strong> 自定义块类型 + <strong>完整工具栏</strong> 全部到位 🎉。下一阶段重点:<span style="color: #FF5630"><strong>协作 + 搜索</strong></span>。</p>
  </div>
</div>

<div class="callout warning">
  <span class="material-symbols-outlined icon">warning</span>
  <div>
    <div class="callout-title">注意事项</div>
    <p>当前仍是 <strong>MVP</strong>,移动端 / 暗色主题 / 图片功能 暂不支持;存储仅在单浏览器内有效,清缓存会丢数据,重要内容请自行复制到本地存档。</p>
  </div>
</div>

<div class="callout danger">
  <span class="material-symbols-outlined icon">error</span>
  <div>
    <div class="callout-title">不要做</div>
    <p>不要在生产环境写入超 5MB 数据 — localStorage 有硬上限,触发 <code>QuotaExceededError</code> 时所有写入会静默失败。IndexedDB 迁移完成后会解决该问题。</p>
  </div>
</div>

<details class="toggle" open>
  <summary>关于本知识库的元信息</summary>
  <div class="toggle-content">
    <p>这个页面是 <strong>整个知识库的入口</strong>,改它的内容会影响所有新人对知识库的第一印象。技术细节:</p>
    <ul>
      <li>前端:<strong>Vue 3 + Tiptap 2 + Pinia + Vue Router</strong></li>
      <li>样式:<strong>原生 CSS 变量 + tokens.css</strong></li>
      <li>数据:<strong>localStorage</strong> (key 前缀 <code>power-wiki:*</code>)</li>
      <li>图标:<strong>Material Symbols Outlined</strong> (字体 ligature)</li>
      <li>路由:<strong>Hash 模式</strong> (无后端,纯静态部署)</li>
    </ul>
  </div>
</details>

<hr>

<p style="text-align: center; color: var(--text-3); font-size: 13px">— end of overview —</p>`,
      7,
      0,
      ids.home,
    ),
  )

  // ──────────────────────────────────────────────────────────
  // 2) 编辑器功能速查 — 把工具栏 / slash 菜单里的每一项都演一遍
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(
      null,
      '编辑器功能速查',
      `<p>这一页是 <strong>power-wiki 编辑器能力地图</strong> — 把工具栏、slash 菜单、自定义块类型全演一遍。新人 onboarding 时过一遍,基本能掌握全部用法。</p>

<div class="callout info">
  <span class="material-symbols-outlined icon">menu_book</span>
  <div>
    <div class="callout-title">怎么用这一页</div>
    <p>点右上角 <strong>编辑</strong> 进入编辑态,鼠标悬停到任一元素上就能看到对应的工具栏按钮高亮;输入 <code>/</code> 唤起 slash 菜单插入新块。</p>
  </div>
</div>

<h1 style="text-align: center">大标题 (H1)</h1>
<h2>中标题 (H2)</h2>
<h3>小标题 (H3)</h3>

<h2>文字格式</h2>
<p>基础样式:<strong>加粗</strong>、<em>斜体</em>、<s>删除线</s>、<code>行内代码</code>。<br>
混合样式也很自然 — <strong><em>粗斜体</em></strong>、<strong><code>粗 + 代码</code></strong>、<s><em>斜删除</em></s>。</p>

<h3>文字颜色</h3>
<p>工具栏 <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">format_color_text</span> 提供 8 种文字色:</p>
<p>
  <span style="color: #172B4D">默认</span> ·
  <span style="color: #6B778C">灰色</span> ·
  <span style="color: #FF5630">红色</span> ·
  <span style="color: #FF8B00">橙色</span> ·
  <span style="color: #FFAB00">黄色</span> ·
  <span style="color: #36B37E">绿色</span> ·
  <span style="color: #0052CC">蓝色</span> ·
  <span style="color: #403294">紫色</span>
</p>

<h3>背景高亮</h3>
<p>工具栏 <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">format_color_fill</span> 提供 8 种高亮色,荧光笔效果:</p>
<p>
  <mark data-color="#DFE1E6">灰</mark> ·
  <mark data-color="#FFBDAD">红</mark> ·
  <mark data-color="#FFC400">橙</mark> ·
  <mark data-color="#FFE380">黄</mark> ·
  <mark data-color="#ABF5D1">绿</mark> ·
  <mark data-color="#79E2F2">青</mark> ·
  <mark data-color="#B3ACF5">紫</mark> ·
  <mark data-color="#FFFFFF" style="background-color: #ffffff; color: #172B4D">白</mark>
</p>

<h3>链接</h3>
<p>选中文本后点工具栏 🔗 按钮加链接;直接粘贴 URL 也会自动识别 — 例如 <a href="https://github.com">https://github.com</a>。<br>
内部链接跳到知识库内的其他页面 — 例如 <a href="#/">首页</a>、<a href="#/">W21 周会纪要</a>。</p>

<h3>表情</h3>
<p>工具栏 😀 按钮打开表情面板,常用分类:表情 / 手势 / 人物 / 动物食物 / 旅行 / 活动 / 物件 / 符号。<br>
示例:😀 😁 😂 🤣 😊 😎 🥰 🤔 😅 🙄 — 选中后会自动插入到光标处。</p>

<h2>日期</h2>
<p>工具栏 <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">schedule</span> 按钮(或 slash 菜单 <code>/date</code>) 插入日期节点。两种模式:</p>
<ul>
  <li><strong>动态 (now)</strong> — 每次打开自动更新到当天,适合"今天 / 明天"等需要动态语义的场景。<br>示例:<time class="date-inline" data-date-mode="now" data-date="2026-06-25T09:00:00.000Z" datetime="2026-06-25T09:00:00.000Z">2026/06/25</time></li>
  <li><strong>固定 (fixed)</strong> — 钉死一个具体日期,后续不再变化。适合"截止日 / 会议日"等。<br>示例:<time class="date-inline" data-date-mode="fixed" data-date="2026-07-01T00:00:00.000Z" datetime="2026-07-01T00:00:00.000Z">2026/07/01</time>、<time class="date-inline" data-date-mode="fixed" data-date="2026-12-31T00:00:00.000Z" datetime="2026-12-31T00:00:00.000Z">2026/12/31</time></li>
</ul>
<p><strong>点击日期节点</strong> 即可弹回 picker 修改日期 / 切换模式。</p>

<h2>列表</h2>
<h3>无序列表</h3>
<ul>
  <li>支持 6 级缩进(每按一次 Tab 进一层)</li>
  <li>支持混合内容(列表项里再放段落、引用、代码块)</li>
  <li>Enter 连续两次跳出列表</li>
</ul>
<ol>
  <li>第一项</li>
  <li>第二项
    <ol>
      <li>嵌套子项 A</li>
      <li>嵌套子项 B
        <ol>
          <li>再嵌套一级 (3 层)</li>
          <li>可以一直缩进</li>
        </ol>
      </li>
    </ol>
  </li>
  <li>第三项</li>
</ol>

<h3>任务列表</h3>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>已完成</div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>已完成</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>待办事项 A</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>待办事项 B — 支持 <strong>富文本</strong>、<code>行内代码</code>、<a href="#/">链接</a></div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>嵌套子任务:
    <ul data-type="taskList">
      <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>子项 1 (已完)</div></li>
      <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>子项 2 (待办)</div></li>
    </ul>
  </div></li>
</ul>

<h2>引用 / 分隔线 / 缩进 / 对齐</h2>
<blockquote>这是引用块,左侧蓝条,内文支持富文本 — <strong>加粗</strong>、<em>斜体</em>、<a href="#/">链接</a>。可以套列表或代码块,常见于"作者备注 / 引用他人观点"。</blockquote>

<blockquote>按 <code>Shift+Tab</code> 减少缩进,<code>Tab</code> 增加缩进。引用、列表项都能缩进 — 套一层引用就视觉嵌套。</blockquote>

<p style="text-align: center">↑ 这段是 <strong>居中对齐</strong>,工具栏对齐按钮可切换左 / 中 / 右三种。</p>
<p style="text-align: right">↑ 这段是 <strong>右对齐</strong>。</p>

<hr>

<h2>提示框 (callout) — 4 种</h2>
<div class="callout info">
  <span class="material-symbols-outlined icon">lightbulb</span>
  <div>
    <div class="callout-title">信息型 (info)</div>
    <p>用于"提示 / 说明",蓝色调,Material Symbol 是 💡 (lightbulb)。</p>
  </div>
</div>
<div class="callout success">
  <span class="material-symbols-outlined icon">check_circle</span>
  <div>
    <div class="callout-title">成功型 (success)</div>
    <p>用于"已完成 / 通过",绿色调,icon 是 ✅ (check_circle)。</p>
  </div>
</div>
<div class="callout warning">
  <span class="material-symbols-outlined icon">warning</span>
  <div>
    <div class="callout-title">警告型 (warning)</div>
    <p>用于"注意 / 待办",橙色调,icon 是 ⚠️ (warning)。</p>
  </div>
</div>
<div class="callout danger">
  <span class="material-symbols-outlined icon">error</span>
  <div>
    <div class="callout-title">危险型 (danger)</div>
    <p>用于"错误 / 删除",红色调,icon 是 ⛔ (error)。</p>
  </div>
</div>

<h2>折叠块 (toggle)</h2>
<p>Notion / 飞书风格的折叠容器,点 <strong>summary 行</strong> 切换展开/收起。</p>
<details class="toggle" open>
  <summary>这是默认展开的折叠块</summary>
  <div class="toggle-content">
    <p>里面可以放任意块 — 段落、列表、引用、代码块、表格,甚至嵌套另一个折叠块。</p>
    <ul>
      <li>列表项 A</li>
      <li>列表项 B</li>
    </ul>
    <pre><code class="language-typescript">// 折叠块里也能写代码
function hello(name: string) {
  return \`Hello, \${name}!\`
}</code></pre>
  </div>
</details>
<details class="toggle">
  <summary>这是默认折叠的 — 点 summary 展开</summary>
  <div class="toggle-content">
    <p>适合放"补充说明 / 不常看的内容 / FAQ",让主文档更紧凑。</p>
  </div>
</details>
<details class="toggle">
  <summary>FAQ:能不能在折叠块里再套折叠块?</summary>
  <div class="toggle-content">
    <p>能。schema 里 <code>content: 'block+'</code>,任何块类型都允许。</p>
    <details class="toggle">
      <summary>二级折叠</summary>
      <div class="toggle-content">
        <p>三级内容。理论上无限嵌套,但超过 3 层视觉会乱,实际 1-2 层够用。</p>
      </div>
    </details>
  </div>
</details>

<h2>代码块 — 多语言高亮</h2>
<p>工具栏 <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">data_object</span> 插入代码块,顶部可切换语言(基于 <a href="https://highlightjs.org">highlight.js</a>)。</p>

<h3>Bash</h3>
<pre><code class="language-bash"># 启动开发服务器
npm run dev
# 打开浏览器
open http://127.0.0.1:5173

# 类型检查
npx vue-tsc --noEmit -p tsconfig.app.json

# 生产构建
npm run build</code></pre>

<h3>TypeScript</h3>
<pre><code class="language-typescript">import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useCounter = defineStore('counter', () => {
  const count = ref(0)
  const double = computed(() => count * 2)
  function increment() {
    count++
  }
  return { count, double, increment }
})</code></pre>

<h3>JSON</h3>
<pre><code class="language-json">{
  "name": "power-wiki",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b &amp;&amp; vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.4.0",
    "tiptap": "^2.0.0",
    "pinia": "^2.1.0"
  }
}</code></pre>

<h2>表格</h2>
<p>工具栏 <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">table_chart</span> 插入 3×3 表格(首行表头)。表头右键 / hover 工具栏可插入行/列、合并/拆分单元格、单元格着色。</p>
<table>
  <thead>
    <tr>
      <th>功能</th>
      <th>工具栏位置</th>
      <th>快捷键</th>
      <th>说明</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>加粗</td>
      <td>B 图标</td>
      <td><code>Ctrl+B</code></td>
      <td>切换加粗</td>
    </tr>
    <tr>
      <td>斜体</td>
      <td>I 图标</td>
      <td><code>Ctrl+I</code></td>
      <td>切换斜体</td>
    </tr>
    <tr>
      <td>链接</td>
      <td>🔗 图标</td>
      <td><code>Ctrl+K</code></td>
      <td>选中文本后插入</td>
    </tr>
    <tr style="background-color: #FFF0B3">
      <td>高亮</td>
      <td>🎨 填充图标</td>
      <td>—</td>
      <td>8 种预设色</td>
    </tr>
    <tr>
      <td>代码块</td>
      <td>&lt;/&gt; 图标</td>
      <td><code>Ctrl+Alt+C</code></td>
      <td>语言可切换</td>
    </tr>
  </tbody>
</table>

<h3>表格里混用徽章 / 色板 / 头像</h3>
<table>
  <thead><tr><th>颜色</th><th>色值</th><th>用途</th><th>状态</th></tr></thead>
  <tbody>
    <tr>
      <td><span class="swatch" style="background:#0052CC"></span> 主蓝</td>
      <td>#0052CC</td>
      <td>主操作、链接</td>
      <td><span class="badge badge-info">活跃</span></td>
    </tr>
    <tr>
      <td><span class="swatch" style="background:#36B37E"></span> 成功绿</td>
      <td>#0052CC</td>
      <td>主操作、链接</td>
      <td><span class="badge badge-success">通过</span></td>
    </tr>
    <tr>
      <td><span class="swatch" style="background:#FFAB00"></span> 警告黄</td>
      <td>#FFAB00</td>
      <td>警告、待办</td>
      <td><span class="badge badge-warning">待审</span></td>
    </tr>
    <tr>
      <td><span class="swatch" style="background:#FF5630"></span> 危险红</td>
      <td>#FF5630</td>
      <td>错误、删除操作</td>
      <td><span class="badge badge-danger">阻塞</span></td>
    </tr>
    <tr>
      <td><span class="swatch" style="background:#403294"></span> 紫色</td>
      <td>#403294</td>
      <td>负责人标签</td>
      <td><span class="badge badge-purple">规划</span></td>
    </tr>
  </tbody>
</table>

<h3>表格里嵌人物头像</h3>
<table>
  <thead><tr><th>成员</th><th>负责模块</th><th>排期</th></tr></thead>
  <tbody>
    <tr><td><span class="avatar" style="background:#FF5630">ZS</span> 张三</td><td>编辑器 / 组件</td><td>Q2 ✅</td></tr>
    <tr><td><span class="avatar" style="background:#0052CC">LS</span> 李四</td><td>数据层 / 性能</td><td>Q3</td></tr>
    <tr><td><span class="avatar" style="background:#36B37E">WW</span> 王五</td><td>设计 / 用户体验</td><td>Q2</td></tr>
    <tr><td><span class="avatar" style="background:#403294">ZL</span> 赵六</td><td>客户案例</td><td>Q3</td></tr>
  </tbody>
</table>

<h2>页面引用 (PageRef)</h2>
<p>在编辑器内点 slash 菜单 <code>/页面引用</code> 选中目标页,会插入一个原子块,点击跳转到对应页:</p>
<p>${refEditorDemo}</p>
<p>${refAtlas}</p>
<p>${refOnboarding}</p>

<h2>工具栏按钮 ↔ 键盘快捷键 一览</h2>
<table>
  <thead>
    <tr><th>操作</th><th>快捷键</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td>加粗</td><td><code>Ctrl+B</code></td><td>StarterKit 默认</td></tr>
    <tr><td>斜体</td><td><code>Ctrl+I</code></td><td>StarterKit 默认</td></tr>
    <tr><td>下划线</td><td><code>Ctrl+U</code></td><td>StarterKit 默认</td></tr>
    <tr><td>行内代码</td><td><code>Ctrl+E</code></td><td>StarterKit 默认</td></tr>
    <tr><td>撤销 / 重做</td><td><code>Ctrl+Z / Ctrl+Y</code></td><td>StarterKit 默认</td></tr>
    <tr><td>段落 ↔ 标题 1/2/3</td><td><code>Alt+1/2/3</code> 或 <code>Ctrl+Alt+1/2/3</code></td><td>StarterKit 默认</td></tr>
    <tr><td>有序 / 无序列表</td><td><code>Ctrl+Shift+7/8</code></td><td>StarterKit 默认</td></tr>
    <tr><td>代码块</td><td><code>Ctrl+Alt+C</code></td><td>StarterKit 默认</td></tr>
    <tr><td>缩进 / 反缩进</td><td><code>Tab / Shift+Tab</code></td><td>智能 indent</td></tr>
    <tr><td>保存防拦截</td><td><code>Ctrl+S</code></td><td>防浏览器"保存网页"对话框</td></tr>
  </tbody>
</table>

<div class="callout success">
  <span class="material-symbols-outlined icon">check_circle</span>
  <div>
    <div class="callout-title">到这里就掌握全部基础能力了 🎉</div>
    <p>下一阶段练习:在空白页面 <code>/</code> 唤起菜单,逐个插入每种块;试试 <code>## </code> + 空格快速转 H2、<code>**文字**</code> 转粗体、<code>- </code> 转列表 — Markdown 输入规则自动生效。</p>
  </div>
</div>`,
      5,
      1,
      ids.editorDemo,
    ),
  )

  // ──────────────────────────────────────────────────────────
  // 3) Atlas 设计系统 v3.0
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(
      null,
      'Atlas 设计系统 v3.0 版本',
      `<div class="callout success">
  <span class="material-symbols-outlined icon">auto_awesome</span>
  <div>
    <div class="callout-title">v3.0 已正式发布 🎉</div>
    <p>本次升级重写了组件 API、引入 <strong>设计令牌</strong>、并对齐了 <em>WCAG 2.1 AA</em> 色彩对比度标准。详细迁移指南见子页面。发布日期:<time class="date-inline" data-date-mode="fixed" data-date="2026-06-12T00:00:00.000Z" datetime="2026-06-12T00:00:00.000Z">2026/06/12</time>。</p>
  </div>
</div>

<h2>本次升级概览</h2>
<p>Atlas v3.0 是设计系统近 <s>12 个月</s> <strong>18 个月</strong> 以来最大的一次迭代。新版本聚焦于三个核心方向:</p>
<ul>
  <li><strong style="color: #0052CC">设计令牌</strong> — 颜色、字号、间距全部走 <code>CSS 变量</code>,主题切换无需重新编译</li>
  <li><strong style="color: #36B37E">无障碍</strong> — 所有交互组件通过 WCAG 2.1 AA 认证,键盘可达性 100% 覆盖</li>
  <li><strong style="color: #FF8B00">开发者体验</strong> — 包体积减少 38%、TS 类型补全完善、Figma ↔ Code 双向同步</li>
</ul>

<details class="toggle" open>
  <summary>📖 子页面导航</summary>
  <div class="toggle-content">
    <p>${refAtlasPrinciples}</p>
    <p>${refAtlasTokens}</p>
    <p>${refAtlasRoadmap}</p>
  </div>
</details>

<h2>关键指标</h2>
<table>
  <thead><tr><th>维度</th><th>v2.4</th><th>v3.0</th><th>变化</th></tr></thead>
  <tbody>
    <tr><td>组件数量</td><td>42</td><td>58</td><td><span class="badge badge-success">+38%</span></td></tr>
    <tr><td>JS 包体积 (gzip)</td><td>142 KB</td><td>88 KB</td><td><span class="badge badge-success">-38%</span></td></tr>
    <tr><td>WCAG AA 合规率</td><td>76%</td><td>100%</td><td><span class="badge badge-success">+24%</span></td></tr>
    <tr><td>Figma → Code 一致率</td><td>82%</td><td>97%</td><td><span class="badge badge-success">+15%</span></td></tr>
    <tr><td>首次绘制 (P75)</td><td>1.8s</td><td>1.1s</td><td><span class="badge badge-success">-39%</span></td></tr>
  </tbody>
</table>

<h2>升级路线图</h2>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>v3.0-alpha: 内部灰度 <time class="date-inline" data-date-mode="fixed" data-date="2026-04-01T00:00:00.000Z" datetime="2026-04-01T00:00:00.000Z">2026/04/01</time></div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>v3.0-rc: 公开预览 <time class="date-inline" data-date-mode="fixed" data-date="2026-05-15T00:00:00.000Z" datetime="2026-05-15T00:00:00.000Z">2026/05/15</time></div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>v3.0 正式发布 <time class="date-inline" data-date-mode="fixed" data-date="2026-06-12T00:00:00.000Z" datetime="2026-06-12T00:00:00.000Z">2026/06/12</time></div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>v2.x 进入维护期,仅修复安全问题 <time class="date-inline" data-date-mode="fixed" data-date="2026-09-01T00:00:00.000Z" datetime="2026-09-01T00:00:00.000Z">2026/09/01</time></div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>v2.x EOL: 停止服务 <time class="date-inline" data-date-mode="fixed" data-date="2027-01-01T00:00:00.000Z" datetime="2027-01-01T00:00:00.000Z">2027/01/01</time></div></li>
</ul>

<h2>一段示例代码 (TSX)</h2>
<pre><code class="language-typesx">import { Button, Stack } from '@atlas/components'

export function HeroSection() {
  return (
    &lt;Stack direction="column" gap="lg"&gt;
      &lt;Heading level={1}&gt;Atlas v3.0 已发布&lt;/Heading&gt;
      &lt;Text tone="secondary"&gt;
        更快、更小、更易用
      &lt;/Text&gt;
      &lt;Button variant="primary" size="lg"&gt;
        立即升级
      &lt;/Button&gt;
    &lt;/Stack&gt;
  )
}</code></pre>

<h2>反馈与贡献</h2>
<p>发现 bug 或有改进建议?在 <strong>#atlas-feedback</strong> Slack 频道留言,或在 GitHub 提 issue。每周三下午是设计系统的 <em>Office Hour</em>,设计师 + 前端工程师在线答疑。</p>

<div class="callout warning">
  <span class="material-symbols-outlined icon">warning</span>
  <div>
    <div class="callout-title">迁移期注意</div>
    <p>v2 → v3 的破坏性变更集中在 <code>Modal</code>、<code>Tooltip</code>、<code>Drawer</code> 三个组件的 API。请优先使用 codemod 工具自动迁移:</p>
    <pre><code class="language-bash">npx atlas-codemod v2-to-v3 ./src</code></pre>
  </div>
</div>`,
      5,
      2,
      ids.atlas,
    ),
  )

  // 3.1 设计原则
  pages.push(
    mk(
      ids.atlas,
      '设计原则',
      `<p>Atlas 的设计原则回答一个核心问题:<em>在视觉与交互的取舍之间,我们应该怎么选?</em>以下七条原则按优先级排序,冲突时优先服从前者。</p>
<ol>
  <li><strong>清晰优先于美观</strong> — 用户首要任务是完成任务,不是欣赏设计</li>
  <li><strong>速度优先于花哨</strong> — 加载快、响应快、动画克制</li>
  <li><strong>一致优先于个性</strong> — 跨产品体验可预测,降低学习成本</li>
  <li><strong>反馈优先于静默</strong> — 每个用户操作都有视觉或触觉响应</li>
  <li><strong>渐进优先于一步到位</strong> — 高级用户可提速,新手不被淹没</li>
  <li><strong>诚实优先于聪明</strong> — 不假装 AI 能做到的事,失败时坦诚告知</li>
  <li><strong>可逆优先于破坏</strong> — 危险操作必须可撤销</li>
</ol>

<h2>反例 (我们不做什么)</h2>
<div class="callout danger">
  <span class="material-symbols-outlined icon">block</span>
  <div>
    <div class="callout-title">避免的视觉模式</div>
    <ul style="margin:0;padding-left:20px;list-style:disc">
      <li>渐变色作为主操作按钮背景 — 损害识别度</li>
      <li>动效时长 &gt; 400ms — 拖累感知性能</li>
      <li>灰色禁用态与正常态仅靠颜色区分 — 不符合无障碍</li>
      <li>弹窗嵌套弹窗 — 任务焦点丢失</li>
    </ul>
  </div>
</div>

<h2>参考资源</h2>
<ul>
  <li><a href="https://www.nngroup.com/articles/ten-usability-heuristics/">Nielsen 十大启发式</a></li>
  <li><a href="https://m3.material.io/foundations">Material Design 3 设计原则</a></li>
  <li><a href="https://developer.apple.com/design/human-interface-guidelines/principles">Apple HIG: Design Principles</a></li>
</ul>

<p>更多细节见 <mark data-color="#FFE380">Atlas v3.0 版本说明</mark> 或 <a href="#/">设计原则历史 changelog</a>。</p>`,
      4,
      0,
      ids.atlasPrinciples,
    ),
  )

  // 3.2 颜色令牌
  pages.push(
    mk(
      ids.atlas,
      '颜色令牌',
      `<p>所有颜色定义在 <code>src/styles/tokens.css</code> 的 <code>:root</code> 中。组件样式中<strong>只能引用变量</strong>,不允许写死十六进制色值。</p>
<div class="callout info">
  <span class="material-symbols-outlined icon">palette</span>
  <div>
    <div class="callout-title">为什么用变量?</div>
    <p>令牌化的好处是 <strong>单一事实来源</strong>:换色改一处即可,所有组件联动。未来支持深色模式或客户白标时,只需新增一套变量覆盖。</p>
  </div>
</div>

<h2>品牌色</h2>
<table>
  <thead><tr><th>令牌</th><th>色值</th><th>用途</th></tr></thead>
  <tbody>
    <tr><td><code>--accent</code></td><td><span class="swatch" style="background:#0052CC"></span> #0052CC</td><td>主操作、链接、当前选中</td></tr>
    <tr><td><code>--accent-hover</code></td><td><span class="swatch" style="background:#0747A6"></span> #0747A6</td><td>主操作 hover</td></tr>
    <tr><td><code>--accent-soft</code></td><td><span class="swatch" style="background:#DEEBFF"></span> #DEEBFF</td><td>激活态背景、tag 背景</td></tr>
    <tr><td><code>--accent-softer</code></td><td><span class="swatch" style="background:#F4F8FF"></span> #F4F8FF</td><td>引用块、callout 背景</td></tr>
  </tbody>
</table>

<h2>语义色</h2>
<table>
  <thead><tr><th>令牌</th><th>色值</th><th>使用场景</th></tr></thead>
  <tbody>
    <tr><td><code>--success</code></td><td><span class="swatch" style="background:#36B37E"></span> #36B37E</td><td>成功提示、已上线状态</td></tr>
    <tr><td><code>--warning</code></td><td><span class="swatch" style="background:#FFAB00"></span> #FFAB00</td><td>警告、待审核</td></tr>
    <tr><td><code>--danger</code></td><td><span class="swatch" style="background:#FF5630"></span> #FF5630</td><td>错误、删除操作</td></tr>
    <tr><td><code>--purple</code></td><td><span class="swatch" style="background:#403294"></span> #403294</td><td>负责人标签、装饰</td></tr>
  </tbody>
</table>

<h2>中性色阶</h2>
<table>
  <thead><tr><th>令牌</th><th>色值</th><th>用途</th></tr></thead>
  <tbody>
    <tr><td><code>--text-1</code></td><td><span class="swatch" style="background:#172B4D;border:1px solid #DFE1E6"></span> #172B4D</td><td>正文</td></tr>
    <tr><td><code>--text-2</code></td><td><span class="swatch" style="background:#44546F"></span> #44546F</td><td>次要文本</td></tr>
    <tr><td><code>--text-3</code></td><td><span class="swatch" style="background:#6B778C"></span> #6B778C</td><td>辅助、placeholder</td></tr>
    <tr><td><code>--border</code></td><td><span class="swatch" style="background:#DFE1E6"></span> #DFE1E6</td><td>常规边框</td></tr>
    <tr><td><code>--bg-canvas</code></td><td><span class="swatch" style="background:#F4F5F7;border:1px solid #DFE1E6"></span> #F4F5F7</td><td>页面画布背景</td></tr>
  </tbody>
</table>

<details class="toggle">
  <summary>🛠️ 怎么在代码里用?</summary>
  <div class="toggle-content">
    <pre><code class="language-css">/* ✅ 推荐 */
.my-card {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-1);
}

/* ❌ 不推荐 */
.my-card {
  background: #ffffff;
  border: 1px solid #DFE1E6;
  color: #172B4D;
}</code></pre>
    <p>通过 <code>var(--xxx)</code> 引用,IDE 会自动补全可用令牌。</p>
  </div>
</details>`,
      4,
      1,
      ids.atlasTokens,
    ),
  )

  // 3.3 组件库升级路线图
  pages.push(
    mk(
      ids.atlas,
      '组件库升级路线图',
      `<h2>Q3 计划</h2>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><code>Modal</code> 迁移到 headless 库,体积再降 12KB <span class="badge badge-success">已完成</span></div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><code>DataTable</code> 引入虚拟滚动,支持 10w+ 行 <span class="badge badge-success">已完成</span></div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><code>DatePicker</code> 重写为单文件 SFC,支持农历 <span class="badge badge-warning">进行中</span></div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><code>RichEditor</code> 接入协作光标(CRDT) <span class="badge badge-info">规划</span></div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><code>Toast</code> 支持动作按钮(撤销等) <span class="badge badge-info">规划</span></div></li>
</ul>

<h2>Q4 计划</h2>
<ul>
  <li>全新的 <code>Chart</code> 套件 (12 种基础图表)</li>
  <li>桌面端组件 (注意:<s>移动端</s>,仅响应用户场景,不做完整移动适配)</li>
  <li><code>Form Builder</code> 低代码表单搭建</li>
  <li><code>Command Palette</code> 全局命令面板</li>
</ul>

<div class="callout success">
  <span class="material-symbols-outlined icon">celebration</span>
  <div>
    <div class="callout-title">里程碑</div>
    <p>2026 年底前,Atlas 组件库目标: <strong>75 个组件</strong>、<strong>95% 单元测试覆盖</strong>、<strong>0 个已知 P0/P1 bug</strong>。当前进度 <span class="badge badge-info">58/75</span>。</p>
  </div>
</div>

<div class="callout info">
  <span class="material-symbols-outlined icon">schedule</span>
  <div>
    <div class="callout-title">下次评审</div>
    <p>里程碑 review 安排在 <time class="date-inline" data-date-mode="fixed" data-date="2026-09-15T00:00:00.000Z" datetime="2026-09-15T00:00:00.000Z">2026/09/15</time>,所有 Owner 必须到场。</p>
  </div>
</div>`,
      2,
      2,
      ids.atlasRoadmap,
    ),
  )

  // ──────────────────────────────────────────────────────────
  // 4) 工程 RFC: 本地存储 → IndexedDB 迁移
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(
      null,
      '工程 RFC:本地存储 → IndexedDB 迁移',
      `<div class="callout warning">
  <span class="material-symbols-outlined icon">pending_actions</span>
  <div>
    <div class="callout-title">状态:评审中</div>
    <p>本文档为 <strong>RFC(请求评议)</strong>,征求工程团队的反馈意见。请在评论区留言或直接在文档上批注。提交截止 <time class="date-inline" data-date-mode="fixed" data-date="2026-07-01T00:00:00.000Z" datetime="2026-07-01T00:00:00.000Z">2026/07/01</time>。</p>
  </div>
</div>

<details class="toggle" open>
  <summary>📖 子页面</summary>
  <div class="toggle-content">
    <p>${refRfcMigration}</p>
    <p>${refRfcPerf}</p>
  </div>
</details>

<h2>背景</h2>
<p>power-wiki MVP 目前使用 <code>localStorage</code> 持久化所有页面数据。随着用户开始积累内容,以下问题逐渐显现:</p>
<ul>
  <li><strong style="color: #FF5630">5MB 硬上限</strong> — Chrome / Firefox 均限制 localStorage 在 5MB 左右,用户写到 ~80 页富文本时触发 <code>QuotaExceededError</code></li>
  <li><strong>同步阻塞</strong> — localStorage 的 API 是同步的,大数据写入会卡住主线程</li>
  <li><strong>无索引</strong> — 全文搜索需要遍历所有 JSON,性能随数据量线性下降</li>
  <li><strong>无法存二进制</strong> — 未来要支持图片附件、头像,需要二进制存储</li>
</ul>

<h2>目标</h2>
<p>在不破坏现有用户体验的前提下,把数据层迁移到 <strong>IndexedDB</strong>,并为后续特性(全文搜索、附件、多端同步)打下基础。</p>

<h2>方案对比</h2>
<table>
  <thead><tr><th>方案</th><th>容量</th><th>性能</th><th>复杂度</th><th>推荐度</th></tr></thead>
  <tbody>
    <tr>
      <td>继续用 localStorage</td><td>5MB ❌</td><td>同步阻塞 ⚠️</td><td>无 ✅</td><td><span class="badge badge-danger">不推荐</span></td>
    </tr>
    <tr>
      <td>迁移到 IndexedDB 原生 API</td><td>~60% 磁盘 ✅</td><td>异步非阻塞 ✅</td><td>API 繁琐 ⚠️</td><td><span class="badge badge-warning">可用</span></td>
    </tr>
    <tr>
      <td>IndexedDB + Dexie 封装</td><td>同上 ✅</td><td>同上 ✅</td><td>中等 ✅</td><td><span class="badge badge-success">推荐</span></td>
    </tr>
    <tr>
      <td>OPFS (Origin Private File System)</td><td>几乎无限 ✅</td><td>需 worker ⚠️</td><td>高 ❌</td><td><span class="badge badge-warning">观望</span></td>
    </tr>
  </tbody>
</table>

<h2>推荐方案:Dexie.js 封装</h2>
<p>Dexie 是 IndexedDB 的轻量封装库,核心优势:</p>
<ul>
  <li><strong>Promise-based</strong> API,告别回调地狱</li>
  <li>支持索引、复合查询,搜索性能提升 10x+</li>
  <li>TypeScript 一等支持,IDE 补全完善</li>
  <li>体积仅 24KB (gzip)</li>
</ul>

<h3>数据库 schema</h3>
<pre><code class="language-typescript">// db.ts
import Dexie, { Table } from 'dexie'

interface Page {
  id: string
  parentId: string | null
  title: string
  contentJSON: any
  contentHTML: string
  order: number
  createdAt: number
  updatedAt: number
  authorId: string
}

class WikiDB extends Dexie {
  pages!: Table&lt;Page, string&gt;

  constructor() {
    super('power-wiki')
    this.version(1).stores({
      pages: 'id, parentId, updatedAt, *tags',  // 主键 + 4 个索引
    })
  }
}

export const db = new WikiDB()</code></pre>

<h3>迁移策略</h3>
<ol>
  <li><strong>读取旧数据</strong> — 启动时检测 <code>localStorage[power-wiki:pages]</code></li>
  <li><strong>写入 IndexedDB</strong> — 一次性导入到 <code>db.pages.bulkAdd()</code></li>
  <li><strong>写入迁移标志</strong> — <code>localStorage[power-wiki:migrated] = 'v1'</code></li>
  <li><strong>保留旧 key 30 天</strong> — 回滚需要,过期后清理</li>
</ol>
<pre><code class="language-typescript">async function migrateFromLocalStorage() {
  if (localStorage.getItem('power-wiki:migrated') === 'v1') return

  const raw = localStorage.getItem('power-wiki:pages')
  if (!raw) return
  const pages = JSON.parse(raw) as Page[]

  await db.pages.bulkAdd(pages)
  localStorage.setItem('power-wiki:migrated', 'v1')
  console.log('[migration] ' + pages.length + ' pages moved to IndexedDB')
}</code></pre>

<h2>风险评估</h2>
<div class="callout danger">
  <span class="material-symbols-outlined icon">error</span>
  <div>
    <div class="callout-title">已知风险</div>
    <ul style="margin:0;padding-left:20px;list-style:disc">
      <li>隐私模式浏览器下,IndexedDB 可能在窗口关闭时被清理 → 增加导出/导入备份入口</li>
      <li>跨标签页同步需要监听 <code>storage</code> 事件 → 实现 BroadcastChannel</li>
      <li>测试时需要 <code>fake-indexeddb</code>,否则单测无法跑通</li>
    </ul>
  </div>
</div>

<h2>时间线</h2>
<ul>
  <li><strong>2026/07 上旬</strong> — PoC 完成,Demo 给前端组 <span class="badge badge-info">P0</span></li>
  <li><strong>2026/07 下旬</strong> — 评审通过,合入主干</li>
  <li><strong>2026/08</strong> — 灰度发布 (10% 用户)</li>
  <li><strong>2026/09</strong> — 全量上线,清理迁移代码</li>
</ul>

<h2>替代方案:暂不迁移</h2>
<p>如果本季度没有大文件/搜索需求,继续用 localStorage 也可以接受。但每次写超过 100KB 的页面时,UI 会卡顿约 200ms,长期看不健康。</p>

<blockquote>📮 反馈渠道:在 <a href="#/">#engineering</a> Slack 频道发消息,或直接在本页面评论。</blockquote>`,
      3,
      3,
      ids.rfc,
    ),
  )

  // 4.1 数据迁移策略详解
  pages.push(
    mk(
      ids.rfc,
      '数据迁移策略详解',
      `<p>本文档是 <strong>数据迁移策略</strong> 的展开说明,回答"具体怎么从 localStorage 平滑过渡到 IndexedDB"。</p>

<div class="callout info">
  <span class="material-symbols-outlined icon">lightbulb</span>
  <div>
    <div class="callout-title">阅读建议</div>
    <p>先读父页面 <em>RFC:本地存储 → IndexedDB 迁移</em> 了解整体方案,再读本文档看实现细节。</p>
  </div>
</div>

<h2>迁移触发条件</h2>
<p>应用启动时检测:</p>
<ol>
  <li><code>localStorage['power-wiki:migrated']</code> 是否存在</li>
  <li>是否存在 <code>localStorage['power-wiki:pages']</code> 且未被迁移</li>
  <li>如果两者都满足 → 执行迁移</li>
</ol>

<h2>迁移原子性</h2>
<p>为了避免半迁移状态(部分页面在新库、部分在旧库),我们采用 <strong>双写 + 读新库</strong> 策略:</p>
<ul>
  <li>迁移期间,所有写操作<mark data-color="#FFE380">同时写入 localStorage 和 IndexedDB</mark></li>
  <li>读操作只读 IndexedDB</li>
  <li>迁移完成标志位写入后,关闭双写</li>
</ul>

<h2>失败回滚</h2>
<p>如果迁移过程中 IndexedDB 写入失败(配额、浏览器崩溃):</p>
<ol>
  <li><strong>立即停止</strong> 迁移</li>
  <li><strong>删除</strong> 已写入的部分数据</li>
  <li>回到 <strong>localStorage-only</strong> 模式</li>
  <li>提示用户:<em>"迁移失败,数据已保留在原位置"</em></li>
</ol>

<div class="callout warning">
  <span class="material-symbols-outlined icon">warning</span>
  <div>
    <div class="callout-title">测试覆盖</div>
    <p>必须在以下场景全部通过才能上线:</p>
    <ul style="margin:0;padding-left:20px;list-style:disc">
      <li>正常迁移</li>
      <li>空数据迁移</li>
      <li>超大数据 (10MB) 迁移</li>
      <li>迁移中刷新页面</li>
      <li>迁移中关闭浏览器</li>
    </ul>
  </div>
</div>

<details class="toggle">
  <summary>📊 性能对比数据</summary>
  <div class="toggle-content">
    <p>实测数据见 <a href="#/">性能基准</a> 子页面。结论:所有关键路径都有 <strong>3x 以上</strong> 提升,搜索场景从 180ms 降到 22ms,用户感知从"慢"变"瞬间"。</p>
  </div>
</details>`,
      3,
      0,
      ids.rfcMigration,
    ),
  )

  // 4.2 性能基准
  pages.push(
    mk(
      ids.rfc,
      '性能基准',
      `<h2>测试环境</h2>
<ul>
  <li>Chrome 126 / macOS 14.5 / M2 Pro</li>
  <li>数据集:200 个页面,平均每页 4KB JSON</li>
  <li>冷启动 vs 热启动 各测 5 次取 P50</li>
</ul>

<h2>读性能</h2>
<table>
  <thead><tr><th>操作</th><th>localStorage</th><th>IndexedDB</th><th>提升</th></tr></thead>
  <tbody>
    <tr><td>首次加载 (200 页)</td><td>280ms</td><td>65ms</td><td><span class="badge badge-success">4.3x</span></td></tr>
    <tr><td>单页读取</td><td>1.2ms</td><td>0.4ms</td><td><span class="badge badge-success">3x</span></td></tr>
    <tr><td>全文搜索 (关键词)</td><td>180ms</td><td>22ms</td><td><span class="badge badge-success">8x</span></td></tr>
  </tbody>
</table>

<h2>写性能</h2>
<table>
  <thead><tr><th>操作</th><th>localStorage</th><th>IndexedDB</th><th>提升</th></tr></thead>
  <tbody>
    <tr><td>更新单个页面</td><td>14ms (阻塞主线程)</td><td>2ms (异步)</td><td><span class="badge badge-success">7x</span></td></tr>
    <tr><td>批量导入 200 页</td><td>1.8s</td><td>120ms</td><td><span class="badge badge-success">15x</span></td></tr>
  </tbody>
</table>

<div class="callout success">
  <span class="material-symbols-outlined icon">speed</span>
  <div>
    <div class="callout-title">结论</div>
    <p>所有关键路径都有 <strong>3x 以上</strong> 性能提升,尤其是搜索场景从 180ms 降到 22ms,用户感知上从"慢"变为"瞬间"。迁移收益明显,推荐按计划执行。</p>
  </div>
</div>`,
      2,
      1,
      ids.rfcPerf,
    ),
  )

  // ──────────────────────────────────────────────────────────
  // 5) 2026 Q2 OKR 与会议纪要
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(
      null,
      '2026 Q2 OKR 与会议纪要',
      `<div class="callout info">
  <span class="material-symbols-outlined icon">flag</span>
  <div>
    <div class="callout-title">季度目标</div>
    <p>Q2 我们聚焦 <strong>"让知识库真正可用"</strong> — 完成 MVP 全功能、积累 100 个种子页面、把首次使用到第一次创建的路径缩短到 90 秒内。本季度周期 <time class="date-inline" data-date-mode="fixed" data-date="2026-04-01T00:00:00.000Z" datetime="2026-04-01T00:00:00.000Z">2026/04/01</time> ~ <time class="date-inline" data-date-mode="fixed" data-date="2026-06-30T00:00:00.000Z" datetime="2026-06-30T00:00:00.000Z">2026/06/30</time>。</p>
  </div>
</div>

<details class="toggle" open>
  <summary>📅 会议纪要</summary>
  <div class="toggle-content">
    <p>${refOkrW21}</p>
    <p>${refEditorDemo}</p>
  </div>
</details>

<h2>Objectives (3 个)</h2>
<ol>
  <li><strong>O1: 完成 MVP 全功能</strong> — 覆盖创建/编辑/删除/搜索/树结构,数据持久化</li>
  <li><strong>O2: 积累 100 个高质量种子页面</strong> — 让新用户进来就能看到真实可读的内容</li>
  <li><strong>O3: 首次使用到第一次创建 ≤ 90 秒</strong> — 从零到有第一篇内容,优化 onboarding 漏斗</li>
</ol>

<h2>Key Results</h2>
<h3>O1 → 完成 MVP 全功能</h3>
<table>
  <thead><tr><th>KR</th><th>目标</th><th>当前</th><th>状态</th></tr></thead>
  <tbody>
    <tr><td>KR1.1 富文本编辑器 (Tiptap)</td><td>100%</td><td>100%</td><td><span class="badge badge-success">已完成</span></td></tr>
    <tr><td>KR1.2 树状页面结构</td><td>100%</td><td>100%</td><td><span class="badge badge-success">已完成</span></td></tr>
    <tr><td>KR1.3 全文搜索</td><td>100%</td><td>35%</td><td><span class="badge badge-warning">进行中</span></td></tr>
    <tr><td>KR1.4 页面历史</td><td>100%</td><td>0%</td><td><span class="badge badge-danger">未开始</span></td></tr>
  </tbody>
</table>

<h3>O2 → 100 个种子页面</h3>
<table>
  <thead><tr><th>KR</th><th>目标</th><th>当前</th><th>状态</th></tr></thead>
  <tbody>
    <tr><td>KR2.1 产品/设计类</td><td>30</td><td>12</td><td><span class="badge badge-warning">进行中</span></td></tr>
    <tr><td>KR2.2 工程技术类</td><td>30</td><td>8</td><td><span class="badge badge-warning">进行中</span></td></tr>
    <tr><td>KR2.3 流程/会议类</td><td>20</td><td>5</td><td><span class="badge badge-warning">进行中</span></td></tr>
    <tr><td>KR2.4 文化/入职类</td><td>20</td><td>3</td><td><span class="badge badge-warning">进行中</span></td></tr>
  </tbody>
</table>

<h3>O3 → Onboarding 优化</h3>
<table>
  <thead><tr><th>KR</th><th>目标</th><th>当前</th><th>状态</th></tr></thead>
  <tbody>
    <tr><td>KR3.1 首次使用 → 第一次创建</td><td>≤ 90s</td><td>140s</td><td><span class="badge badge-warning">进行中</span></td></tr>
    <tr><td>KR3.2 新用户 7 日留存</td><td>≥ 60%</td><td>52%</td><td><span class="badge badge-warning">进行中</span></td></tr>
  </tbody>
</table>

<h2>会议安排</h2>
<ul>
  <li><strong>双周会</strong> — 周二 10:00,review KR 进度</li>
  <li><strong>设计评审</strong> — 周四 15:00,过设计稿和组件变更</li>
  <li><strong>技术分享</strong> — 周五 16:00,组内轮值</li>
</ul>

<div class="callout success">
  <span class="material-symbols-outlined icon">trending_up</span>
  <div>
    <div class="callout-title">进度概览</div>
    <p>截至 W22,O1 完成度 <strong>78%</strong>,O2 完成度 <strong>28%</strong>,O3 完成度 <strong>60%</strong>。整体节奏健康,Q2 末有望完成全部目标。</p>
  </div>
</div>`,
      6,
      4,
      ids.okr,
    ),
  )

  // 5.1 W21 周会纪要
  pages.push(
    mk(
      ids.okr,
      'W21 周会纪要',
      `<p><strong>时间:</strong> <time class="date-inline" data-date-mode="fixed" data-date="2026-06-17T10:00:00.000Z" datetime="2026-06-17T10:00:00.000Z">2026/06/17</time> 10:00 - 11:30<br>
<strong>地点:</strong> 3F 大会议室<br>
<strong>参会:</strong> 全体工程 + 产品 (12 人)<br>
<strong>记录人:</strong> 我</p>

<h2>议题</h2>
<ol>
  <li>Tiptap 迁移踩坑分享 (15min)</li>
  <li>树状页面结构的拖拽支持 (30min)</li>
  <li>IndexedDB 迁移方案评审 (30min)</li>
  <li>Onboarding 漏斗数据分析 (15min)</li>
</ol>

<h2>决议</h2>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><strong>[前端]</strong> Tiptap StarterKit 默认开启的快捷键会污染用户体验,统一在 handleKeyDown 拦截 → 已完成</div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><strong>[前端]</strong> 树节点拖拽本季度不做,P2 排期到 Q3</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>[后端]</strong> IndexedDB 迁移方案通过 PoC,Demo 时间 6/25</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>[产品]</strong> Onboarding 漏斗发现 60% 用户在第二步退出,需要简化"创建页面"步骤</div></li>
</ul>

<h2>行动项</h2>
<table>
  <thead><tr><th>负责人</th><th>事项</th><th>截止日期</th></tr></thead>
  <tbody>
    <tr>
      <td><span class="avatar" style="background:#FF5630">ZS</span> @张三</td>
      <td>写 Tiptap 迁移文档</td>
      <td><time class="date-inline" data-date-mode="fixed" data-date="2026-06-20T00:00:00.000Z" datetime="2026-06-20T00:00:00.000Z">2026/06/20</time></td>
    </tr>
    <tr>
      <td><span class="avatar" style="background:#0052CC">LS</span> @李四</td>
      <td>输出 IndexedDB PoC Demo</td>
      <td><time class="date-inline" data-date-mode="fixed" data-date="2026-06-25T00:00:00.000Z" datetime="2026-06-25T00:00:00.000Z">2026/06/25</time></td>
    </tr>
    <tr>
      <td><span class="avatar" style="background:#36B37E">WW</span> @王五</td>
      <td>重新设计 onboarding 引导</td>
      <td><time class="date-inline" data-date-mode="fixed" data-date="2026-06-30T00:00:00.000Z" datetime="2026-06-30T00:00:00.000Z">2026/06/30</time></td>
    </tr>
  </tbody>
</table>

<details class="toggle">
  <summary>📎 原始录音</summary>
  <div class="toggle-content">
    <p>录音文件在 <code>shared://meetings/2026-06-17.mp3</code>(脱敏后上传)。</p>
    <blockquote>本节仅限内部传阅,严禁外传。</blockquote>
  </div>
</details>

<h2>下次会议</h2>
<p>W23 周二 10:00,同一地点。重点议题:Onboarding v2 设计稿评审。</p>`,
      5,
      0,
      ids.okrW21,
    ),
  )

  // 5.2 W22 周会纪要
  pages.push(
    mk(
      ids.okr,
      'W22 周会纪要',
      `<p><strong>时间:</strong> <time class="date-inline" data-date-mode="fixed" data-date="2026-06-24T10:00:00.000Z" datetime="2026-06-24T10:00:00.000Z">2026/06/24</time> 10:00 - 11:00<br>
<strong>地点:</strong> 3F 大会议室<br>
<strong>参会:</strong> 全体工程 + 产品 (11 人)<br>
<strong>记录人:</strong> 我</p>

<h2>进展同步</h2>
<ul>
  <li><strong style="color: #36B37E">Atlas 设计系统 v3.0</strong> 正式发布,反馈良好</li>
  <li>种子页面扩充到 <strong>14 篇</strong></li>
  <li>Onboarding 漏斗优化上线,首次创建时长从 140s 降到 110s</li>
</ul>

<h2>议题</h2>
<ol>
  <li>Atlas v3.0 内部推广 (10min)</li>
  <li>Q3 规划初稿 (30min)</li>
  <li>客户案例库的需求讨论 (20min)</li>
</ol>

<h2>决议</h2>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><strong>[设计]</strong> Atlas v3.0 全员培训安排在 <time class="date-inline" data-date-mode="fixed" data-date="2026-07-03T00:00:00.000Z" datetime="2026-07-03T00:00:00.000Z">2026/07/03</time> 下午</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>[产品]</strong> Q3 主线定为"协作 + 全文搜索",需求文档下周三前出</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>[架构]</strong> 客户案例库使用独立空间隔离,权限模型 TBD</div></li>
</ul>

<div class="callout success">
  <span class="material-symbols-outlined icon">check_circle</span>
  <div>
    <div class="callout-title">Q2 收官在即</div>
    <p>还有一周 Q2 就结束了,各 Owner 抓紧时间推进剩余 KR。任何阻塞提前在群里喊,不要拖到最后一天。</p>
  </div>
</div>`,
      1,
      1,
      ids.okrW22,
    ),
  )

  // ──────────────────────────────────────────────────────────
  // 6) 新成员入职指南
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(
      null,
      '新成员入职指南',
      `<div class="callout info">
  <span class="material-symbols-outlined icon">waving_hand</span>
  <div>
    <div class="callout-title">欢迎加入!</div>
    <p>这份指南会带你走完入职的第一周。如果有任何问题,先在这里找答案;找不到就问师傅或直接在 Slack <strong>#new-hire-help</strong> 频道喊一声。</p>
  </div>
</div>

<h2>第一周任务清单</h2>
<ul data-type="taskList">
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 1 (<time class="date-inline" data-date-mode="now" data-date="2026-06-25T09:00:00.000Z" datetime="2026-06-25T09:00:00.000Z">2026/06/25</time>):</strong> 领取设备、配置邮箱、加入 Slack 工作区</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 1:</strong> 与师傅 1on1,了解团队节奏</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 2:</strong> 跑通本地开发环境,提交第一个 PR (哪怕是 typo 修正)</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 3:</strong> 读完 <a href="#/">Atlas 设计原则</a> 章节</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 4:</strong> 参与一次设计评审或技术评审,做记录人</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 5:</strong> 写一篇"我第一周的观察"发到知识库</div></li>
</ul>

<h2>必读文档</h2>
<ul>
  <li>${refAtlas}</li>
  <li>${refOkr}</li>
  <li>${refRfc}</li>
  <li>${refEditorDemo}</li>
</ul>

<h2>环境配置</h2>
<h3>1. 克隆仓库</h3>
<pre><code class="language-bash">git clone git@github.com:company/power-wiki.git
cd power-wiki
npm install</code></pre>

<h3>2. 启动开发服务器</h3>
<pre><code class="language-bash">npm run dev
# 浏览器打开 http://127.0.0.1:5173</code></pre>

<h3>3. 验证环境</h3>
<ul>
  <li>页面能正常加载 ✅</li>
  <li>点击"新建页面"能进入编辑态 ✅</li>
  <li>输入 <code>/</code> 能唤起斜杠菜单 ✅</li>
  <li>工具栏按钮 hover 出现高亮 ✅</li>
</ul>

<details class="toggle">
  <summary>🛠️ 常见问题</summary>
  <div class="toggle-content">
    <div class="callout warning">
      <span class="material-symbols-outlined icon">error</span>
      <div>
        <div class="callout-title">报错: <code>Cannot find module</code></div>
        <p>删除 <code>node_modules</code> 和 <code>package-lock.json</code>,重新 <code>npm install</code>。</p>
      </div>
    </div>
    <div class="callout warning">
      <span class="material-symbols-outlined icon">error</span>
      <div>
        <div class="callout-title">报错: 端口 5173 被占用</div>
        <p>用 <code>lsof -i :5173</code> 找占用进程,或换端口:<code>npm run dev -- --port 5174</code>。</p>
      </div>
    </div>
    <div class="callout warning">
      <span class="material-symbols-outlined icon">error</span>
      <div>
        <div class="callout-title">类型错误: <code>JSX element implicitly has type 'any'</code></div>
        <p>VSCode 装了 <em>Vue Language Features (Volar)</em> 吗?装完重启 IDE。</p>
      </div>
    </div>
  </div>
</details>

<h2>师傅指派</h2>
<table>
  <thead><tr><th>师傅</th><th>负责范围</th><th>联系方式</th></tr></thead>
  <tbody>
    <tr><td><span class="avatar" style="background:#FF5630">ZS</span> 张三</td><td>前端基础 + 编辑器</td><td>Slack: @zhangsan</td></tr>
    <tr><td><span class="avatar" style="background:#0052CC">LS</span> 李四</td><td>数据层 + 性能</td><td>Slack: @lisi</td></tr>
    <tr><td><span class="avatar" style="background:#36B37E">WW</span> 王五</td><td>设计 + 用户体验</td><td>Slack: @wangwu</td></tr>
  </tbody>
</table>

<blockquote>遇到问题不要自己扛超过 30 分钟,该问就问。</blockquote>

<div class="callout success">
  <span class="material-symbols-outlined icon">celebration</span>
  <div>
    <div class="callout-title">🎉 第一周结束奖励</div>
    <p>周五下午茶团队一起点外卖,师傅请你喝奶茶 🧋。</p>
  </div>
</div>`,
      4,
      5,
      ids.onboarding,
    ),
  )

  return pages
}