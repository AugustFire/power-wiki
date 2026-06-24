import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { readJSON, writeJSON, hasKey } from '@/lib/storage'
import { newId } from '@/lib/id'
import {
  htmlToJson,
  isMigratedJSON,
  needsRemigrate,
  stampSchemaVersion,
} from '@/editor/htmlToJson'
import type { PageNode, TreeNode } from '@/types/page'

const KEY_PAGES = 'power-wiki:pages'
const KEY_USER = 'power-wiki:user'

export const usePagesStore = defineStore('pages', () => {
  const pages = ref<PageNode[]>(readJSON<PageNode[]>(KEY_PAGES, []))
  const ready = ref(false)

  watch(pages, (val) => writeJSON(KEY_PAGES, val), { deep: true })

  function persist(): void {
    writeJSON(KEY_PAGES, pages.value)
  }

  function init(): void {
    if (!hasKey(KEY_USER)) {
      writeJSON(KEY_USER, { id: 'me', name: '我', color: '#FF5630' })
    }
    // 只在 key 不存在时种入;key 存在但数组为空(用户已全删)保持空状态
    if (!hasKey(KEY_PAGES)) {
      pages.value = seedPages()
      migrateEmptyJson()
      writeJSON(KEY_PAGES, pages.value)
    } else {
      // key 存在但内容不是合法数组 → 回退到种子
      const raw = localStorage.getItem(KEY_PAGES)
      let isValid = false
      if (raw != null) {
        try {
          const parsed = JSON.parse(raw)
          isValid = Array.isArray(parsed)
        } catch {
          isValid = false
        }
      }
      if (!isValid) {
        console.warn('[pages] localStorage pages 损坏,回退到种子数据')
        pages.value = seedPages()
        migrateEmptyJson()
        writeJSON(KEY_PAGES, pages.value)
      } else {
        // 一次性回填存量页面的 contentJSON(种子页和早期页面只有 HTML 没有 JSON)
        migrateEmptyJson()
      }
    }
    ready.value = true
  }

  /**
   * 把 contentJSON 为空 {} 但 contentHTML 非空的页面回填成有效 JSON。
   * 同时处理 schema 版本不一致(codeBlock 缺 language 属性的旧 schema)。
   *
   * 只动"未迁移"或"需要重新迁移"的页面,不覆盖新内容。
   */
  function migrateEmptyJson(): void {
    let changed = false
    for (const p of pages.value) {
      const html = (p.contentHTML ?? '').trim()
      // 情况 1:从未迁移过(contentJSON 是空 {} 或非法)
      if (!isMigratedJSON(p.contentJSON)) {
        if (!html || html === '<p></p>') {
          p.contentJSON = stampSchemaVersion({
            type: 'doc',
            content: [{ type: 'paragraph' }],
          })
          changed = true
          continue
        }
        try {
          p.contentJSON = stampSchemaVersion(htmlToJson(html))
          changed = true
        } catch (err) {
          console.warn(`[pages] migrate 失败 page=${p.id}`, err)
        }
        continue
      }
      // 情况 2:已迁移但 schema 版本落后 / codeBlock 缺 language — 用 HTML 重新解析
      if (needsRemigrate(p.contentJSON) && html && html !== '<p></p>') {
        try {
          p.contentJSON = stampSchemaVersion(htmlToJson(html))
          changed = true
        } catch (err) {
          console.warn(`[pages] re-migrate 失败 page=${p.id}`, err)
        }
      } else if (needsRemigrate(p.contentJSON)) {
        // 没有 HTML 可重解析,只打 schema 版本号
        p.contentJSON = stampSchemaVersion(p.contentJSON as Record<string, unknown>)
        changed = true
      }
    }
    if (changed) persist()
  }

  function createPage(opts: { parentId?: string | null; title?: string } = {}): PageNode {
    const parentId = opts.parentId ?? null
    const siblings = pages.value.filter((p) => p.parentId === parentId)
    const order = siblings.length
    const now = Date.now()
    const page: PageNode = {
      id: newId(),
      parentId,
      title: opts.title ?? '无标题页面',
      contentJSON: { type: 'doc', content: [{ type: 'paragraph' }] },
      contentHTML: '<p></p>',
      order,
      createdAt: now,
      updatedAt: now,
      authorId: 'me',
    }
    pages.value.push(page)
    persist()
    return page
  }

  function getPage(id: string): PageNode | undefined {
    return pages.value.find((p) => p.id === id)
  }

  function updatePage(id: string, patch: Partial<PageNode>): void {
    const idx = pages.value.findIndex((p) => p.id === id)
    if (idx < 0) return
    pages.value[idx] = { ...pages.value[idx], ...patch, updatedAt: Date.now() }
    persist()
  }

  function deletePage(id: string): void {
    const ids = collectDescendantIds(id)
    pages.value = pages.value.filter((p) => !ids.has(p.id))
    persist()
  }

  function renamePage(id: string, title: string): void {
    updatePage(id, { title: title.trim() || '无标题页面' })
  }

  function collectDescendantIds(id: string): Set<string> {
    const result = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const p of pages.value) {
        if (p.parentId && result.has(p.parentId) && !result.has(p.id)) {
          result.add(p.id)
          changed = true
        }
      }
    }
    return result
  }

  function movePage(id: string, newParentId: string | null): void {
    if (id === newParentId) return
    if (newParentId) {
      const descendants = collectDescendantIds(id)
      if (descendants.has(newParentId)) return
    }
    updatePage(id, { parentId: newParentId })
  }

  function getTree(): TreeNode[] {
    const map = new Map<string, TreeNode>()
    for (const p of pages.value) {
      map.set(p.id, {
        id: p.id,
        title: p.title,
        parentId: p.parentId,
        order: p.order,
        children: [],
      })
    }
    const roots: TreeNode[] = []
    for (const p of pages.value) {
      const node = map.get(p.id)!
      if (p.parentId && map.has(p.parentId)) {
        map.get(p.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    const sortRec = (arr: TreeNode[]) => {
      arr.sort((a, b) => a.order - b.order)
      arr.forEach((n) => sortRec(n.children))
    }
    sortRec(roots)
    return roots
  }

  function getChildren(parentId: string | null): PageNode[] {
    return pages.value
      .filter((p) => p.parentId === parentId)
      .sort((a, b) => a.order - b.order)
  }

  const tree = computed(() => getTree())

  return {
    pages,
    ready,
    tree,
    init,
    persist,
    createPage,
    getPage,
    getChildren,
    updatePage,
    deletePage,
    renamePage,
    movePage,
    getTree,
  }
})

// ============================================================
//  种子页面 — Mock 富有表现力的内容,展示 wiki 各种块类型
// ============================================================
function seedPages(): PageNode[] {
  const now = Date.now()
  const pages: PageNode[] = []
  const mk = (
    parentId: string | null,
    title: string,
    contentHTML: string,
    daysAgo: number,
    order: number,
  ): PageNode => ({
    id: newId(),
    parentId,
    title,
    contentJSON: {},
    contentHTML,
    order,
    createdAt: now - 86400000 * daysAgo,
    updatedAt: now - 3600000 * daysAgo,
    authorId: 'me',
  })

  // ──────────────────────────────────────────────────────────
  // 1) 首页 — 我的知识库
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(null, '我的知识库', `<p>欢迎来到 <strong>power-wiki</strong>,这里是团队的中央知识库。点击左侧任意页面开始浏览,或点击右上角"新建页面"开始记录。</p>
<div class="callout info">
  <span class="material-symbols-outlined icon">lightbulb</span>
  <div>
    <div class="callout-title">这是什么?</div>
    <p>本知识库采用 <strong>Confluence 风格</strong> 的页面树结构 — 父子层级、面包屑导航、右侧目录。所有内容保存在浏览器本地,刷新不丢失。</p>
  </div>
</div>
<h2>知识库结构</h2>
<p>当前共有 <strong>${pages.length} 个页面</strong>,按主题分组为以下几个根页面:</p>
<ul>
  <li><strong>Atlas 设计系统 v3.0</strong> — 产品视觉规范、组件库、设计原则</li>
  <li><strong>工程 RFC</strong> — 架构决策、技术方案、评审记录</li>
  <li><strong>2026 Q2 OKR 与会议纪要</strong> — 季度目标、双周会议、设计评审</li>
  <li><strong>新成员入职指南</strong> — 第一周任务、必读文档、师傅指派</li>
</ul>
<h2>快速上手</h2>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>浏览左侧树状目录,了解知识库结构</div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>点击任意页面右上角的"编辑"按钮,试着修改内容</div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>hover 任意树节点,点 <span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">more_horiz</span> 创建子页面</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>输入 <code>/</code> 唤起斜杠菜单,体验块插入</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>试试 hover 页面标题右侧的 ⋯ 菜单</div></li>
</ul>
<blockquote>编辑内容后会自动保存到 localStorage。关闭浏览器再打开,内容仍在。</blockquote>`, 7, 0)
  )

  // ──────────────────────────────────────────────────────────
  // 2) Atlas 设计系统 v3.0 版本
  // ──────────────────────────────────────────────────────────
  const atlasRoot = mk(null, 'Atlas 设计系统 v3.0 版本', `<div class="callout success">
  <span class="material-symbols-outlined icon">auto_awesome</span>
  <div>
    <div class="callout-title">v3.0 已正式发布 🎉</div>
    <p>本次升级重写了组件 API、引入设计令牌、并对齐了 WCAG 2.1 AA 色彩对比度标准。详细迁移指南见子页面。</p>
  </div>
</div>
<h2>本次升级概览</h2>
<p>Atlas v3.0 是设计系统近 18 个月以来最大的一次迭代。新版本聚焦于三个核心方向:</p>
<ul>
  <li><strong>设计令牌</strong> — 颜色、字号、间距全部走 CSS 变量,主题切换无需重新编译</li>
  <li><strong>无障碍</strong> — 所有交互组件通过 WCAG 2.1 AA 认证,键盘可达性 100% 覆盖</li>
  <li><strong>开发者体验</strong> — 包体积减少 38%、TS 类型补全完善、Figma ↔ Code 双向同步</li>
</ul>
<h2>关键指标</h2>
<table>
  <thead>
    <tr><th>维度</th><th>v2.4</th><th>v3.0</th><th>变化</th></tr>
  </thead>
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
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>v3.0-alpha: 内部灰度 (2026/04)</div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>v3.0-rc: 公开预览 (2026/05)</div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div>v3.0 正式发布 (2026/06/12)</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>v2.x 进入维护期,仅修复安全问题 (2026/09 起)</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div>v2.x EOL: 停止服务 (2027/01)</div></li>
</ul>
<h2>反馈与贡献</h2>
<p>发现 bug 或有改进建议?在 <strong>#atlas-feedback</strong> Slack 频道留言,或在 GitHub 提 issue。每周三下午是设计系统的 Office Hour,设计师 + 前端工程师在线答疑。</p>
<div class="callout warning">
  <span class="material-symbols-outlined icon">warning</span>
  <div>
    <div class="callout-title">迁移期注意</div>
    <p>v2 → v3 的破坏性变更集中在 <code>Modal</code>、<code>Tooltip</code>、<code>Drawer</code> 三个组件的 API。请优先使用 codemod 工具自动迁移:<code>npx atlas-codemod v2-to-v3 ./src</code></p>
  </div>
</div>`, 5, 1)

  // Atlas 子页面: 设计原则
  const atlasPrinciples = mk(atlasRoot.id, '设计原则', `<p>Atlas 的设计原则回答一个核心问题:<em>在视觉与交互的取舍之间,我们应该怎么选?</em>以下七条原则按优先级排序,冲突时优先服从前者。</p>
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
  <li><a href="#/">Nielsen 十大启发式</a></li>
  <li><a href="#/">Material Design 3 设计原则</a></li>
  <li><a href="#/">Apple HIG: Design Principles</a></li>
</ul>`, 4, 0)

  // Atlas 子页面: 颜色令牌
  const atlasTokens = mk(atlasRoot.id, '颜色令牌', `<p>所有颜色定义在 <code>src/styles/tokens.css</code> 的 <code>:root</code> 中。组件样式中只能引用变量,不允许写死十六进制色值。</p>
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
<div class="callout info">
  <span class="material-symbols-outlined icon">palette</span>
  <div>
    <div class="callout-title">为什么用变量?</div>
    <p>令牌化的好处是 <strong>单一事实来源</strong>:换色改一处即可,所有组件联动。未来支持深色模式或客户白标时,只需新增一套变量覆盖。</p>
  </div>
</div>`, 4, 1)

  // Atlas 子页面: 组件库升级路线图
  pages.push(atlasRoot)
  pages.push(atlasPrinciples)
  pages.push(atlasTokens)
  pages.push(
    mk(atlasRoot.id, '组件库升级路线图', `<h2>Q3 计划</h2>
<ul data-type="taskList">
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><code>Modal</code> 迁移到 headless 库,体积再降 12KB</div></li>
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><code>DataTable</code> 引入虚拟滚动,支持 10w+ 行</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><code>DatePicker</code> 重写为单文件 SFC,支持农历</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><code>RichEditor</code> 接入协作光标(CRDT)</div></li>
</ul>
<h2>Q4 计划</h2>
<ul>
  <li>全新的 <code>Chart</code> 套件 (12 种基础图表)</li>
  <li>移动端组件 (注意:仅响应用户场景,不做完整移动适配)</li>
  <li><code>Form Builder</code> 低代码表单搭建</li>
</ul>
<div class="callout success">
  <span class="material-symbols-outlined icon">celebration</span>
  <div>
    <div class="callout-title">里程碑</div>
    <p>2026 年底前,Atlas 组件库目标: <strong>75 个组件</strong>、<strong>95% 单元测试覆盖</strong>、<strong>0 个已知 P0/P1 bug</strong>。</p>
  </div>
</div>`, 2, 2)
  )

  // ──────────────────────────────────────────────────────────
  // 3) 工程 RFC: 本地存储 → IndexedDB 迁移
  // ──────────────────────────────────────────────────────────
  const rfcRoot = mk(null, '工程 RFC:本地存储 → IndexedDB 迁移', `<div class="callout warning">
  <span class="material-symbols-outlined icon">pending_actions</span>
  <div>
    <div class="callout-title">状态:评审中</div>
    <p>本文档为 RFC(请求评议),征求工程团队的反馈意见。请在评论区留言或直接在文档上批注。</p>
  </div>
</div>
<h2>背景</h2>
<p>power-wiki MVP 目前使用 <code>localStorage</code> 持久化所有页面数据。随着用户开始积累内容,以下问题逐渐显现:</p>
<ul>
  <li><strong>5MB 硬上限</strong> — Chrome / Firefox 均限制 localStorage 在 5MB 左右,用户写到 ~80 页富文本时触发 <code>QuotaExceededError</code></li>
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
      <td>迁移到 IndexedDB 原生 API</td><td>浏览器配额 ~60% 磁盘 ✅</td><td>异步非阻塞 ✅</td><td>API 繁琐 ⚠️</td><td><span class="badge badge-warning">可用</span></td>
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
  <li>Promise-based API,告别回调地狱</li>
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
      <li>测试时需要 fake-indexeddb,否则单测无法跑通</li>
    </ul>
  </div>
</div>
<h2>时间线</h2>
<ul>
  <li><strong>2026/07 上旬</strong> — PoC 完成,Demo 给前端组</li>
  <li><strong>2026/07 下旬</strong> — 评审通过,合入主干</li>
  <li><strong>2026/08</strong> — 灰度发布 (10% 用户)</li>
  <li><strong>2026/09</strong> — 全量上线,清理迁移代码</li>
</ul>
<h2>替代方案:暂不迁移</h2>
<p>如果本季度没有大文件/搜索需求,继续用 localStorage 也可以接受。但每次写超过 100KB 的页面时,UI 会卡顿约 200ms,长期看不健康。</p>`, 3, 2)

  pages.push(rfcRoot)
  pages.push(
    mk(rfcRoot.id, '数据迁移策略详解', `<p>本文档是 <strong>数据迁移策略</strong> 的展开说明,回答"具体怎么从 localStorage 平滑过渡到 IndexedDB"。</p>
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
  <li>迁移期间,所有写操作同时写入 localStorage 和 IndexedDB</li>
  <li>读操作只读 IndexedDB</li>
  <li>迁移完成标志位写入后,关闭双写</li>
</ul>
<h2>失败回滚</h2>
<p>如果迁移过程中 IndexedDB 写入失败(配额、浏览器崩溃):</p>
<ol>
  <li>立即停止迁移</li>
  <li>删除已写入的部分数据</li>
  <li>回到 localStorage-only 模式</li>
  <li>提示用户:"迁移失败,数据已保留在原位置"</li>
</ol>
<div class="callout warning">
  <span class="material-symbols-outlined icon">warning</span>
  <div>
    <div class="callout-title">测试覆盖</div>
    <p>必须在以下场景全部通过才能上线:正常迁移、空数据迁移、超大数据 (10MB) 迁移、迁移中刷新页面、迁移中关闭浏览器。</p>
  </div>
</div>`, 3, 0)
  )
  pages.push(
    mk(rfcRoot.id, '性能基准', `<h2>测试环境</h2>
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
    <p>所有关键路径都有 <strong>3x 以上</strong> 性能提升,尤其是搜索场景从 180ms 降到 22ms,用户感知上从"慢"变为"瞬间"。</p>
  </div>
</div>`, 2, 1)
  )

  // ──────────────────────────────────────────────────────────
  // 4) 2026 Q2 OKR 与会议纪要
  // ──────────────────────────────────────────────────────────
  const okrRoot = mk(null, '2026 Q2 OKR 与会议纪要', `<div class="callout info">
  <span class="material-symbols-outlined icon">flag</span>
  <div>
    <div class="callout-title">季度目标</div>
    <p>Q2 我们聚焦 <strong>"让知识库真正可用"</strong> — 完成 MVP 全功能、积累 100 个种子页面、把首次使用到第一次创建的路径缩短到 90 秒内。</p>
  </div>
</div>
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
</div>`, 6, 3)

  pages.push(okrRoot)
  pages.push(
    mk(okrRoot.id, 'W21 周会纪要', `<p><strong>时间:</strong> 2026/06/17 10:00 - 11:30<br><strong>地点:</strong> 3F 大会议室<br><strong>参会:</strong> 全体工程 + 产品 (12 人)<br><strong>记录人:</strong> 我</p>
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
    <tr><td>@张三</td><td>写 Tiptap 迁移文档</td><td>6/20</td></tr>
    <tr><td>@李四</td><td>输出 IndexedDB PoC Demo</td><td>6/25</td></tr>
    <tr><td>@王五</td><td>重新设计 onboarding 引导</td><td>6/30</td></tr>
  </tbody>
</table>
<h2>下次会议</h2>
<p>W23 周二 10:00,同一地点。重点议题:Onboarding v2 设计稿评审。</p>`, 5, 0)
  )
  pages.push(
    mk(okrRoot.id, 'W22 周会纪要', `<p><strong>时间:</strong> 2026/06/24 10:00 - 11:00<br><strong>地点:</strong> 3F 大会议室<br><strong>参会:</strong> 全体工程 + 产品 (11 人)<br><strong>记录人:</strong> 我</p>
<h2>进展同步</h2>
<ul>
  <li>Atlas 设计系统 v3.0 正式发布,反馈良好</li>
  <li>种子页面扩充到 28 篇</li>
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
  <li data-checked="true"><label><input type="checkbox" checked="checked"/><span></span></label><div><strong>[设计]</strong> Atlas v3.0 全员培训安排在 7/3 下午</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>[产品]</strong> Q3 主线定为"协作 + 全文搜索",需求文档下周三前出</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>[架构]</strong> 客户案例库使用独立空间隔离,权限模型 TBD</div></li>
</ul>`, 1, 1)
  )

  // ──────────────────────────────────────────────────────────
  // 5) 新成员入职指南
  // ──────────────────────────────────────────────────────────
  pages.push(
    mk(null, '新成员入职指南', `<div class="callout info">
  <span class="material-symbols-outlined icon">waving_hand</span>
  <div>
    <div class="callout-title">欢迎加入!</div>
    <p>这份指南会带你走完入职的第一周。如果有任何问题,先在这里找答案;找不到就问师傅或直接在 Slack <strong>#new-hire-help</strong> 频道喊一声。</p>
  </div>
</div>
<h2>第一周任务清单</h2>
<ul data-type="taskList">
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 1:</strong> 领取设备、配置邮箱、加入 Slack 工作区</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 1:</strong> 与师傅 1on1,了解团队节奏</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 2:</strong> 跑通本地开发环境,提交第一个 PR (哪怕是 typo 修正)</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 3:</strong> 读完 <a href="#/">Atlas 设计系统</a> 的设计原则章节</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 4:</strong> 参与一次设计评审或技术评审,做记录人</div></li>
  <li data-checked="false"><label><input type="checkbox"/><span></span></label><div><strong>Day 5:</strong> 写一篇"我第一周的观察"发到知识库</div></li>
</ul>
<h2>必读文档</h2>
<ul>
  <li><a href="#/">Atlas 设计系统 v3.0 版本</a> — 视觉规范和组件库</li>
  <li><a href="#/">2026 Q2 OKR</a> — 团队目标,了解我们在做什么</li>
  <li><a href="#/">工程 RFC:本地存储 → IndexedDB 迁移</a> — 当前正在推进的架构决策</li>
</ul>
<h2>环境配置</h2>
<h3>1. 克隆仓库</h3>
<pre><code class="language-bash">git clone git@github.com:company/power-wiki.git
cd power-wiki
npm install</code></pre>
<h3>2. 启动开发服务器</h3>
<pre><code class="language-bash">npm run dev
# 浏览器打开 http://localhost:5173</code></pre>
<h3>3. 验证环境</h3>
<ul>
  <li>页面能正常加载 ✅</li>
  <li>点击"新建页面"能进入编辑态 ✅</li>
  <li>输入 <code>/</code> 能唤起斜杠菜单 ✅</li>
</ul>
<div class="callout warning">
  <span class="material-symbols-outlined icon">error</span>
  <div>
    <div class="callout-title">常见问题</div>
    <p>遇到 <code>Cannot find module</code> 报错?删除 <code>node_modules</code> 和 <code>package-lock.json</code>,重新 <code>npm install</code>。</p>
  </div>
</div>
<h2>师傅指派</h2>
<table>
  <thead><tr><th>师傅</th><th>负责范围</th><th>联系方式</th></tr></thead>
  <tbody>
    <tr><td><span class="avatar" style="background:#FF5630">ZS</span> 张三</td><td>前端基础 + 编辑器</td><td>Slack: @zhangsan</td></tr>
    <tr><td><span class="avatar" style="background:#0052CC">LS</span> 李四</td><td>数据层 + 性能</td><td>Slack: @lisi</td></tr>
    <tr><td><span class="avatar" style="background:#36B37E">WW</span> 王五</td><td>设计 + 用户体验</td><td>Slack: @wangwu</td></tr>
  </tbody>
</table>
<blockquote>遇到问题不要自己扛超过 30 分钟,该问就问。</blockquote>`, 4, 4)
  )

  return pages
}