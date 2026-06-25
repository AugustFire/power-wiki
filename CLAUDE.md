# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

power-wiki 是一个开源的 Confluence 风格团队知识库 wiki。MVP 是纯前端的:页面数据存在 `localStorage`,没有后端。视觉设计由 `design/wiki-edit.html` 和 `design/wiki-read.html` 两个静态原型固定(Atlassian "Atlas" 风格),三栏布局:260px 侧边栏 / 860px 内容 / 220px 目录。仅桌面端 — 视口锁死 `min-width: 1280px`。

## 常用命令

```bash
npm install              # 安装依赖
npm run dev              # vite 开发服务器,http://127.0.0.1:5173 (strictPort)
npm run build            # vue-tsc -b && vite build (类型检查 + 打包)
npm run preview          # 预览构建产物
npx vue-tsc --noEmit -p tsconfig.app.json   # 仅类型检查
```

没有配置 lint 或单元测试脚本。

验收脚本在 `scripts/verify_*.py`(基于 Playwright,需要 `pip install playwright && playwright install chromium`)。每个阶段有对应的 `screenshots/phaseN/` 目录。示例:启动 dev server,然后在另一个终端运行 `python scripts/verify_phase4.py`。

## 技术栈

Vue 3(`<script setup>`)+ TypeScript + Vite 6 + Vue Router 4(hash 模式)+ Pinia(setup store)+ Tiptap 2(StarterKit + TaskList + Table + CodeBlockLowlight + DragHandle + Placeholder)+ lowlight/highlight.js + DOMPurify + nanoid。

`@` 在 `vite.config.ts` 和 `tsconfig.app.json` 中都别名指向 `src/`。

## 架构

**入口 / 启动** — `src/main.ts` 创建 app,安装 Pinia + Router,然后 `router.isReady()` 触发 `pagesStore.init()` 和 `uiStore` 实例化。首次启动时若不存在 `power-wiki:tree-expanded` 则写入空数组。

**路由** — `src/router/index.ts`(hash 历史,`scrollBehavior` 优先 `savedPosition` → `to.hash` → 顶部)。路由表:`/`(HomeView)、`/p/:id`(ReadView)、`/p/:id/edit`(EditView)、`/new?parent=:id`(EditView,接收 `parentId` prop)、catch-all 404。

**状态管理** — `src/stores/` 下两个 Pinia setup store:
- `pages.ts` — `PageNode[]` 数组,持久化到 `power-wiki:pages`。包含 CRUD(`createPage`、`updatePage`、`deletePage` 通过 `collectDescendantIds` 级联删除子节点、`renamePage`、`movePage` 带循环保护)、树构建(`getTree` 返回排好序的 `TreeNode[]`)、一次性 `migrateEmptyJson()`(为种子页面回填 `contentJSON`、重新打 schema 版本号)。通过 `watch(pages, …, { deep: true })` 自动保存。
- `ui.ts` — 树节点展开状态(持久化到 `power-wiki:tree-expanded`)、节点上下文菜单(`openMenuId` / `menuPos` — 全树共享,同一时刻只有一个菜单)、重命名状态(`renamingId`)。种子数据放在 `pages.ts` 文件底部。

**编辑器流水线** — `src/components/editor/RichEditor.vue` 用 `useEditor` 挂载扩展(来自 `src/editor/extensions.ts`),防抖 800ms 把 `getJSON()` + `getHTML()` emit 给父组件(`EditView.vue`)。`EditView.vue` 持有本地 title/JSON/HTML 引用、`isDirty`、`saveState`;`onMounted` 时若无 `id` 则新建页面,然后 `router.replace` 到 `/p/:id/edit`。"已保存" 提示通过定时器自动隐藏。

