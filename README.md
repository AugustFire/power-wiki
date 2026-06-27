# power-wiki

> **团队知识库 wiki** · Confluence 风格 · Atlassian Atlas 设计系统 · pnpm workspaces monorepo(Vue 3 前端 + Hono/Postgres 后端 + 共享 types 包),跑 `pnpm dev` 就能用。

![编辑器速查页](screenshots/seed_editor_demo.png)

---

## ✨ 为什么选 power-wiki

- **3 步跑起来** — `pnpm install && docker compose up -d && pnpm dev`,打开 `http://localhost:5173` 立刻看到 wiki 应用
- **本地全栈** — `apps/api`(Hono + Drizzle + Postgres)保存页面数据;`apps/web` 通过 Vite proxy 把 `/api/*` 转发到 8787,前端不用感知跨域
- **Confluence 风格** — 三栏布局(树 / 内容 / 目录),Atlassian Atlas 设计系统,5 种自定义块(callout / toggle / pageRef / dateInline / headingAnchor)
- **Tiptap 2 内核** — ProseMirror 驱动的富文本编辑,30+ 官方扩展 + 6 个自定义扩展,自动 Markdown 输入规则、键盘快捷键开箱即用
- **设计令牌统一** — 颜色 / 间距 / 字号 / 阴影全走 CSS 变量,改一处全局联动
- **完整的验收体系** — 13+ 个 Playwright 脚本覆盖每个改动阶段,改完跑一遍就能验证视觉 / 行为基线
- **TypeScript 严格模式** — `vue-tsc --noEmit` 全程通过,无 `any` 滥用
- **XSS 防御到位** — read view HTML 走 DOMPurify 白名单,自定义 `data-*` 属性和 `time` / `details` 标签都需要显式登记

## 🎯 它能做什么

### 编辑器

- **完整富文本** — H1 / H2 / H3、粗 / 斜 / 删 / 行内代码、行内链接、8 种文字色、8 种高亮色
- **列表 / 任务** — 无序、有序、嵌套任务列表、3 级深度任意嵌套
- **代码块** — highlight.js 语法高亮,顶部语言切换(typescript / tsx / json / bash / ...),一键复制
- **表格** — 增删行列、合并单元格、表头 / 单元格着色,首行表头默认
- **引用 / 分割线 / 文字对齐** — 左 / 中 / 右,blockquote 套其他块
- **Markdown 输入规则** — 输入 `## ` 自动转 H2,`**文字**` 转粗体,`- ` 转列表,中文 IME 期间自动跳过
- **键盘快捷键** — `Cmd/Ctrl+B / I / U / Z / Y`、`Alt+1/2/3`、`Ctrl+Alt+C` 全部就绪

### 自定义块(基于 Tiptap 自定义扩展)

- **Callout** — 4 种变体(info / success / warning / danger),用于提示、警告、里程碑等
- **Toggle** — `<details>/<summary>` 折叠块,允许任意块嵌套,适合放 FAQ / 补充说明
- **PageRef** — Notion 风格页面引用卡片,点击跳转到目标页
- **DateInline** — 行内日期节点,`now` 模式自动更新到当天 / `fixed` 模式钉死具体日期
- **HeadingAnchor** — heading 自动挂 `id` 锚点,目录点击直接跳转

### 文档结构

- **树状页面** — 无限层级,展开状态持久化
- **三栏布局** — 260px 侧边栏 / 1100px 内容 / 220px 目录(可隐藏)
- **TOC scroll-spy** — 右侧目录随滚动高亮当前章节
- **14 篇种子页面** — 6 个根主题(我的知识库、编辑器速查、Atlas v3.0、RFC、OKR、入职指南)+ 8 个子页,演示所有编辑器能力

## 🚀 30 秒上手

需要本机装好 **Node 20.11+**、**pnpm 9+**、**Docker**(给 Postgres 用)。

```bash
git clone https://github.com/AugustFire/power-wiki.git
cd power-wiki
pnpm install
cp apps/api/.env.example apps/api/.env   # 第一次需要
docker compose up -d                     # 拉起 Postgres(127.0.0.1:5432)
pnpm dev                                 # 同时起 web(5173) + api(8787)
```

打开 `http://localhost:5173/`,前端初始化时会自动写入 14 篇种子页面。

### 其他命令

```bash
pnpm dev                  # 同时起 web + api(顶层编排)
pnpm dev:web              # 仅前端
pnpm dev:api              # 仅后端
pnpm build                # 递归构建所有 workspace
pnpm typecheck            # 递归类型检查
pnpm -F api db:generate   # Drizzle:根据 schema 生成迁移 SQL
pnpm -F api db:migrate    # Drizzle:应用待执行的迁移
pnpm -F api db:push       # Drizzle:跳过迁移,直推 schema(开发用)
docker compose down       # 停止 Postgres(数据保留在 volume 里)
docker compose down -v    # 停 + 删数据
```

## 🎨 视觉与设计

