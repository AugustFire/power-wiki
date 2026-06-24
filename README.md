# power-wiki

> 一个开源、适合团队协作的企业知识库 wiki。
> MVP 阶段：纯前端、localStorage 持久化,跑通"创建 → 编辑 → 树形导航 → 阅读 → 持久化"核心闭环。

设计风格参考 Atlassian "Atlas" 设计系统,完全照搬 `design/wiki-edit.html` / `design/wiki-read.html` 两个静态原型的视觉。

---

## 🚀 快速开始

```bash
cd power-wiki
npm install
npm run dev
```

打开浏览器访问 `http://localhost:5173/`,即可看到一个完整的 wiki 应用。

```bash
# 生产构建
npm run build

# 类型检查
npm run type-check
```

---

## 🧱 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | **Vue 3** + Composition API + `<script setup>` | SFC 适合布局重的 wiki UI |
| 语言 | **TypeScript** | 类型安全,PageNode / TreeNode 等数据模型完整定义 |
| 构建 | **Vite** | 启动毫秒级,HMR 体验极佳 |
| 路由 | **Vue Router 4** (hash 模式) | 纯前端、无需服务端 rewrite |
| 状态 | **Pinia** (setup store) | Vue 官方推荐,TS 友好 |
| 编辑器 | **Tiptap** (StarterKit + TaskList + Table + Placeholder) | ProseMirror 内核;后续接 Y.js 协同最顺 |
| 持久化 | **localStorage** | 用户指定"浏览器缓存",零后端 |
| 图标 | **Material Symbols Outlined** | 与原型一致 |
| 字体 | Plus Jakarta Sans + PingFang SC + JetBrains Mono | 与原型一致 |

---

## ✨ 核心功能 (MVP)

- ✅ **三栏布局**:左侧树 / 中间内容 / 右侧 TOC(原型一致)
- ✅ **树形导航**:无限层级嵌套,展开/折叠状态持久化
- ✅ **创建/删除/重命名**:通过树节点 ⋯ 菜单
- ✅ **Tiptap 富文本编辑**:H1/H2/H3、粗体/斜体/删除线/行内代码、列表/任务列表/表格/引用/代码块/分隔线
- ✅ **Slash 菜单**:输入 `/` 弹出插入面板(不包含图片/链接)
- ✅ **自动保存**:编辑 1.2s 后写回 localStorage
- ✅ **阅读视图**:状态条、byline、TOC scroll-spy、子页面列表、反应、评论占位
- ✅ **空状态**:插画 + "创建第一个页面" 大按钮
- ✅ **错误恢复**:localStorage JSON 损坏 → console.warn + 回退到种子数据
- ✅ **页面切换**:fade-in 150ms 过渡
- ✅ **键盘焦点环**:仅键盘聚焦时显示(`#4C9AFF`),鼠标点击不出现

---

## ❌ 硬约束 (绝不违反)

| 约束 | 状态 | 说明 |
|---|---|---|
| ❌ 黑暗主题 | ✅ 不引入 | 无 `prefers-color-scheme`、无主题切换 UI、无 dark token |
| ❌ 移动端适配 | ✅ 不引入 | 无 `@media (max-width:...)`、无响应式断点;`body { min-width: 1280px }` 强制桌面 |
| ❌ 图片功能 | ✅ 不引入 | 无 Tiptap Image 扩展、无 URL 粘贴、无文件上传;工具栏/ slash 菜单均无图片项 |
| ❌ 链接插入 | ✅ 不引入 | 无 Tiptap Link 扩展;无链接 UI |
| ❌ 键盘快捷键 | ✅ 不绑定 | Tiptap `editorProps.handleKeyDown` 在所有 keymap 之前拦截 `Mod-b/i/u/e/z/y/s/a` 及所有 `Mod-Shift/Mod-Alt` 组合键,StarterKit 内置快捷键全部失效 |

工具栏按钮的 `title` 属性会显示 "Ctrl+B" 等提示文字(看起来专业),但 click 之外**不响应任何键盘事件**——这是有意为之,不是 bug。

---

## 📁 目录结构

