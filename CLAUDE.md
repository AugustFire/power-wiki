# CLAUDE.md

This file provides guidance for Claude Code (claude.ai/code) when working with code in this repository.

## 项目

power-wiki 是一个开源的 Confluence 风格团队知识库 wiki。**项目结构是 pnpm workspaces monorepo**:`apps/web`(Vue 3 前端,监听 5173)+ `apps/api`(Hono + Drizzle + Postgres 后端,监听 8787)+ `packages/shared`(前后端共享 types + zod schemas)。

**当前已实现的能力**:全量登录鉴权(自研薄 auth + argon2 + DB sessions)+ admin 后台(`/manager`)+ 用户组 + Space + 页面按可见 space 过滤 + **个人/共享空间分离** + **软删除回收站**。`/api/auth/sign-in` → 拿到 HTTP-only cookie → 其余 API 强制 requireAuth → admin 路由 requireAdmin。前端 `stores/pages.ts` 走 API,不再用 localStorage 存业务数据。视觉设计由 `design/wiki-edit.html` 和 `design/wiki-read.html` 两个静态原型固定(Atlassian "Atlas" 风格),三栏布局:280px 侧边栏 / 1100px 内容 / 240px 目录。设计视口 2560×1440(24" 2K 显示器),最小宽度 1280px — 仅桌面端。

## 目录结构

```
power-wiki/
├── apps/
│   ├── web/                # @power-wiki/web — Vue 3 + Vite 6 前端(5173)
│   │   ├── public/              # favicon.svg + 16/32/180 PNG,BrandLogo 的源 SVG
│   │   └── src/
│   │       ├── stores/           # pages.ts / ui.ts / auth.ts / spaces.ts(Pinia setup store)
│   │       ├── views/
│   │       │   ├── HomeView / ReadView / EditView / MySpaceView / NotFoundView
│   │       │   ├── auth/         # LoginView / ResetPasswordView(split layout 品牌区)
│   │       │   └── manager/      # ManagerLayout + PeopleView / SpacesView / TrashView
│   │       │                      # + UserEditView / SpaceEditView / GroupEditView
│   │       │                      # + UsersView / GroupsView(back-compat redirect)
│   │       │                      # + panels/(3 个 context side panel)
│   │       └── components/
│   │           ├── ui/           # UserAvatar / UserMenu / BrandLogo / ConfirmDialog / IconBtn
│   │           ├── layout/       # TopBar / TopSearch / Sidebar / PageTree / TocPanel / SpaceSwitcher
│   │           └── editor/       # RichEditor / EditorToolbar / SlashMenu / BubbleMenu
│   │                              # + 6 个 NodeView + 6 个 Popover
│   └── api/                # @power-wiki/api — Hono 后端(8787)
│       └── src/
│           ├── index.ts            # Hono entry,CORS + middleware 顺序 + 启动时自动 migrate + bootstrap
│           ├── db/
│           │   ├── schema.ts       # Drizzle schema(7 张表,无 FK)
│           │   ├── client.ts       # drizzle(pool, { schema })
│           │   ├── bootstrap.ts    # 启动检测:建 admin + 默认 space + 给每个用户 ensurePersonalSpace
│           │   └── migrations/     # drizzle-kit generate 产物(0000/0001/0002/0003/0004)
│           ├── auth/
│           │   ├── password.ts     # argon2 hash/verify + initialPassword()
│           │   ├── session.ts      # createSession / getSession / deleteSession / killSessionsForUser
│           │   ├── middleware.ts   # requireAuth / requireAdmin → Hono 中间件
│           │   └── bootstrap.ts    # auth 模块的启动期初始化
│           ├── routes/
│           │   ├── auth.ts         # sign-in / sign-out / session / reset-password(4 路由)
│           │   ├── pages.ts        # 8 路由(list/trash/get/create/update/move/restore/delete),GET 按可见 space 过滤,POST 必填 spaceId,DELETE 默认软删(`?purge=true` 走硬删)
│           │   ├── spaces.ts       # GET 当前用户可见 spaces
│           │   ├── adminUsers.ts   # admin CRUD + disable / enable / reset-password
│           │   ├── adminGroups.ts  # admin CRUD + addMember / removeMember
│           │   └── adminSpaces.ts  # admin CRUD + setAccess(整组替换)+ addAccess + removeAccess
│           └── lib/
│               ├── rowToPageNode.ts # snake_case row → camelCase PageNode
│               ├── rowMappers.ts    # 其他表行映射
│               ├── ids.ts          # isDescendantOrSelf(递归 CTE)+ generateSessionId
│               ├── accessibleSpaceIds.ts # 根据 userId 查可见 space id 列表(join group_members × space_group_access)
│               ├── ensurePersonalSpace.ts # 给用户建 personal space + pg-* 组 + 欢迎页
│               └── personalSpaceGuard.ts  # admin 不能写 personal space 的反向保护
├── packages/
│   └── shared/             # @power-wiki/shared — types + zod + persist keys
├── design/                 # 设计原型(只读)
├── scripts/                # Playwright 验收脚本(本地用)
├── docker-compose.yml      # postgres:16-alpine(5432)
├── pnpm-workspace.yaml
├── tsconfig.base.json      # 跨 workspace 共享 TS 选项
├── tsconfig.json           # 根项目引用
├── package.json            # 顶层:workspaces + 编排脚本
├── README.md               # 用户向文档(快速上手 / 功能矩阵 / API 端点)
├── CHANGELOG.md            # 版本变更历史
└── CLAUDE.md               # 本文件(给 AI 协作者的详细规约)
```

> `apps/web/src/` 即原根目录 src 目录的整体平移(目录搬家,源码内 import 不变)。`@` alias 在 `apps/web/vite.config.ts` 和 `apps/web/tsconfig.app.json` 中继续指向 `apps/web/src`,**源码内 `import '@/...'` 不需要改一个字**。

## 品牌识别

品牌资产唯一来源是 `apps/web/src/components/ui/BrandLogo.vue`(几何 P + 右侧递减透明度书页线,`fill="currentColor"` 由父级 `color:` 控制)。`apps/web/public/favicon.svg` 是同一份 SVG 的独立导出(锁定 `#0052CC` 颜色,给 favicon 用)。改 logo 流程:改 `BrandLogo.vue` 里的 `<svg>` + 同步 `public/favicon.svg`,然后 `node scripts/render-favicons.mjs` 重新生成 PNG。所有品牌出现的位置(topbar / Login split layout 左栏 / ResetPassword split layout 左栏 / auth-boot 启动屏 / 404 页)都通过 `<BrandLogo>` 引用,**不要再写 `<span>P</span>` 这种 HTML 字母**。

## 常用命令

```bash
pnpm install              # 安装所有 workspace 依赖
docker compose up -d       # 拉起 Postgres(127.0.0.1:5432,首次需要)
cp apps/api/.env.example apps/api/.env   # 首次需要,后续 gitignored
pnpm dev                  # 顶层 dev:同时起 apps/web(5173)+ apps/api(8787)
pnpm dev:web              # 仅前端
pnpm dev:api              # 仅后端
pnpm build                # 递归构建所有 workspace
pnpm typecheck            # 递归类型检查
pnpm -F web dev           # 单 workspace 命令
pnpm -F api db:generate   # Drizzle:根据 schema 生成迁移 SQL
pnpm -F api db:migrate    # Drizzle:应用待执行的迁移(API 启动时也会自动跑)
node scripts/render-favicons.mjs   # 从 public/favicon.svg 重新生成 16/32/180 PNG
docker compose down       # 停 Postgres(数据保留)
```

没有配置 lint 或单元测试脚本。验收脚本是 `scripts/verify_*.py` 和 `scripts/snap_*.py`(按阶段组织,见 CLAUDE.md 的"验收脚本"章节),基于 Playwright。示例:启动 dev server,然后在另一个终端跑 `python scripts/verify_date_inline.py`。

## 技术栈

Vue 3(`<script setup>`)+ TypeScript + Vite 6 + Vue Router 4(hash 模式)+ Pinia(setup store,4 个 store: pages / ui / auth / spaces)+ Tiptap 2(StarterKit + 大量官方扩展 + 6 个自定义扩展)+ lowlight/highlight.js + DOMPurify + nanoid。

`@` 在 `apps/web/vite.config.ts` 和 `apps/web/tsconfig.app.json` 中都别名指向 `apps/web/src/`。

Tiptap 官方扩展(`apps/web/src/editor/extensions.ts`):StarterKit 关闭 `heading` / `codeBlock`(由 `HeadingAnchor` / `CodeBlockView` 替换);其余默认开。`Markdown` 输入/粘贴规则(StarterKit 自带,`## ` → h2、`**bold**` → bold、`- ` → ul 等);IME 期间(`view.composing === true`)inputRules 自动跳过,中文打字不会被误判。还启用了:Link、TextStyle + Color、Highlight、TaskList + TaskItem、Table + Row + Cell + Header、CodeBlockLowlight、TextAlign、Placeholder、BubbleMenu、DragHandle、Collaboration / y-prosemirror / y-tiptap(为后续多端协作预留,Y.js 已安装但未启用)。

## 架构

**入口 / 启动** — `apps/web/src/main.ts` 创建 app,安装 Pinia + Router,然后 `router.isReady()` 触发 `authStore.init()`(幂等,module-scoped `initRef` 防 HMR 漏)。`pagesStore` / `spacesStore` / `uiStore` 首次访问时初始化。

**路由** — `apps/web/src/router/index.ts`(hash 历史,`scrollBehavior` 优先 `savedPosition` → `to.hash` → 顶部)。完整路由表:
- `/login` (LoginView) / `/reset-password` (ResetPasswordView) — 公开
- `/` (HomeView) / `/me` (MySpaceView) / `/p/:id` (ReadView) / `/p/:id/edit` (EditView) / `/new?parent=:id` (EditView) — 需登录
- `/manager/*` (ManagerLayout + 子路由) — 需 admin
  - `/manager/people` / `/manager/people/users/:id` / `/manager/people/groups/:id`
  - `/manager/spaces` / `/manager/spaces/:id`
  - `/manager/trash`
  - `/manager/users` / `/manager/users/:id` / `/manager/groups` / `/manager/groups/:id`(back-compat redirect)
- catch-all 404
- 守卫顺序:idempotent auth init → public pass-through → mustResetPassword 强制重置 → requiresAdmin 走 NotFound(不暴露 /manager 存在)→ requiresAuth 走 /login。

**状态管理** — `apps/web/src/stores/` 下四个 Pinia setup store:
- `apps/web/src/stores/pages.ts` — `PageNode[]` 数组,业务数据走 API(乐观更新 + 失败回滚)。包含 CRUD(`createPage`、`updatePage`、`softDeletePage` / `restorePage` / `purgePage`、`movePage` 带循环保护)、树构建(`getTree` 返回排好序的 `TreeNode[]`)、本地 `trashed` 状态(由 TrashView 维护)。通过 `api.pages.*` 同步。
- `apps/web/src/stores/ui.ts` — 树节点展开状态(持久化到 `power-wiki:tree-expanded`)、节点上下文菜单(`openMenuId` / `menuPos` — 全树共享,同一时刻只有一个菜单)、重命名状态(`renamingId`)、全局 error banner。
- `apps/web/src/stores/auth.ts` — 当前 user / `isAuthed` / `isAdmin` / `needsPasswordReset`、`status: 'idle'|'loading'|'ready'|'error'` 状态机、`init()` 幂等。401 = "未登录"(不报错),其他 = 真的错误。
- `apps/web/src/stores/spaces.ts` — 可见 space 列表、`activeSpaceId`(持久化到 `power-wiki:active-space`)、`setActive(id)` 触发侧边栏 / 树重新渲染。

**编辑器流水线** — `apps/web/src/components/editor/RichEditor.vue` 用 `useEditor` 挂载扩展(来自 `apps/web/src/editor/extensions.ts`),防抖 800ms 把 `getJSON()` + `getHTML()` emit 给父组件(`apps/web/src/views/EditView.vue`)。`EditView.vue` 持有本地 title/JSON/HTML 引用、`isDirty`、`saveState`;`onMounted` 时若无 `id` 则新建页面,然后 `router.replace` 到 `/p/:id/edit`。"已保存" 提示通过定时器自动隐藏。

**Tiptap 自定义扩展** — 全部在 `apps/web/src/editor/` 下,每个扩展都有对应的 `apps/web/src/components/editor/<Name>View.vue` NodeView(行内 / 块级都走 `VueNodeViewRenderer`):
- `HeadingAnchor` (`apps/web/src/editor/headingAnchor.ts` + `apps/web/src/components/editor/HeadingView.vue`) — 替换 heading 节点,渲染时挂 `id` 锚点
- `CodeBlockView` (`apps/web/src/editor/extensions.ts:170-180` + `apps/web/src/components/editor/CodeBlockView.vue`) — 代码块 NodeView,语言切换 + 复制按钮
- `Callout` (`apps/web/src/editor/calloutExtension.ts` + `apps/web/src/components/editor/CalloutView.vue`) — 4 种 variant(info / success / warning / danger)的提示框
- `Toggle` (`apps/web/src/editor/toggleExtension.ts` + `apps/web/src/components/editor/ToggleView.vue`) — `<details>/<summary>` 折叠块,允许任意块嵌套
- `PageRef` (`apps/web/src/editor/pageRefExtension.ts`) — Notion 风格页面引用卡片(`<a class="page-ref-card" data-page-id="...">`)
- `DateInline` (`apps/web/src/editor/dateInlineExtension.ts` + `apps/web/src/components/editor/DateInlineView.vue` + `apps/web/src/components/editor/DateTimePicker.vue`) — 行内日期 atom 节点,`mode: 'now' | 'fixed'`,now 模式在 NodeView 中启动 setInterval 每 60s 重算显示文案;点击节点弹 DateTimePicker 编辑
- `BlockBrowserSave` (`apps/web/src/editor/extensions.ts:42-67`) — ProseMirror 插件 `priority: 1000`,**只**拦截 Cmd/Ctrl+S 防浏览器「保存网页」对话框;其余格式快捷键(Cmd+B/I/U/Z/Y、Alt+1/2/3、Ctrl+Alt+C 等)全部放行给 Tiptap 默认 keymap

**Popover 组件** — 都是 Vue SFC,定位方案分两类:
- **Teleport 到 body**:只有 `EditorBubbleMenu`(Tiptap BubbleMenu + tippy 默认行为)。其他所有 popover 走第二种方式。
- **position:absolute 锚定在 .tb-* 容器内**:`ColorPopover`、`LinkPopover`、`EmojiPicker`、`DateTimePicker`(工具栏唤起的)、`CalloutVariantMenu`、`TableMenu`、`CellColorPicker`、`BlockTypeMenu` 等。`DateInlineView` 的 `.di-popover` 是唯一用 `position:fixed` + 视口坐标的特例。
  - 依赖契约:`apps/web/src/styles/components.css` 里 `.editor-toolbar .tb-inner` 必须是 `overflow:visible`,不能加 `overflow:auto` / `overflow:hidden`,否则所有下拉被裁掉。这条契约在 CSS 注释里已正式标记。

**阅读视图** — `apps/web/src/views/ReadView.vue` 通过 `v-html`(在 `apps/web/src/lib/sanitize.ts` 中预先 sanitize)渲染 `contentHTML`。`TocPanel.vue` 用 `IntersectionObserver` 做 scroll-spy,点击目录项滚动到锚点;锚点由 `apps/web/src/lib/headingAnchors.ts` 在 `v-html` 渲染后注入(因为 `v-html` 不在 ProseMirror 管辖范围)。

**持久化层** — 业务数据走 Postgres(经 `apps/api` Hono 路由),前端 `stores/pages.ts` 调 `apps/web/src/lib/api.ts` 的 `api.pages.*`。`apps/web/src/lib/storage.ts` 保留作为离线降级兜底(目前未用)。localStorage 只剩 2 个 key:`power-wiki:tree-expanded`(`ui` store)+ `power-wiki:active-space`(`spaces` store),都集中在 `packages/shared/src/keys.ts`。

**API**(`apps/api`,监听 8787,前端通过 Vite proxy 走 5173/api,所有非 auth/health 路由 `requireAuth`):
- **Auth**(`/api/auth/*` 不走 requireAuth):
  - `POST /api/auth/sign-in` body `{email,password}` → 200 `{user, mustResetPassword}` + `Set-Cookie: pw_session`
  - `POST /api/auth/sign-out` → 204
  - `GET  /api/auth/session` → 200 `{user, mustResetPassword}` 或 401
  - `POST /api/auth/reset-password` body `{currentPassword,newPassword}` → 200 user
- **Pages**(`/api/pages`,普通用户自动按可见 space 过滤,admin 看全部):
  - `GET    /api/pages?space=<id>` → `PageNode[]`
  - `GET    /api/pages/trash?space=<id>` → `PageNode[]`(admin only,软删除列表)
  - `GET    /api/pages/:id` → `PageNode`(404 走 `{"error":"not_found"}`,不可见 space 也返回 404 防越权猜测)
  - `POST   /api/pages` body `{parentId?,title?,icon?,spaceId,...}` → 201 + `PageNode`(spaceId 必填)
  - `PATCH  /api/pages/:id` body `{title?,contentJSON?,contentHTML?,icon?,starred?}` → `PageNode`
  - `PATCH  /api/pages/:id/move` body `{newParentId,newOrder?}` → `PageNode`(409 cycle)
  - `POST   /api/pages/:id/restore` → 恢复软删除页(admin only)
  - `DELETE /api/pages/:id` → 204 软删除(递归 CTE 一次删完整子树,因为 schema 无 FK CASCADE)
  - `DELETE /api/pages/:id?purge=true` → 204 硬删除(admin only)
- **Spaces**(普通用户):
  - `GET /api/spaces` → 当前用户可见 space 列表
  - `GET /api/spaces/:id` → 单个
- **Admin**(`/api/admin/*` 全部 `requireAdmin`):
  - **users**: `GET/POST /`、`GET/PATCH /:id`、`POST /:id/{disable,enable,reset-password}`
  - **groups**: `GET/POST /`、`GET/PATCH/DELETE /:id`、`POST /:id/members`、`DELETE /:id/members/:userId`
  - **spaces**: `GET/POST /`、`GET/PATCH/DELETE /:id`、`PUT /:id/access`(整组替换)、`POST /:id/access/:groupId`、`DELETE /:id/access/:groupId`

所有路由用 `apps/api/src/lib/rowToPageNode.ts` / `rowMappers.ts` 把 Drizzle row(snake_case)转成 `PageNode`(camelCase),再用 `PageNodeSchema.parse(...)` 在响应边界校验 schema 是否和 `@power-wiki/shared` 漂移。move 路由的循环保护走 `apps/api/src/lib/ids.ts` 的 recursive CTE(`isDescendantOrSelf`),一次往返拿到全部后代;DELETE 路由用同模式的 recursive CTE 把整棵子树一次性删除(替代 FK CASCADE,因为 schema 不允许 FK)。

**Auth 自研**(理由见 plan):argon2id(`@node-rs/argon2`)+ DB sessions 表 + HTTP-only cookie(`pw_session`, `SameSite=Lax`, 30 天固定过期,启动时 `purgeExpiredSessions` 清理)。`auth/session.ts` 的 `killSessionsForUser(userId)` 在 admin 禁用 / 重置密码时被调用,负责清理该用户的所有 session。

**设计令牌** — `apps/web/src/styles/tokens.css` 是视觉的唯一事实来源(从原型复制)。`base.css` 是 reset,`components.css` 是组件类。新增颜色/间距必须从这里取 — 不要自己造十六进制色值。

## 硬约束

以下为用户硬性要求,在用户明确要求之前不要引入(包括隐式引入):

- **不要暗色主题。** 不写 `prefers-color-scheme`、不做主题切换、不加 dark token 覆盖。
- **不要移动端适配。** 不写 `@media` 断点。`index.html` 的 viewport 锁死 `1280`,全局最小宽度 1280px。仅桌面端。
- **不要图片功能。** 不接 Tiptap Image 扩展、不做 URL 粘贴、不做文件上传。工具栏和 slash 菜单里都不能出现图片项。
- **键盘快捷键放开。** Tiptap StarterKit 默认 keymap 全开(格式、撤销重做、列表、引用、代码块等)。仅 Cmd/Ctrl+S 拦截以防浏览器「保存网页」对话框。
- **暂时不要文档协同。** Yjs / y-prosemirror / y-tiptap 依赖已装,留待未来启用。
- **Drizzle schema 不许用外键约束。** `apps/api/src/db/schema.ts` 里所有表都不写 `.references()`,所有 `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` 类的 DDL 都不写。级联删除必须显式在路由里完成:
  - 删 page 子树 → `pages.ts` DELETE 走 recursive CTE
  - 删 group → `adminGroups.ts` DELETE 在事务里先扫 `userGroupMembers` + `spaceGroupAccess`
  - 删 space → `adminSpaces.ts` DELETE 在事务里先扫 `spaceGroupAccess`
  - 删 user(禁用 / 重置)→ `adminUsers.ts` 的 `disable` / `reset-password` 先调 `killSessionsForUser` 清 sessions
  写新表 / 新列也要遵守这条。

## 约定

- ID:`apps/web/src/lib/id.ts` 的 `newId()` — `nanoid(10)`,字母表 31 字符(去掉了 0/o/1/i/l);后端 `apps/api/src/lib/ids.ts` 的 `generatePageId()` 用同套字母表。
- 空页面默认值集中在 `apps/web/src/lib/constants.ts`:`emptyDoc()`、`EMPTY_HTML`、`DEFAULT_TITLE`、`normalizeTitle()`。**不要在页面 / store 里再硬编码这些字面量**。
- `PageNode.authorId` 是 free-form string(用户实际 id,或旧种子的 `'me'`)。前端渲染时若 id 不在 users 表里就显示原始字符串。
- 页面切换:`apps/web/src/App.vue` 里的 `<transition name="fade" mode="out-in">`(150ms)。
- 焦点环:仅键盘聚焦时显示(`#4C9AFF`),鼠标点击不出现。
- 图标:`material-symbols-outlined`。字体:Plus Jakarta Sans + PingFang SC 后备 + JetBrains Mono。

## 启动顺序

1. `docker compose up -d`(Postgres 5432)
2. 首次启动前确认 `apps/api/.env` 有 `ADMIN_EMAIL` + `ADMIN_PASSWORD`(首次启动用 env 建 admin,若 users 表为空却缺 env 则启动失败)
3. `pnpm dev`(同时起 web 5173 + api 8787,API 启动时会自动 `db:migrate` + `db/bootstrap.ts`,给每个无 personal space 的用户跑 `ensurePersonalSpace`)
4. 浏览器访问 `http://127.0.0.1:5173` → 自动跳 `/login` → admin 登录 → `/manager/people` 创用户 → 复制初始密码 → 隐身窗口用新用户登录(强制重置)→ 进首页

## 验收脚本

`scripts/verify_*.py` 和 `scripts/snap_*.py` 是按阶段划分的 Playwright 自动化检查(浏览器自动化基于 `playwright` Python 包)。它们假定 dev server 已经在 `127.0.0.1:5173` 上运行。改动完成后用它们验证视觉和行为基线,再汇报完成。截图统一存到 `screenshots/`(已在 `.gitignore`)。

运行需要 Python 3.13+ 和 `playwright`(`pip install playwright && playwright install chromium`)。
