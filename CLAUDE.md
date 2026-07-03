# CLAUDE.md

给 Claude Code / AI 协作者的规约。硬约束 + 关键约定 + 命令,详情见 [docs/](./docs/README.md)。

## 项目

power-wiki — Confluence 风格团队知识库 wiki。pnpm workspaces monorepo:`apps/web`(Vue 3,5173)+ `apps/api`(Hono + Drizzle + Postgres,8787)+ `packages/shared`(types + zod)。设计基准 Atlassian "Atlas",视口 2560×1440,最小宽度 1280px — 仅桌面端。

## 硬约束

以下为用户硬性要求,在用户明确要求之前不要引入(包括隐式引入):

- **不要暗色主题。** 不写 `prefers-color-scheme`、不做主题切换、不加 dark token 覆盖。
- **不要移动端适配。** 不写 `@media` 断点。`index.html` viewport 锁死 `1280`,全局最小宽度 1280px。
- **不要图片功能。** 不接 Tiptap Image 扩展、不做 URL 粘贴、不做文件上传。工具栏和 slash 菜单里都不能出现图片项。
- **键盘快捷键放开。** Tiptap StarterKit 默认 keymap 全开(格式 / 撤销重做 / 列表 / 引用 / 代码块等)。仅 Cmd/Ctrl+S 拦截以防浏览器「保存网页」对话框。
- **暂时不要文档协同。** Yjs / y-prosemirror / y-tiptap 依赖已装,留待未来启用。
- **Drizzle schema 不许外键约束。** 所有表不写 `.references()`,所有 `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` 类的 DDL 都不写。级联删除必须显式在路由里完成(recursive CTE 或事务清理)。写新表 / 新列也要遵守。
- **不做页面模板功能。** 不建 `page_templates` 表、不挂 `/api/templates` 路由、不做模板选择器 / 模板按钮 / 内置模板 seed。复制需求一律走页面复制(`POST /api/pages/:id/duplicate`,标题前缀 `复制自`,新页落在源页正下方同 sibling 组)。
- **Labels 双视图同步** — ReadView / EditView 内容底部都有可编辑 `<LabelPills>`,不用 `compact` prop;右 TOC 另有只读 chip 镜像。两边共享 `page.labels` reactive,主体编辑 → 右 TOC 同步更新。
- **Auto-save 永远静默,version 只在 idle / route-leave 边界自动打;不做手动「保存为版本」按钮。** `PATCH /api/pages/:id` 只更新 `pages` 行,**不**写 `page_versions`(防 auto-save 噪声)。`POST /api/pages/:id/snapshots` 是打 checkpoint 的唯一入口。Restore 端点自管 version insert。Retention 30 行。不要新增「手动保存版本」UI。

## 关键约定

- ID:`apps/web/src/lib/id.ts` 的 `newId()` — `nanoid(10)`,字母表 31 字符(去掉了 0/o/1/i/l);后端 `apps/api/src/lib/ids.ts` 的 `generatePageId()` 同套。
- 空页面默认值集中在 `apps/web/src/lib/constants.ts`:`emptyDoc()`、`EMPTY_HTML`、`DEFAULT_TITLE`、`normalizeTitle()`。**不要在页面 / store 里再硬编码这些字面量**。
- 设计令牌:`apps/web/src/styles/tokens.css` 是视觉唯一事实来源。**禁止**自造十六进制色值 / 间距 / 字号。
- 焦点环:仅键盘聚焦时显示(`#4C9AFF`),鼠标点击不出现。
- 图标:`material-symbols-outlined`。字体:Plus Jakarta Sans + PingFang SC 后备 + JetBrains Mono。
- 品牌:`apps/web/src/components/ui/BrandLogo.vue` 是几何 P + 书页线,**所有**品牌出现位置通过 `<BrandLogo>` 引用,**不要写 `<span>P</span>` 这种 HTML 字母**。改 logo 同步 `public/favicon.svg` 后跑 `node scripts/render-favicons.mjs` 重生成 PNG。

## 常用命令

```bash
pnpm install              # 安装依赖
docker compose up -d       # Postgres(首次需要)
cp apps/api/.env.example apps/api/.env   # 首次需要
pnpm dev                  # 同时起 web + api
pnpm typecheck            # 递归类型检查
pnpm -F api db:generate   # Drizzle 生成迁移
pnpm -F api db:migrate    # 应用迁移(API 启动也会自动跑)
docker compose down       # 停 Postgres(数据保留)
```

## 深入阅读

| 主题 | 文档 |
|---|---|
| 启动 / 路由 / 状态 / 编辑器 / Tiptap 扩展 / 阅读视图 / 持久化 | [docs/architecture.md](./docs/architecture.md) |
| 完整 API 端点契约 | [docs/api.md](./docs/api.md) |
| Schema / recursive CTE / auth / 个人空间 / admin 写保护 | [docs/data-model.md](./docs/data-model.md) |
| 数据获取 9 条 + Loading UX 6 条硬约束 | [docs/loading-ux.md](./docs/loading-ux.md) |
| verify_*.py 验收脚本使用 | [docs/verification.md](./docs/verification.md) |