**Tiptap 扩展** — `src/editor/extensions.ts` 配置 StarterKit,关闭 `heading`、`codeBlock`(用 `HeadingAnchor` / `CodeBlockLowlight` 替换)。Markdown 输入/粘贴规则默认开启(`## ` → h2、`**bold**` → bold、`- ` → ul 等);Tiptap 通过 `view.composing` 字段自动跳过 IME 期间,中文打字不会被 inputRules 误判。自定义扩展:`HeadingAnchor`(替换 heading 节点的 NodeView 渲染锚点 — `src/editor/headingAnchor.ts` + `src/components/editor/HeadingView.vue`)、`CodeBlockView`(高亮代码块的 NodeView)、`Callout`(`src/editor/calloutExtension.ts`,4 种 variant 提示框)、`Toggle`(`src/editor/toggleExtension.ts`,details/summary 折叠块)、`PageRef`(`src/editor/pageRefExtension.ts`,Notion 风格页面引用卡片)。`BlockBrowserSave` 是一个 ProseMirror 插件(`priority: 1000`),仅拦截 Cmd/Ctrl+S 防浏览器「保存网页」对话框;其余格式快捷键(Cmd+B/I/U/Z/Y、Alt+1/2/3 等)放行给 Tiptap 默认 keymap。

**阅读视图** — `src/views/ReadView.vue` 通过 `v-html`(在 `src/lib/sanitize.ts` 中预先 sanitize)渲染 `contentHTML`。`TocPanel.vue` 用 `IntersectionObserver` 做 scroll-spy,点击目录项滚动到锚点;锚点由 `src/lib/headingAnchors.ts` 在 `v-html` 渲染后注入(因为 `v-html` 不在 ProseMirror 管辖范围)。

**持久化层** — `src/lib/storage.ts` 用 try/catch 包装 `localStorage`(`readJSON`、`writeJSON`、`hasKey`)。所有 key 都加 `power-wiki:*` 前缀。

**设计令牌** — `src/styles/tokens.css` 是视觉的唯一事实来源(从原型复制)。`base.css` 是 reset,`components.css` 是组件类。新增颜色/间距必须从这里取 — 不要自己造十六进制色值。

## 硬约束

以下为用户硬性要求,在用户明确要求之前不要引入(包括隐式引入):

- **不要暗色主题。** 不写 `prefers-color-scheme`、不做主题切换、不加 dark token 覆盖。
- **不要移动端适配。** 不写 `@media` 断点。`index.html` 的 viewport 锁死 `1280`,全局最小宽度 1280px。仅桌面端。
- **不要图片功能。** 不接 Tiptap Image 扩展、不做 URL 粘贴、不做文件上传。工具栏和 slash 菜单里都不能出现图片项。
- **键盘快捷键放开。** Tiptap StarterKit 默认 keymap 全开(格式、撤销重做、列表、引用、代码块等)。仅 Cmd/Ctrl+S 拦截以防浏览器「保存网页」对话框。

## 约定

- ID:`src/lib/id.ts` 的 `newId()` — `nanoid(10)`,字母表 31 字符(去掉了 0/o/1/i/l)。
- 空页面默认值:`title: '无标题页面'`、`contentJSON: { type: 'doc', content: [{ type: 'paragraph' }] }`、`contentHTML: '<p></p>'`。
- `PageNode.authorId` 写死 `'me'`(单用户 MVP)。首次启动时把用户记录写入 `power-wiki:user`。
- 页面切换:`App.vue` 里的 `<transition name="fade" mode="out-in">`(150ms)。
- 焦点环:仅键盘聚焦时显示(`#4C9AFF`),鼠标点击不出现。
- 图标:`material-symbols-outlined`。字体:Plus Jakarta Sans + PingFang SC 后备 + JetBrains Mono。

## 验收脚本

`scripts/verify_*.py` 和 `scripts/snap_*.py` 是按阶段划分的 Playwright 自动化检查。它们假定 dev server 已经在 `127.0.0.1:5173` 上运行。改动完成后用它们验证视觉和行为基线,再汇报完成。