视觉风格对齐 Atlassian **Atlas** 设计系统,所有视觉细节(颜色、间距、字号、阴影)从静态原型 `design/wiki-edit.html` 和 `design/wiki-read.html` 抽取到 `src/styles/tokens.css`。新增任何视觉属性都必须从这里取,**不允许**自己发明十六进制色值。

设计视口 **2560×1440**(24" 2K 显示器),最小宽度锁死 1280px — 仅桌面端。开发期间不要写 `@media` 断点。

**品牌识别** — 唯一资产来源 `apps/web/src/components/ui/BrandLogo.vue`(几何 P + 右侧递减透明度书页线,`fill="currentColor"`)。所有品牌出现位置(topbar / Login split layout 左栏 / ResetPassword split layout 左栏 / auth-boot 启动屏 / 404 页)都通过 `<BrandLogo>` 引用。Favicon 资产(`public/favicon.svg` + 16/32/180 PNG)改 SVG 后跑 `node scripts/render-favicons.mjs` 重新生成。

## 🏗️ 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | **Vue 3** + `<script setup>` | SFC 适合布局重的 wiki UI,Composition API 复用编辑器逻辑 |
| 语言 | **TypeScript** | 前后端共享类型,`PageNode` / `TreeNode` 等数据模型完整定义 |
| 构建 | **Vite 6** | 启动毫秒级,HMR 极快 |
| 路由 | **Vue Router 4** (hash 模式) | 纯前端、无需服务端 rewrite |
| 状态 | **Pinia** (setup store) | Vue 官方推荐,TS 友好 |
| 编辑器 | **Tiptap 2** (ProseMirror 内核) | 30+ 官方扩展,6 个自定义扩展 |
| 前端持久化 | **localStorage**(过渡) | 暂时保留,Stage 3 后切到 API |
| 后端 | **Hono** + **@hono/node-server** | 极轻、TS-first、内置 zod 校验 |
| ORM | **Drizzle ORM** | 纯 TS、零 codegen、SQL 接近原生 |
| 数据库 | **PostgreSQL 16**(jsonb + 递归 CTE) | Tiptap `contentJSON` 走 jsonb;树形查询靠 recursive CTE |
| 校验 | **zod**(在 `packages/shared`) | 前后端共享 schema,types 由 zod 推导 |
| 编排 | **pnpm workspaces** + **concurrently** | 单一 `pnpm dev` 同时起 web + api |
| 本地数据库 | **docker-compose**(postgres:16-alpine) | 一行 `docker compose up -d` 起来 |
| XSS 防御 | **DOMPurify** | read view HTML 走白名单,自定义 `data-*` 显式登记 |
| 图标 | **Material Symbols Outlined** | 与 Atlas 原型一致,字体 ligature |
| 字体 | Plus Jakarta Sans + PingFang SC + JetBrains Mono | 与 Atlas 原型一致 |

## 💾 数据模型

```ts
interface PageNode {
  id: string;              // nanoid(10),31 字符字母表
  parentId: string | null; // null = 顶级
  title: string;
  contentJSON: object;     // Tiptap JSON 序列化(用于回填到编辑器)
  contentHTML: string;     // Tiptap HTML(用于 ReadView,sanitize 后)
  order: number;           // 同级排序
  createdAt: number;       // Date.now()
  updatedAt: number;
  authorId: string;        // 单用户 MVP,固定为 'me'
}
```

**localStorage keys(Stage 3 后会被 API 替代,目前仍作为离线降级保留):**
- `power-wiki:pages` → `PageNode[]`
- `power-wiki:tree-expanded` → `string[]`(展开的节点 ID)
- `power-wiki:user` → `{ id: 'me', name: '我', color: '#FF5630' }`

**API(Stage 2 接入,apps/api 监听 :8787,前端通过 Vite proxy 走 :5173/api):**
- `GET    /api/pages` → `PageNode[]`
- `GET    /api/pages/:id` → `PageNode`
- `POST   /api/pages` body `{ parentId?, title?, icon? }` → `PageNode`(201)
- `PATCH  /api/pages/:id` body `{ title?, contentJSON?, contentHTML?, icon?, starred? }` → `PageNode`
- `PATCH  /api/pages/:id/move` body `{ newParentId, newOrder? }` → `PageNode`(409 if cycle)
- `DELETE /api/pages/:id` → 204(级联删除后代)

## 📁 目录结构

pnpm workspaces monorepo:

```
power-wiki/
├── apps/
│   ├── web/                       # 前端(Vue 3 + Vite 6)
│   │   ├── package.json           # @power-wiki/web
│   │   ├── src/                   # 全部前端代码(原根目录 src/ 搬过来)
│   │   │   ├── main.ts
│   │   │   ├── App.vue
│   │   │   ├── router/
│   │   │   ├── stores/            # pages.ts(CRUD + 树) / ui.ts
│   │   │   ├── views/             # HomeView / ReadView / EditView / NotFoundView
│   │   │   ├── components/        # layout/ + editor/(NodeView + Popover) + ui/(UserAvatar / UserMenu / **BrandLogo**)
│   │   │   ├── editor/            # Tiptap 扩展集合
│   │   │   ├── lib/               # id / storage / sanitize / headingAnchors / ...
│   │   │   ├── styles/            # tokens.css / base.css / components.css
│   │   │   └── types/
│   │   ├── public/                # favicon.svg + 16/32/180 PNG(BrandLogo 的源 SVG)
│   │   ├── index.html             # SPA 入口 + 字体 CDN + favicon 链接 + theme-color
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json          # 项目引用
│   │   ├── tsconfig.app.json      # 应用代码编译选项
│   │   └── tsconfig.node.json     # vite.config 编译选项
│   └── api/                       # 后端(Stage 2 接入:Node + Hono + Drizzle + Postgres)
│       └── src/                   # 占位,见 plan
├── packages/
│   └── shared/                    # 前后端共享 types + zod schemas(Stage 1 接入)
│       └── src/                   # 占位
├── design/                        # 设计原型(只读参考)
│   ├── wiki-edit.html
│   └── wiki-read.html
├── scripts/                       # Playwright 验收脚本(本地用,已 gitignore)
├── screenshots/                   # 验收截图(已 gitignore)
├── pnpm-workspace.yaml            # 声明 apps/* + packages/*
├── tsconfig.base.json             # 跨 workspace 共享 TS 选项
├── tsconfig.json                  # 根项目引用
├── package.json                   # 顶层:workspaces + dev/build/typecheck 编排
└── .env.example                   # 顶层环境变量样例(后端阶段启用)
```

> 当前阶段(Stage 0):只搬了目录,后端业务逻辑待 Stage 2 接入。`@` alias 在 `apps/web/tsconfig.app.json` + `vite.config.ts` 中继续指向 `apps/web/src`,源码层 0 改动。

## 🧪 验收

每个改动阶段都有一份 `scripts/verify_*.py` 自动验收脚本,改动完成后跑一遍就能验证视觉 / 行为基线。

```bash
# 启动 dev server(在 apps/web 起的 vite,5173)
pnpm dev

# 在另一个终端运行验收
python scripts/verify_date_inline.py   # 单功能验收
python scripts/verify_p18.py            # 阶段验收
```

运行需要 Python 3.13+ 和 `playwright`:

```bash
pip install playwright
playwright install chromium
```

截图统一存到 `screenshots/`(已 gitignore,可随时重跑生成)。

## ❌ 不做的事(设计选择)

| 选择 | 原因 |
|---|---|
| **不引入暗色主题** | 单一亮色主题保证视觉一致性,避免团队成员对"哪个主题"产生分歧 |
| **不做移动端适配** | 团队 wiki 主战场是桌面 24" 显示器,移动端会稀释核心体验 |
| **不做图片功能** | 文本优先,加载更快;文件管理走对象存储更专业,不适合塞进 wiki |
| **不做拖拽排序** | 树节点暂时靠 ⋯ 菜单「上移 / 下移」重排,简单可控 |
| **不做实时协作** | Y.js 依赖已安装,留待单用户 MVP 验证完成后再上 |

## 🔮 Roadmap

- [ ] **导入 / 导出** — JSON / Markdown 互转,弥补清缓存丢数据的痛点
- [ ] **全局搜索** — UI 占位已就位,接 FlexSearch / Lunr.js
- [ ] **页面历史** — 每次保存生成快照,支持回滚
- [ ] **协作模式** — Y.js + WebSocket provider,多人同时编辑
- [ ] **IndexedDB 迁移** — 数据量过 5MB 时自动迁移,扩展容量上限
- [ ] **完整中文化** — 当前 zh-CN,需要 i18n 框架时引入 vue-i18n
- [ ] **后端集成** — `apps/api`(Hono + Drizzle + Postgres)+ `packages/shared` 共享 types,`apps/web` 的 `src/lib/storage.ts` 替换为 API client(详见 plan)

## 📐 设计 Token

所有视觉细节(`colors`、`spacing`、`radii`、`shadows`、`typography`)必须从 `src/styles/tokens.css` 取,**不允许**自己发明颜色或间距。

关键 token 速查:

- 背景:`--bg #FFFFFF` / `--bg-canvas #F4F5F7` / `--bg-sidebar #FAFBFC`
- 主色:`--accent #0052CC` / `--accent-hover #0747A6` / `--accent-soft #DEEBFF` / `--accent-softer #F4F8FF`
- 文字:`--text-1 #172B4D` / `--text-2 #44546F` / `--text-3 #6B778C`
- 边框:`--border #DFE1E6` / `--border-strong #C1C7D0`
- 语义:`--success #36B37E` / `--warning #FFAB00` / `--danger #FF5630` / `--purple #403294`
- 尺寸:`--radius 3px` / `--topbar-h 56px` / `--sub-h 48px` / `--sidebar-w 260px` / `--toc-w 220px` / `--content-max 1100px`

## 📄 License

MIT
