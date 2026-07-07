# CLAUDE.md

给 Claude Code / AI 协作者的规约。硬约束 + 关键约定 + 命令,详情见 [docs/](./docs/README.md)。

## 项目

power-wiki — Confluence 风格团队知识库 wiki。pnpm workspaces monorepo:`apps/web`(Vue 3,5173)+ `apps/api`(Hono + Drizzle + Postgres,8787)+ `packages/shared`(types + zod)。设计基准 Atlassian "Atlas",视口 2560×1440,最小宽度 1280px — 仅桌面端。

## 硬约束

以下为用户硬性要求,在用户明确要求之前不要引入(包括隐式引入):

- **不要暗色主题。** 不写 `prefers-color-scheme`、不做主题切换、不加 dark token 覆盖。
- **不要移动端适配。** 不写 `@media` 断点。`index.html` viewport 锁死 `1280`,全局最小宽度 1280px。
- **不要图片功能。** 不接 Tiptap Image 扩展、不做 URL 粘贴、不做文件上传。工具栏和 slash 菜单里都不能出现图片项。**已废止(2026-07-06):** v1 起允许页面级附件,走 `MinIO` 对象存储(dev + prod 共用,`docker-compose.yml` 一行起)。**允许的 MIME**:`ALLOWED_MIME_TYPES` 见 `packages/shared/src/constants.ts` —— 涵盖 `image/*`、`application/pdf`、Office(doc/docx/xls/xlsx/ppt/pptx)、Markdown / 纯文本 / CSV、zip。**入口**:toolbar `插入图片 / 附件` 按钮、slash 菜单 `图片 / 附件`、粘贴图片 / 拖文件入编辑器。**外部 URL 粘贴图片仍然不做**——`sanitize.ts` 的 `img src` 协议白名单只放行 `/api/attachments/*`,挡掉 `https://`、`data:`、`blob:`、`javascript:`。全局媒体库留待 v2。**不做文件内嵌预览**——文件卡就是 `icon + 文件名 + 大小 + 下载按钮`,PDF / Word / Excel 没有缩略图、没有 iframe 预览(后端成本大、收益边际)。
- **键盘快捷键放开。** Tiptap StarterKit 默认 keymap 全开(格式 / 撤销重做 / 列表 / 引用 / 代码块等)。仅 Cmd/Ctrl+S 拦截以防浏览器「保存网页」对话框。
- **暂时不要文档协同。** Yjs / y-prosemirror / y-tiptap 依赖已装,留待未来启用。
- **Drizzle schema 不许外键约束。** 所有表不写 `.references()`,所有 `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` 类的 DDL 都不写。级联删除必须显式在路由里完成(recursive CTE 或事务清理)。写新表 / 新列也要遵守。
- **不做页面模板功能。** 不建 `page_templates` 表、不挂 `/api/templates` 路由、不做模板选择器 / 模板按钮 / 内置模板 seed。复制需求一律走页面复制(`POST /api/pages/:id/duplicate`,标题前缀 `复制自`,新页落在源页正下方同 sibling 组)。
- **Labels 双视图同步** — ReadView / EditView 内容底部都有可编辑 `<LabelPills>`,不用 `compact` prop;右 TOC 另有只读 chip 镜像。两边共享 `page.labels` reactive,主体编辑 → 右 TOC 同步更新。
- **Auto-save 永远静默,version 只在 idle / route-leave 边界自动打;不做手动「保存为版本」按钮。** `PATCH /api/pages/:id` 只更新 `pages` 行,**不**写 `page_versions`(防 auto-save 噪声)。`POST /api/pages/:id/snapshots` 是打 checkpoint 的唯一入口。Restore 端点自管 version insert。Retention 30 行。不要新增「手动保存版本」UI。
- **DB 表 / 字段必须有 SQL `COMMENT`,中文字面量。** 新建表 / 加列 / 加索引必须同时写 `apps/api/src/db/schema.ts` 同名字段上的 JSDoc **和** 对应 migration 里的 `COMMENT ON TABLE` / `COMMENT ON COLUMN` / `COMMENT ON INDEX`。Schema 上的 JSDoc 是事实来源,改一处必须同步另一处,drift 视为 bug。`pg_description` 看不到的字段 = 没写完。`drizzle-kit` 不自动生成 `COMMENT`,这是 API 协作者的责任。现有 12 张表的注释已由 `0008_add_column_comments.sql` + `0009_add_attachments.sql` 补齐,新表 / 新列默认带注释。
- **MinIO dev 端口锁死 9100/9101。** `docker-compose.yml` 显式注释了原因 —— Windows 上 9000/9001 经常被 VMware NAT / 其他服务占用,改 `.env` 的 `S3_ENDPOINT` 时**必须**用 9100(`localhost:9100`),否则附件上传会连不上。prod 端口不受这条约束。
- **Star / 收藏 toggle 不打 `page_version`。** `PATCH /api/pages/:id` 只更新 `pages.starred`,**不**写 `page_versions`(`starred` 是 metadata,不是 content)。Auto-save 静默 + snapshot 边界 30s idle 之外,任何"打 tag"类的 PATCH 都不应触发 version insert。
- **测试脚本及其产物一律放 `scripts/` 子目录,不放项目根。** 验收 / 截图 / 烟测脚本(`verify_*.py` / `snap_*.py` / `smoke-*.cjs` / `verify-phaseN.py` 等)、脚本产物(`screenshots/` / cookies / 中间 HTML / `__pycache__`)都集中在 `scripts/` 子树下,根目录保持干净。**例外**:`printscreen/` 是用户精选配图目录(供 README 引用的产品截图),**不属于测试产物**,不动;`scripts/screenshots/` 是脚本截图的归属位置,根上残留的空 `screenshots/` 历史目录直接删。
- **不主动 commit / push。** 没有用户明确指示(`提交吧` / `推吧` / `commit 一下` 之类)时,所有 `git commit` / `git push` 一律不做 —— 即使本地 typecheck 已绿、polish 类微调完毕。每个改动做完先汇报,等用户口头授权再动。**计划批准 ≠ 提交授权**:用户批准了若干任务清单(`好的` 接下来做 T1-T10)不等于授权你在执行过程里逐个 commit 上去。