```
power-wiki/
├── design/                        # 设计原型(只读参考)
│   ├── wiki-edit.html
│   └── wiki-read.html
├── src/
│   ├── main.ts                    # createApp + Pinia + Router + 初始化 store
│   ├── App.vue                    # 顶层布局 + 页面切换 transition
│   ├── router/index.ts            # 4 条 hash 路由
│   ├── stores/
│   │   ├── pages.ts               # PageNode CRUD + 树构建 + localStorage
│   │   └── ui.ts                  # 侧边栏展开状态 / 菜单 / 重命名
│   ├── views/
│   │   ├── HomeView.vue           # 首页(空状态 / 列表)
│   │   ├── ReadView.vue           # 阅读页
│   │   ├── EditView.vue           # 编辑页
│   │   └── NotFoundView.vue       # 404
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.vue
│   │   │   ├── PageTree.vue       # 递归组件
│   │   │   └── TocPanel.vue       # scroll-spy
│   │   └── editor/
│   │       ├── RichEditor.vue     # Tiptap 容器
│   │       ├── EditorToolbar.vue  # 16 个工具栏按钮
│   │       └── SlashMenu.vue      # / 触发
│   ├── editor/
│   │   └── extensions.ts          # Tiptap 扩展集合(含 NoKeyboardShortcuts)
│   ├── lib/
│   │   ├── id.ts                  # nanoid(10)
│   │   └── storage.ts             # localStorage 封装(含 try/catch)
│   ├── styles/
│   │   ├── tokens.css             # 设计 token(从原型复制)
│   │   ├── base.css               # reset
│   │   └── components.css         # 组件样式
│   └── types/page.ts              # PageNode / TreeNode
├── scripts/
│   ├── verify_phase0.py
│   ├── verify_phase1.py
│   ├── verify_phase2.py
│   ├── verify_phase3.py
│   └── verify_phase4.py
├── screenshots/
│   └── phase{0-4}/                # 每个 Phase 的截图
├── package.json
├── vite.config.ts
├── tsconfig.json
└── index.html                     # SPA 入口 + 字体 CDN
```

---

## 🗺️ 路由

| 路径 | 视图 | 说明 |
|---|---|---|
| `#/` | HomeView | 首页:空状态或"最近编辑"列表 |
| `#/p/:id` | ReadView | 阅读页 |
| `#/p/:id/edit` | EditView | 编辑页(已存在页面) |
| `#/new?parent=:id` | EditView | 新建子页面 |
| `*` | NotFoundView | 404 |

---

## 💾 数据模型

```ts
interface PageNode {
  id: string;              // nanoid(10)
  parentId: string | null; // null = 顶级
  title: string;
  contentJSON: object;     // Tiptap JSON 序列化
  contentHTML: string;     // Tiptap HTML(用于 ReadView)
  order: number;           // 同级排序
  createdAt: number;       // Date.now()
  updatedAt: number;
  authorId: string;        // v1 固定为 'me'
}
```

**localStorage keys:**
- `power-wiki:pages` → `PageNode[]`
- `power-wiki:tree-expanded` → `string[]`
- `power-wiki:user` → `{ id: 'me', name: '我', color: '#FF5630' }`

---

## 🧪 验收

每个 Phase 都有一份 `scripts/verify_phaseN.py` 自动验收脚本 + `screenshots/phaseN/` 截图。

```bash
# 启动 dev server
npm run dev

# 在另一个终端运行验收
python scripts/verify_phase4.py
```

需要 Python 3.13+ 和 `playwright`(`pip install playwright && playwright install chromium`)。

---

## 🔮 后续阶段(不在 MVP)

| 排除项 | 原因 |
|---|---|
| ❌ 黑暗主题 | 用户硬约束 |
| ❌ 移动端适配 | 用户硬约束 |
| ❌ 图片功能 | 用户明确延后 |
| ❌ 链接插入 | 与图片一起延后 |
| ❌ 键盘快捷键 | 用户明确延后 |
| 拖拽排序(树节点重排) | MVP 范围外 |
| 全局搜索实际功能 | UI 占位 |
| 通知/帮助/分享真实功能 | UI 占位 |
| 草稿/已发布状态分离 | 后续阶段 |
| 关注、评论、页面历史 | 后续阶段 |
| 管理员、登录、权限、协同 | 后续阶段 |
| 多空间切换 | v1 仅一个空间 |

---

## 📐 设计 Token

所有视觉细节(`colors`、`spacing`、`radii`、`shadows`、`typography`)必须从 `design/wiki-edit.html` / `design/wiki-read.html` 复制到 `src/styles/tokens.css` 后引用,**不允许**自己发明颜色或间距。

关键 token:
- `--bg #FFFFFF` / `--bg-canvas #F4F5F7` / `--bg-sidebar #FAFBFC`
- `--accent #0052CC` / `--accent-hover #0747A6` / `--accent-soft #DEEBFF`
- `--text-1 #172B4D` / `--text-2 #44546F` / `--text-3 #6B778C`
- `--border #DFE1E6` / `--border-strong #C1C7D0`
- `--success #36B37E` / `--warning #FFAB00` / `--danger #FF5630`
- `--radius: 3px`(全局)
- `--topbar-h 56px` / `--sub-h 48px` / `--sidebar-w 260px` / `--toc-w 220px` / `--content-max 1100px`
