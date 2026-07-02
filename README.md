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
- **三栏布局** — 280px 侧边栏 / 1100px 内容 / 240px 目录(可隐藏)
- **TOC scroll-spy** — 右侧目录随滚动高亮当前章节
- **14 篇种子页面** — 6 个根主题(我的知识库、编辑器速查、Atlas v3.0、RFC、OKR、入职指南)+ 8 个子页,演示所有编辑器能力

### 协作与权限

- **个人 / 共享空间** — 每个用户自动有 personal space,admin 可建 shared space 并按用户组授权
- **三态页面生命周期** — 正常 → 软删除(进回收站)→ 恢复 / 永久删除
- **软删除 + 回收站** — `/manager/trash` 查看、恢复、永久删除(30 天策略可后续扩展)
- **用户组** — 通过组批量管理空间访问权限,admin 维护成员名单
- **三态用户** — `active` / `disabled` / `must_reset_password`(新用户首次登录强制改密)

### Admin 后台

- **`/manager/people`** — 用户 + 组的合并页(tab 切换),含 disable / enable / 重置密码 / 加组 / 移组
- **`/manager/spaces`** — 空间列表 + 访问控制(整组替换 / 增 / 删)
- **`/manager/trash`** — 跨空间回收站,支持筛选 / 排序 / 批量恢复 / 永久删除

### 安全

- **自研薄鉴权** — argon2id 密码哈希 + DB sessions 表 + HTTP-only cookie
- **跨用户越权防护** — 不可见 space 一律返回 404(防 ID 猜测)
- **三态登录流** — 首次登录 → 强制重置密码 → 进入主页;新用户初始密码由 admin 在后台生成

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

打开 `http://localhost:5173/`,首次启动会自动 bootstrap(从 `apps/api/.env` 读 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 建管理员账号)→ 跳到 `/login` → 管理员登录 → 默认进入主页。

### 其他命令

```bash
pnpm dev                  # 同时起 web + api(顶层编排)
pnpm dev:web              # 仅前端
pnpm dev:api              # 仅后端
pnpm build                # 递归构建所有 workspace
pnpm typecheck            # 递归类型检查
pnpm -F api db:generate   # Drizzle:根据 schema 生成迁移 SQL
pnpm -F api db:migrate    # Drizzle:应用待执行的迁移(API 启动时也会自动跑)
pnpm -F api db:push       # Drizzle:跳过迁移,直推 schema(开发用)
docker compose down       # 停止 Postgres(数据保留在 volume 里)
docker compose down -v    # 停 + 删数据
```

## 🎨 视觉与设计

视觉风格对齐 Atlassian **Atlas** 设计系统,所有视觉细节(颜色、间距、字号、阴影)从静态原型 `design/wiki-edit.html` 和 `design/wiki-read.html` 抽取到 `apps/web/src/styles/tokens.css`。新增任何视觉属性都必须从这里取,**不允许**自己发明十六进制色值。

