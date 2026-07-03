# power-wiki

> **团队知识库 wiki** · Confluence 风格 · Atlassian Atlas 设计系统 · pnpm workspaces monorepo · 跑 `pnpm dev` 就能用。


---

## ✨ 为什么选 power-wiki

- **3 步跑起来** — `pnpm install && docker compose up -d && pnpm dev`,打开 `http://localhost:5173` 立刻看到 wiki 应用
- **本地全栈** — `apps/api`(Hono + Drizzle + Postgres)保存页面数据;`apps/web` 通过 Vite proxy 把 `/api/*` 转发到 8787,前端不用感知跨域
- **Confluence 风格** — 三栏布局(树 / 内容 / 目录),Atlassian Atlas 设计系统,5 种自定义块(callout / toggle / pageRef / dateInline / headingAnchor)
- **Tiptap 2 内核** — ProseMirror 驱动的富文本编辑,30+ 官方扩展 + 6 个自定义扩展,自动 Markdown 输入规则、键盘快捷键开箱即用
- **完整 admin 后台** — 用户 / 用户组 / 空间 / 访问控制 / 回收站,自研薄鉴权 + argon2 + DB sessions
- **XSS 防御到位** — read view HTML 走 DOMPurify 白名单,自定义 `data-*` 属性和 `time` / `details` 标签都需要显式登记

## 🎯 它能做什么

### 编辑器
- 完整富文本:H1 / H2 / H3、粗 / 斜 / 删 / 行内代码、行内链接、文字色 / 高亮色
- 列表 / 任务、表格、引用 / 分割线 / 文字对齐
- 代码块:highlight.js 语法高亮 + 语言切换 + 一键复制
- Markdown 输入规则:`## ` → H2,`**x**` → 粗体,`- ` → 列表,中文 IME 期间自动跳过
- 键盘快捷键:`Cmd/Ctrl+B / I / U / Z / Y`、`Alt+1/2/3`、`Ctrl+Alt+C`

### 自定义块(基于 Tiptap 自定义扩展)
- **Callout** — 4 种变体(info / success / warning / danger)的提示框
- **Toggle** — `<details>/<summary>` 折叠块,任意块嵌套
- **PageRef** — Notion 风格页面引用卡片,点击跳转
- **DateInline** — 行内日期节点,`now` 模式自动更新到当天
- **HeadingAnchor** — heading 自动挂 `id` 锚点,目录点击跳转

### 文档结构
- 无限层级树状页面,展开状态持久化
- 三栏布局(280px 侧边栏 / 1100px 内容 / 240px 目录)+ TOC scroll-spy

### 协作与权限
- 个人 / 共享空间:每个用户自动有 personal space,admin 可建 shared space 并按组授权
- 三态页面生命周期:正常 → 软删除(回收站)→ 恢复 / 永久删除
- 用户组批量管理空间访问权限
- 三态登录:首次登录强制重置密码

### Admin 后台(`/manager/*`)
- `/manager/people` — 用户 + 组合并页,disable / enable / 重置密码 / 加组 / 移组
- `/manager/spaces` — 空间列表 + 访问控制(整组替换 / 增 / 删)
- `/manager/trash` — 跨空间回收站,筛选 / 排序 / 批量恢复 / 永久删除

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
pnpm -F api db:migrate    # Drizzle:应用迁移(API 启动也会自动跑)
docker compose down       # 停 Postgres(数据保留在 volume 里)
docker compose down -v    # 停 + 删数据
```

## 🎨 视觉与设计

视觉风格对齐 Atlassian **Atlas** 设计系统,所有视觉细节(颜色、间距、字号、阴影)从静态原型 `design/wiki-edit.html` 和 `design/wiki-read.html` 抽取到 `apps/web/src/styles/tokens.css`。**不允许**自己发明十六进制色值 / 间距。

设计视口 **2560×1440**(24" 2K 显示器),最小宽度锁死 1280px — 仅桌面端。开发期间不要写 `@media` 断点。

**品牌识别** — 唯一资产来源 `apps/web/src/components/ui/BrandLogo.vue`(几何 P + 右侧递减透明度书页线)。所有品牌出现位置(topbar / Login 左栏 / ResetPassword 左栏 / 启动屏 / 404 页)都通过 `<BrandLogo>` 引用。

## ❌ 不做的事(设计选择)

| 选择 | 原因 |
|---|---|
| **不引入暗色主题** | 单一亮色主题保证视觉一致性 |
| **不做移动端适配** | 团队 wiki 主战场是桌面 24" 显示器 |
| **不做图片功能** | 文本优先,加载更快;文件管理走对象存储更专业 |
| **不做实时协作** | Y.js 依赖已安装,留待单用户 MVP 验证完成后再上 |
| **Drizzle schema 不许 FK** | 级联删除在路由里用 recursive CTE 显式处理 |

## 📊 功能矩阵

| 功能 | 状态 | 备注 |
|---|---|---|
| 富文本编辑 | ✓ | Tiptap 2 + 6 个自定义扩展 |
| 树状页面 | ✓ | 无限层级,展开状态持久化 |
| 全量鉴权 | ✓ | argon2id + DB sessions + HTTP-only cookie |
| Admin 后台 | ✓ | `/manager/{people,spaces,trash}` |
| 个人 / 共享空间 | ✓ | 启动时自动 ensurePersonalSpace |
| 软删除回收站 | ✓ | `/manager/trash` |
| 用户组 + 访问控制 | ✓ | |
| 设计令牌体系 | ✓ | `tokens.css` |
| 品牌资产统一 | ✓ | `<BrandLogo>` |
| 单页导出(HTML / MD / PDF) | ✓ | ReadView 操作区 |
| 页面版本历史 | ✓ | idle / route-leave 边界自动快照,inline 字符级 diff |
| 评论 / @mention / 通知 | ☐ | 未做 |
| 协作(Yjs) | ☐ | 依赖已装,留待未来 |
| 全文搜索 | ☐ | `TopSearch.vue` 只匹配 title |
| 登录限速 | ☐ | 未做 |
| 审计日志 | ☐ | 未做 |
| 暗色主题 | ✗ 故意不做 | |
| 移动端适配 | ✗ 故意不做 | |
| 图片 / 附件 | ✗ 故意不做 | |

## 📚 深入阅读

- [架构详解](./docs/architecture.md) — 路由 / 状态 / 编辑器 / Tiptap 扩展 / 持久化层
- [API 端点](./docs/api.md) — 完整契约
- [数据模型](./docs/data-model.md) — Schema / recursive CTE / auth / 个人空间
- [加载 UX 规约](./docs/loading-ux.md) — 数据获取 + Loading 体验硬约束
- [验收脚本](./docs/verification.md) — Playwright 验证流程

## 📄 License

MIT