# Changelog

所有"对用户可见"的变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **本项目版本号规则**:`0.x.y`,在 1.0.0 之前。x = 里程碑(0.1 MVP / 0.2 拆包 / 0.3 编辑器 / 0.4 鉴权+admin / 0.5 空间+回收站),y = 同一里程碑内的 bug fix。

---

## [Unreleased]

### Added
- **Stage 6: 评论 / @mention / 通知**:`comments` + `notifications` 两张表 + 5 + 4 个端点
  - **评论区**:嵌在 `ReadView` 末尾(替换原死代码 `<div class="comments">`);`/api/comments?pageId=X` 列表 + POST / PATCH / DELETE;支持二级嵌套(顶 + replies);v0 内嵌 section,v0.1 可升级右抽屉(uiStore 预留 `commentsOpen/commentsPageId` state)
  - **@mention**:Tiptap `Mention` 扩展 + Suggestion 弹层;`@` 触发,**候选人限定为该 page 所在 space 的访问组成员**(`space_group_access × user_group_members × users WHERE status='active'`,符合用户硬约束);SlashMenu 加 `mention` item
  - **Bell 通知**:TopBar `.topbar-right` 加 `<NotificationBell />`(在 `<UserMenu />` 之前);badge 红点 + 弹层前 N 条预览;30s 轮询 `unread-count`(`useNotifications` 模块级 composable + Pinia store,照 `useManagerStats` 范式);`/notifications` 顶级 view 列出全部;`/api/notifications`:`list` / `unread-count` / `mark-read` / `clear-all`,**只看自己的(`WHERE user_id=me.id`,无 admin bypass)**
  - **通知触发**:`POST /api/comments` 同一事务内调 `enqueueNotifications(tx, ...)`;三种 kind `mention` / `reply` / `comment_on_my_page`,作者与目标相同时不发;`enqueueNotifications` 是写 notifications 的唯一入口
  - **删除级联**:`DELETE /api/pages/:id?purge=true` 扩成 recursive CTE 扫 `notifications` + `comments` + `pages`(`getPageSubtree` 三表三步 transaction);`stripeMarkdown` 在写时抽 `content_text`,通知预览直接读
- **新依赖**:`@tiptap/suggestion@2.27.2`(2.x 跟现有 tiptap core 对齐)
- **新 lib**:`apps/api/src/lib/{mentionCandidates, stripMarkdown, notify, commentGuards, commentRowMappers}.ts`;`ids.ts` 加 `getPageSubtree`

### Security
- 评论 / 通知的可见性完整沿用 pages 404-not-403 策略 + `assertAdminNotWritingPersonalSpace`:admin 对 personal space 的 page 评论被拦为 `personal_space_readonly`
- mention 候选人 = 当前 page space 的访问组成员并集去重,前端 composer 再 `actor !== self` 过滤;后端 POST 在事务前 re-verify,伪造的 mention userId 会被丢弃

### Changed
- `apps/api/src/db/schema.ts`:加 `comments` + `notifications` 表 + RowTypes;`pnpm -F api db:generate` 出 `0005_cheerful_starjammers.sql`(无 FK,索引齐全)
- `packages/shared/src/schemas.ts` / `types.ts`:加 `Comment` / `Notification` / `MentionCandidate` + 4 个 Input + `MarkReadInput` + `UnreadCountResponseSchema`,类型走 `z.infer` 重导出
- `apps/web/src/lib/api.ts` 增 `api.comments.*` + `api.notifications.*` namespace
- `apps/web/src/styles/components.css` 删 `.comments` / `.comment-input` 死样式
- 修正过期文档(README / CLAUDE.md / CHANGELOG):去除文档里的旧里程碑编号,改写为"功能 + 状态"描述;token 速查表与 `tokens.css` 对齐;补全 admin / manager 章节;API 端点列表与代码 1:1

---

## [0.5.0] - 2026-06-29