设计视口 **2560×1440**(24" 2K 显示器),最小宽度锁死 1280px — 仅桌面端。开发期间不要写 `@media` 断点。

**品牌识别** — 唯一资产来源 `apps/web/src/components/ui/BrandLogo.vue`(几何 P + 右侧递减透明度书页线,`fill="currentColor"`)。所有品牌出现位置(topbar / Login split layout 左栏 / ResetPassword split layout 左栏 / auth-boot 启动屏 / 404 页)都通过 `<BrandLogo>` 引用。Favicon 资产(`public/favicon.svg` + 16/32/180 PNG)改 SVG 后跑 `node scripts/render-favicons.mjs` 重新生成。

## 🏗️ 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | **Vue 3** + `<script setup>` | SFC 适合布局重的 wiki UI,Composition API 复用编辑器逻辑 |
| 语言 | **TypeScript** | 前后端共享类型,`PageNode` / `TreeNode` 等数据模型完整定义 |
| 构建 | **Vite 6** | 启动毫秒级,HMR 极快 |
| 路由 | **Vue Router 4** (hash 模式) | 纯前端、无需服务端 rewrite |
| 状态 | **Pinia** (setup store) | 4 个 store:`pages` / `ui` / `auth` / `spaces` |
| 编辑器 | **Tiptap 2** (ProseMirror 内核) | 30+ 官方扩展,6 个自定义扩展 |
| 前端持久化 | **localStorage** | 只存 `tree-expanded` + `activeSpaceId`,业务数据走 API |
| 后端 | **Hono** + **@hono/node-server** | 极轻、TS-first、内置 zod 校验 |
| ORM | **Drizzle ORM** | 纯 TS、零 codegen、SQL 接近原生 |
| 数据库 | **PostgreSQL 16** (jsonb + 递归 CTE) | Tiptap `contentJSON` 走 jsonb;树形查询靠 recursive CTE;软删除走 partial index |
| 校验 | **zod**(在 `packages/shared`) | 前后端共享 schema,types 由 zod 推导 |
| 鉴权 | **自研薄 auth** | argon2id + DB sessions + HTTP-only cookie,不引第三方 |
| 编排 | **pnpm workspaces** + **concurrently** | 单一 `pnpm dev` 同时起 web + api |
| 本地数据库 | **docker-compose** (postgres:16-alpine) | 一行 `docker compose up -d` 起来 |
| XSS 防御 | **DOMPurify** | read view HTML 走白名单,自定义 `data-*` 显式登记 |
| 图标 | **Material Symbols Outlined** | 与 Atlas 原型一致,字体 ligature |
| 字体 | Plus Jakarta Sans + PingFang SC + JetBrains Mono | 与 Atlas 原型一致 |

## 💾 数据模型

```ts
interface PageNode {
  id: string;                 // nanoid(10),31 字符字母表
  parentId: string | null;    // null = 顶级
  spaceId: string;            // 所属空间(必填,创建时校验)
  title: string;
  contentJson: object;        // Tiptap JSON 序列化(用于回填到编辑器)
  contentHtml: string;        // Tiptap HTML(用于 ReadView,sanitize 后)
  icon: string | null;        // emoji 或字符
  sortOrder: number;          // 同级排序
  createdAt: number;          // Date.now() ms
  updatedAt: number;
  authorId: string;           // 用户 id(老种子页保留 'me' 兼容)
  starred: boolean;
  deletedAt: number | null;   // 软删除时间,NULL = 正常
  deletedBy: string | null;   // 删除者用户 id
}
```

**localStorage keys**(只存 UI 状态,业务数据全走 API):
- `power-wiki:tree-expanded` → `string[]`(展开的节点 ID)
- `power-wiki:active-space` → `string`(当前激活空间 ID)

**API 端点(完整列表见下节)**:
- 4 个 Auth 端点(`/api/auth/{sign-in,sign-out,session,reset-password}`)
- 8 个 Pages 端点(list / trash / get / create / update / move / restore / delete;DELETE 默认软删,`?purge=true` 走硬删)
- 2 个 Spaces 端点
- 22 个 Admin 端点(users 7 + groups 7 + spaces 8,含各资源的成员 / 访问管理)

## 🔌 API 端点

`apps/api` 监听 `:8787`,前端通过 Vite proxy 走 `:5173/api`。所有非 auth/health 路由 `requireAuth`;`/api/admin/*` 全部 `requireAdmin`。

### Auth(`/api/auth/*`,公开)

| Method | Path | 说明 |
|---|---|---|
| POST | `/sign-in` | body `{email,password}` → Set-Cookie + `{user, mustResetPassword}` |
| POST | `/sign-out` | 清 cookie + 删 session |
| GET  | `/session` | 当前用户信息,401 表示未登录 |
| POST | `/reset-password` | body `{currentPassword,newPassword}`,需登录 |

### Pages(`/api/pages`)

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET    | `/` | 普通 | 按可见 space 过滤,admin 看全部 |
| GET    | `/trash` | admin | 跨空间回收站(`?space=` 必填) |
| GET    | `/:id` | 普通 | 不可见 space 返 404 |
| POST   | `/` | 普通 | body `{parentId?,title?,icon?,spaceId,...}` |
| PATCH  | `/:id` | 普通 | body `{title?,contentJSON?,contentHTML?,icon?,starred?}` |
| PATCH  | `/:id/move` | 普通 | body `{newParentId,newOrder?}`,循环返 409 |
| POST   | `/:id/restore` | admin | 恢复软删除页 |
| DELETE | `/:id` | 普通(soft) / admin(`?purge=true`) | 默认软删进回收站;`?purge=true` 硬删整棵子树 |

### Spaces(`/api/spaces`)

| Method | Path | 说明 |
|---|---|---|
| GET | `/` | 当前用户可见空间列表 |
| GET | `/:id` | 单个,不可见返 404 |

### Admin(`/api/admin/*`,全部 `requireAdmin`)

| Resource | 端点 |
|---|---|
| Users | `GET/POST /`、`GET/PATCH /:id`、`POST /:id/{disable,enable,reset-password}` |
| Groups | `GET/POST /`、`GET/PATCH/DELETE /:id`、`POST /:id/members`、`DELETE /:id/members/:userId` |
| Spaces | `GET/POST /`、`GET/PATCH/DELETE /:id`、`PUT /:id/access`(整组替换)、`POST /:id/access/:groupId`、`DELETE /:id/access/:groupId` |

所有路由用 zod schema 在 `packages/shared/src/schemas.ts` 校验入参,响应在出口用 `*.parse()` 二次校验(防 schema 漂移)。

## 📁 目录结构

pnpm workspaces monorepo:

```
power-wiki/
├── apps/
│   ├── web/                       # @power-wiki/web — Vue 3 + Vite 6 前端(5173)
│   │   ├── public/                # favicon.svg + 16/32/180 PNG
│   │   └── src/
│   │       ├── main.ts            # app 入口
│   │       ├── App.vue            # 根组件 + 全局 loading/error
│   │       ├── router/            # Vue Router(hash 模式)
│   │       ├── stores/            # pages.ts / ui.ts / auth.ts / spaces.ts
│   │       ├── views/             # HomeView / ReadView / EditView / MySpaceView / NotFoundView
│   │       │   ├── auth/          # LoginView / ResetPasswordView
│   │       │   └── manager/       # ManagerLayout + PeopleView / SpacesView / TrashView
│   │       │                      # + UserEditView / SpaceEditView / GroupEditView
│   │       │                      # + UsersView / GroupsView(back-compat redirect)
│   │       │                      # + panels/(context side panels)
│   │       ├── components/
│   │       │   ├── ui/            # BrandLogo / UserAvatar / UserMenu / ConfirmDialog / IconBtn
│   │       │   ├── layout/        # TopBar / TopSearch / Sidebar / PageTree / TocPanel
│   │       │   │                  # / SpaceSwitcher / MoveToSpaceMenu
│   │       │   └── editor/        # RichEditor + EditorToolbar + SlashMenu + BubbleMenu
│   │       │                      # + 6 个 NodeView(Callout / CodeBlock / Heading / Toggle / DateInline)
│   │       │                      # + 6 个 Popover(Link / Color / Emoji / DateTimePicker / ...)
│   │       ├── editor/            # Tiptap 扩展集合(extensions.ts + 6 个自定义)
│   │       ├── lib/               # id / sanitize / headingAnchors / api / storage / constants
│   │       ├── styles/            # tokens.css(设计令牌)/ base.css(reset)/ components.css
│   │       └── types/             # 前端本地类型
│   └── api/                       # @power-wiki/api — Hono + Drizzle + Postgres 后端(8787)
│       └── src/
│           ├── index.ts           # Hono 入口 + 中间件顺序 + 启动时自动 migrate + bootstrap
│           ├── db/
│           │   ├── schema.ts      # 7 张表(无 FK,所有级联由路由显式处理)
│           │   ├── client.ts      # drizzle(pool, { schema })
│           │   ├── bootstrap.ts   # 首次启动建 admin + 默认 space + backfill pages.spaceId
│           │   └── migrations/    # drizzle-kit generate 产物(0000 / 0001 / 0002 / 0003 / 0004)
│           ├── auth/
│           │   ├── password.ts    # argon2 hash/verify + initialPassword()
│           │   ├── session.ts     # createSession / getSession / deleteSession / killSessionsForUser
│           │   ├── middleware.ts  # requireAuth / requireAdmin
│           │   └── bootstrap.ts   # 启动期处理
│           ├── routes/
│           │   ├── auth.ts        # 4 个 auth 端点
│           │   ├── pages.ts       # 8 个 pages 端点(list/trash/get/create/update/move/restore/delete;DELETE 默认软删,`?purge=true` 走硬删)
│           │   ├── spaces.ts      # 用户可见 spaces
│           │   ├── adminUsers.ts  # admin CRUD + disable / enable / reset-password
│           │   ├── adminGroups.ts # admin CRUD + addMember / removeMember
│           │   └── adminSpaces.ts # admin CRUD + setAccess(整组替换)/ addAccess / removeAccess
│           └── lib/
│               ├── rowToPageNode.ts   # snake_case row → camelCase PageNode
│               ├── rowMappers.ts      # 其他表行映射
│               ├── ids.ts             # isDescendantOrSelf(递归 CTE)+ generateSessionId
│               ├── accessibleSpaceIds.ts  # 根据 userId 查可见 space id 列表
│               ├── ensurePersonalSpace.ts # 给用户建 personal space + pg-* 组 + 欢迎页
│               └── personalSpaceGuard.ts # admin 不能写 personal space 的反向保护
├── packages/
│   └── shared/                    # @power-wiki/shared — 共享 types + zod schemas
│       └── src/
│           ├── types.ts           # PageNode / TreeNode / User / UserGroup / Space / TiptapJSON
│           ├── schemas.ts         # 14 个 zod schema(响应出口二次校验)
│           ├── keys.ts            # PERSIST_KEYS 常量
│           └── index.ts           # barrel
├── design/                        # 设计原型(只读参考)
│   ├── wiki-edit.html
│   ├── wiki-read.html
│   └── design.txt                 # 原始需求 prompt
├── scripts/                       # Playwright 验收脚本(本地用)
├── screenshots/                   # 验收截图(临时产物)
├── docker-compose.yml             # postgres:16-alpine
├── pnpm-workspace.yaml
├── tsconfig.base.json             # 跨 workspace 共享 TS 选项
├── tsconfig.json                  # 根项目引用
├── package.json                   # 顶层:workspaces + dev/build/typecheck 编排
├── README.md                      # 本文件
├── CHANGELOG.md                   # 版本变更历史
└── CLAUDE.md                      # 给 AI 协作者的详细规约(架构 / 硬约束 / 契约)
```

> `@` alias 在 `apps/web/vite.config.ts` 和 `apps/web/tsconfig.app.json` 中指向 `apps/web/src/`,源码内 `import '@/...'` 不需要改路径。

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

截图统一存到 `screenshots/`,可随时重跑生成。

## ❌ 不做的事(设计选择)

| 选择 | 原因 |
|---|---|
| **不引入暗色主题** | 单一亮色主题保证视觉一致性,避免团队成员对"哪个主题"产生分歧 |
| **不做移动端适配** | 团队 wiki 主战场是桌面 24" 显示器,移动端会稀释核心体验 |
| **不做图片功能** | 文本优先,加载更快;文件管理走对象存储更专业,不适合塞进 wiki |
| **不做拖拽排序** | 树节点暂时靠 ⋯ 菜单「上移 / 下移」重排,简单可控 |
| **不做实时协作** | Y.js 依赖已安装,留待单用户 MVP 验证完成后再上 |
| **Drizzle schema 不许 FK** | 所有表不写 `.references()`,级联删除在路由里用 recursive CTE 显式处理 |

## 📊 功能矩阵

| 功能 | 状态 | 证据 |
|---|---|---|
| 富文本编辑 | ✓ 已完成 | `apps/web/src/editor/extensions.ts` |
| 树状页面 | ✓ 已完成 | `apps/web/src/stores/pages.ts` |
| 全量鉴权 | ✓ 已完成 | `apps/api/src/auth/` |
| Admin 后台 | ✓ 已完成 | `apps/web/src/views/manager/` |
| 个人/共享空间 | ✓ 已完成 | `apps/api/src/lib/ensurePersonalSpace.ts` |
| 软删除回收站 | ✓ 已完成 | `apps/web/src/views/manager/TrashView.vue` |
| 用户组 + 访问控制 | ✓ 已完成 | `apps/api/src/routes/adminGroups.ts` + `adminSpaces.ts` |
| 设计令牌体系 | ✓ 已完成 | `apps/web/src/styles/tokens.css` |
| 品牌资产统一 | ✓ 已完成 | `apps/web/src/components/ui/BrandLogo.vue` |
| 列表分页 | ☐ 未做 | 当前全量 `SELECT *`,100+ 数据需补 limit/offset |
| 登录限速 | ☐ 未做 | `/api/auth/sign-in` 无防爆破 |
| 审计日志 | ☐ 未做 | admin 操作不留痕 |
| 页面版本历史 | ☐ 未做 | PATCH 直接覆盖,无 `page_revisions` 表 |
| 全文搜索 | ☐ 未做 | `TopSearch.vue` 只匹配 title,无后端 |
| 导入 / 导出 | ✓ 部分完成 | ReadView 操作区 HTML / Markdown / PDF 单页导出;文件名 `sanitizeFilename`,GitHub 标准 admonition 序列化;批量 / 导入 defer |
| 评论 / @mention / 通知 | ☐ 未做 | — |
| 协作(Yjs) | ☐ 未做 | 依赖已装,留待未来 |
| 暗色主题 | ✗ 故意不做 | 单一亮色,见 § "不做的事" |
| 移动端适配 | ✗ 故意不做 | 仅桌面端,见 § "不做的事" |
| 图片 / 附件 | ✗ 故意不做 | 文本优先,见 § "不做的事" |
| 实时协作 | ✗ 故意不做 | Yjs 留待未来,见 § "不做的事" |

## 📐 设计 Token

所有视觉细节(`colors`、`spacing`、`radii`、`shadows`、`typography`)必须从 `apps/web/src/styles/tokens.css` 取,**不允许**自己发明颜色或间距。

关键 token 速查:

- 背景:`--bg #FFFFFF` / `--bg-canvas #F4F5F7` / `--bg-sidebar #FAFBFC`
- 主色:`--accent #0052CC` / `--accent-hover #0747A6` / `--accent-soft #DEEBFF` / `--accent-softer #F4F8FF`
- 文字:`--text-1 #172B4D` / `--text-2 #44546F` / `--text-3 #6B778C`
- 边框:`--border #DFE1E6` / `--border-strong #C1C7D0`
- 语义:`--success #36B37E` / `--warning #FFAB00` / `--danger #FF5630` / `--purple #403294`
- 圆角:`--radius-sm 3px` / `--radius-md 4px` / `--radius-lg 6px` / `--radius-pill 999px`
- 尺寸:`--topbar-h 56px` / `--sub-h 48px` / `--sidebar-w 280px` / `--toc-w 240px` / `--content-max 1100px`

## 📄 License

MIT