## 关键约定

- ID:`apps/web/src/lib/id.ts` 的 `newId()` — `nanoid(10)`,字母表 31 字符(去掉了 0/o/1/i/l);后端 `apps/api/src/lib/ids.ts` 的 `generatePageId()` 同套。
- 空页面默认值集中在 `packages/shared/src/constants.ts`(`emptyDoc()`、`EMPTY_HTML`、`DEFAULT_TITLE`、`normalizeTitle()`、`ALLOWED_MIME_TYPES`、`MIME_TO_EXT`、`MAX_UPLOAD_BYTES_DEFAULT`)—— **事实来源**,`apps/web/src/lib/constants.ts` 只 re-export。**不要在页面 / store / 后端 route 里再硬编码这些字面量**,统一从 `@power-wiki/shared` 读。
- 设计令牌:`apps/web/src/styles/tokens.css` 是视觉唯一事实来源。**禁止**自造十六进制色值 / 间距 / 字号。
- 焦点环:仅键盘聚焦时显示(`#4C9AFF`),鼠标点击不出现。
- 图标:`material-symbols-outlined`。字体:Plus Jakarta Sans + PingFang SC 后备 + JetBrains Mono。
- 品牌:`apps/web/src/components/ui/BrandLogo.vue` 是几何 P + 书页线,**所有**品牌出现位置通过 `<BrandLogo>` 引用,**不要写 `<span>P</span>` 这种 HTML 字母**。改 logo 同步 `public/favicon.svg` 后跑 `node scripts/render-favicons.mjs` 重生成 PNG。
- DB 字段注释:`apps/api/src/db/schema.ts` 同名字段上的 JSDoc 是事实来源,改 schema 必须同步迁移里的 `COMMENT ON COLUMN`(见硬约束第 10 条)。

## 常用命令

```bash
pnpm install              # 安装依赖
docker compose up -d       # Postgres + MinIO(首次需要)
cp apps/api/.env.example apps/api/.env   # 首次需要
pnpm dev                  # 同时起 web + api
pnpm typecheck            # 递归类型检查
pnpm -F api db:generate   # Drizzle 生成迁移
pnpm -F api db:migrate    # 应用迁移(API 启动也会自动跑)
docker compose down       # 停 Postgres + MinIO(数据保留)
```

## 备份

- **Postgres**:卷 `power-wiki-pgdata` — `pg_dump` 整库或 BDR/WAL。
- **MinIO(附件对象)**:卷 `power-wiki-miniodata` — `mc mirror local/power-wiki-attachments /backup/path/`,diff 同步、可断点续传。**两端必须同步备份**:DB 行级元数据 + 对象存储字节,缺一不可 —— 只备份 DB 会留下无主的 S3 对象,只备份 MinIO 会在 DB 行引用了丢失的对象。

## 深入阅读

| 主题 | 文档 |
|---|---|
| 启动 / 路由 / 状态 / 编辑器 / Tiptap 扩展 / 阅读视图 / 持久化 | [docs/architecture.md](./docs/architecture.md) |
| 完整 API 端点契约 | [docs/api.md](./docs/api.md) |
| Schema / recursive CTE / auth / 个人空间 / admin 写保护 | [docs/data-model.md](./docs/data-model.md) |
| 数据获取 9 条 + Loading UX 6 条硬约束 | [docs/loading-ux.md](./docs/loading-ux.md) |
| verify_*.py 验收脚本使用 | [docs/verification.md](./docs/verification.md) |