### Added
- **软删除 + 回收站**:`/manager/trash` 跨空间查看 / 恢复 / 永久删除;`pages.deletedAt` / `deletedBy` 字段;`POST /api/pages/:id/restore` + `DELETE /api/pages/:id?purge=true` 端点
- **个人 / 共享空间分离**:每个用户首次登录自动建 personal space(`ensurePersonalSpace.ts` + `pg-*` 系统组);admin 建 shared space 并按用户组授权;`personalSpaceGuard.ts` 反向保护 admin 不能写 personal space
- **三态用户生命周期**:`active` / `disabled` / `must_reset_password`,admin 后台可 disable / enable / 重置密码
- **Admin 后台**:`/manager/{people,spaces,trash}` 完整 CRUD,带 context side panel 显示最近活动
- **跨用户越权防护**:不可见 space 一律返 404(防 ID 猜测,具体见 `pages.ts:18` 注释)
- **Bootstrap 流程**:首次启动自动建 admin + 默认 space + 给每个无 personal space 的用户跑 ensure

### Security
- 自研薄鉴权:argon2id + DB sessions + HTTP-only cookie(`pw_session`,`SameSite=Lax`,30 天)
- 新用户强制首次登录重置密码

---

## [0.4.0] - 2026-06-26

### Added
- **Hono + Drizzle + Postgres 后端**:`apps/api` 监听 8787,自动 migrate + bootstrap
- **共享 types + zod schemas 包**:`packages/shared`(响应出口二次校验防 schema 漂移)
- **Admin 路由**:`/api/admin/{users,groups,spaces}` CRUD + 各自的成员 / 访问管理

### Changed
- 前端从纯 localStorage 切到 API client(`apps/web/src/lib/api.ts`)
- `stores/pages.ts` 把 `readJSON/writeJSON` 换成 `await api.pages.*`
- localStorage 业务数据全部清空,只保留 2 个 key(tree-expanded + active-space)

---

## [0.3.0] - 2026-06-24

### Added
- **Tiptap 2 编辑器**:30+ 官方扩展 + 6 个自定义扩展(callout / toggle / pageRef / dateInline / headingAnchor / codeBlockView)
- **工具栏**(1231 行):undo/redo / 块类型 / 行内格式 / 列表 / 表格 / 代码块 / 对齐 / 缩进 / 链接 / 颜色 / Emoji / DateInline 4 模式 / Callout 变体
- **SlashMenu**(660 行):14 个命令,捕获 Tiptap keymap
- **BubbleMenu** + **DragHandle**(块级拖拽)
- **三栏布局**(280px / 1100px / 240px)+ Atlassian Atlas 设计令牌体系(`tokens.css` 76 个 token)
- **品牌资产统一**:BrandLogo.vue 唯一来源,所有出现位置复用
- **14 篇种子页面**:6 根 + 8 子,覆盖所有编辑器能力

---

## [0.2.0] - 2026-06-26

### Added
- **pnpm workspaces monorepo 拆包**:`apps/web` + `apps/api` + `packages/shared`,3 个 workspace
- **共享 types 与 zod schemas**(`packages/shared/src/{types,schemas,keys}.ts`)
- **`@` alias** 跨 workspace 配置,源码内 `import '@/...'` 无需改路径

### Changed
- 把原根目录 `src/` 整体平移到 `apps/web/src/`(目录搬家,源码内 import 不变)

---

## [0.1.0] - 2026-06-24

### Added
- **单页 MVP**,纯 localStorage 持久化
- **树状页面结构** + 基础富文本编辑(StarterKit 默认配置)
- **3 种自定义块**(Callout / Toggle / PageRef)的初版
- **2 个静态设计原型**:`design/wiki-edit.html` + `design/wiki-read.html`,作为视觉基线
- **14 篇种子页面**初版(后续 v0.3 强化)

### Notes
- 此版本无后端,无鉴权,无 admin;仅作为编辑器能力验证的演示基线

---

[Unreleased]: ../../compare/main...HEAD
[0.5.0]: ../../compare/v0.4.0...v0.5.0
[0.4.0]: ../../compare/v0.3.0...v0.4.0
[0.3.0]: ../../compare/v0.2.0...v0.3.0
[0.2.0]: ../../compare/v0.1.0...v0.2.0
[0.1.0]: ../../tree/v0.1.0
