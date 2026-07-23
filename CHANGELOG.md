# Changelog

所有"对用户可见"的变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **本项目版本号规则**:`0.x.y`,在 1.0.0 之前。x = 里程碑(0.1 MVP / 0.2 拆包 / 0.3 编辑器 / 0.4 鉴权+admin / 0.5 空间+回收站),y = 同一里程碑内的 bug fix。

---

## [Unreleased]

### Added
- **Phase A — 空间角色授予**:`space_role_grants` 表(migration `0024_phase_a_space_role_grants.sql`,legacy `space_group_access` 行由 `migrateLegacyGroupGrant` 在新写入同事务迁入 role='editor' 后 DELETE,`/api/admin/spaces/:id/access` `@deprecated` 保留作 rollback);`GET / PUT / POST(单行 UPSERT) / DELETE /api/spaces/:id/permissions`(子路由 `routes/spacePermissions.ts`);`viewer | editor | admin` 三档,**admin 仅可授 user 不可授 group**(后端 `assertNotAdminToGroup` 强校验)且**最后一个 user-grant space-admin 不能被删** → 409 `cannot_remove_last_admin`;role_to_group / cannot_remove_last_admin 错误码;`apps/api/src/lib/accessibleSpaceIds.ts` 重写为 effective role 查询(`UNION ALL` legacy 行视为 'editor');`SpaceEditView.vue` + `SpacesView.vue` + `accessibleSpaceIds.ts` 全文切换;`packages/shared/src/schemas.ts` 加 `SpaceNode.accessGrants`(DTO 后端 `LEFT JOIN + GROUP BY` 算好)
- **Phase B — 页面级 view / edit 限制**:`page_restrictions` 表(migration `0026_phase_b_page_restrictions.sql`)+ `GET / PUT / POST(单行 UPSERT) / DELETE /api/pages/:id/restrictions` 子路由(`routes/pageRestrictions.ts`);**反 default-deny**,`view` 限制 **BFS 父链继承**(任一祖先生效 → 子页受限),`edit` 限制 **不继承**(只约束本页);`canReadPage` / `canEditPage` 顶头短路 = 作者本人 + global admin,不走 allow-list;`canManageRestrictions = author | space-admin | global admin | space-editor` 四选一;`view` 限制 + 公开分享互斥 —— POST share 遇 view 限制 → 400 `share_forbidden`;`PageRestrictionsDialog.vue` 接到 `PageHeader`,前后端权限矩阵对齐
- **Phase C — append-only 权限审计**:`permission_audit` 表(migration `0027_phase_c_permission_audit.sql` + `0029_extend_audit_kinds.sql` 扩 CHECK),**11 kind × 5 target_kind** 枚举拍死;8 个权限变更(`space_grant_set / _add / _remove` / `page_restriction_set / _add / _remove` / `page_share_create / _revoke`)+ 3 个资源生命周期(`space_deleted / group_deleted / user_anonymized`,0029 合并);`recordPermissionAudit(tx, entry)` 是 INSERT 唯一入口,**必须在 `db.transaction()` 内调用**(transaction 外允许写会 pre-/post-commit 错位);`GET /api/admin/audit?kind=&actorId=&targetKind=&targetId=&from=&to=&limit=&offset=` 按 `created_at DESC` 分页;`AuditView.vue` 由 4-列表格改 **单行活动流**(grid `32px / auto / minmax(0,1fr) / auto / 20px`,默认行高 ~56px),行内容 = 头像 + actor + `auditSummary` 自然语言主句 + 相对时间 + chevron,**互斥展开**(`expandedEntryId` 单值 ref),raw JSON 走二级按钮 + `rawOpenId` ref;target chip / 字段 before→after 网格 / `prefers-reduced-motion` 0ms 短动画
- **Phase D — 公开链接分享**:`page_public_shares` 表(migration `0028_phase_d_page_public_shares.sql`),`tokenHash = sha256(token) hex` UNIQUE,**明文 token 仅在 `POST /api/pages/:id/share` 创建响应里一次性出现**(丢失即失效,只能 revoke 重发);`{expiresInDays: 7|30|90|null}`,`null = 永不过期`;创建校验链:**shared space + 无 view 限制 + page 未 trashed**(personal space 或 view 限制存在 → 400 `share_forbidden`);`GET /api/pages/:id/shares` 列表 + `DELETE /:id/share/:shareId`(已 revoke → 400 `share_already_revoked`;**不**做 cascade,page purge 才扫 shares);匿名 `GET /api/public/pages/:token` 在 `app.use('/api/*', requireAuth)` **之前**挂载(`routes/publicShares.ts`),校验链:sha256 命中 + `revokedAt IS NULL` + (`expiresAt IS NULL OR > now`) + page `deletedAt IS NULL` + `spaces.kind='shared'`;任一失败 → 404 + `Cache-Control: public, max-age=60`;命中后 fire-and-forget 更新 `lastAccessedAt`;`ShareDialog.vue`(明文 banner + revoke list)接进 `PageHeader`,`PublicPageView.vue` 顶级 view 匿名只读(`/p/:id` 同主题但无 chrome)
- **M11 — 用户自定义头像上传**:`user_avatars` 表(migration 0022,**独立表** —— 不挂 pageId、不复用 `attachments` 共 MinIO 桶 `S3_BUCKET` 同 bucket 但不挂 page 语义);`POST /api/user-avatars/upload-url` + `POST /finalize`(HeadObject 校验真实 size)+ `GET /:userId/raw`(**公开 stream**,跟 username 同级对外可见,`Cache-Control: private, max-age=300`);MIME 子集 `AVATAR_ALLOWED_MIME = png/jpeg/webp/gif`(无 svg/avif,缩小子集减小攻击面 + 保证 canvas 压图后所有浏览器能渲染),≤5MB,客户端 canvas 压到 256px;`finalize` 后 `cleanupUserAvatars(userId)` 保留最新一行,删余 + best-effort S3(`PATCH /me` 切到 preset/null 时同步清当前 ref 行 + S3 对象);`users.avatarKind` 三态(NULL / 'preset' / 'custom') + `users.avatar_ref` 同步,由 0022 migration 加 CHECK 拍死;`SettingsDrawer.vue` + `UserAvatar.vue` + `SearchDialogUserLink.vue` 全部接入(预制头像走 `/avatars/{slug}.svg` 静态)
- **文档**:`docs/api.md` 扩为 21 个 route mount(`app.route` 23 次调用)含 Phase A/B/C/D 子路由表 + 新错误码(`admin_role_to_group` / `cannot_remove_last_admin` / `page_restricted` / `view_restricted` / `share_forbidden` / `share_already_revoked` / `share_invalid` / `share_revoked` / `share_expired` / `personal_space_cannot_delete` / `space_not_empty` / `last_admin` / `self_anonymize` 13 条);`docs/data-model.md` 21 张表 Schema + 5 张新表字段块(`user_avatars` / `space_role_grants` / `page_restrictions` / `page_public_shares` / `permission_audit`)+ 级联 SQL 增 `page_public_shares` + `page_restrictions` 两条 + 索引表补全 13 条;`docs/permissions.md`(**新**)权限矩阵(6 种身份 × 25 项能力)+ 角色定义 + 3 个易踩不对称 + 页面限制继承规则 + 公开分享校验链 + UI 入口 gate 表 + 半篇 ER 图 + 8 边界场景 FAQ;`docs/README.md` 索引表同步
- **页面复制**:`POST /api/pages/:id/duplicate` —— 同空间同父的新页紧跟源页之后(sibling group 内 insert-after-source),内容(title / icon / contentJSON / contentHTML)逐字复制,starred / labels / soft-delete 不继承;title 前缀 `复制自`(用户字面要求);admin 写他人 personal space 仍 403;前端 `<LabelPills>` 右栏不变,补 PageTree 菜单「复制页面」项 + ReadView 操作栏「复制」按钮
- **历史 checkpoint 边界触发**:`POST /api/pages/:id/snapshots` ——「自动打版本」替代每 PATCH 写一行历史;EditView 30s idle(`IDLE_SNAPSHOT_MS = 30_000`)+ route leave 末段自动打 boundary snapshot;Restore 端点照旧自管 version insert(`changeNote = "restored from v{N}"`);Retention 30 行复用 `pageVersions.ts` 的 `RETENTION`
- **共享常量** `packages/shared/src/constants.ts`:`DEFAULT_TITLE = '无标题页面'`,前后端 createPage 默认 title 同源,避免历史上后端 `''` 默认值漂移导致的 schema `min(1)` 拒收

### Fixed
- **空标题脏数据 backfill**:4 行 commit b2e0605 种出来的 live page(`title IS NULL OR title = ''`)批量 UPDATE 为 `未命名`,清空 GET /api/pages 的 ZodError 噪声
- **历史记录噪声根因**:移除 `PATCH /api/pages/:id` 里每个 content-mutating PATCH 自动写 `page_versions` 的逻辑;auto-save 永远静默,version 只在 idle / route leave 边界打(跟 Notion / Google Docs / Figma 一致)
- **创建页面失败 `标题不能为空`**:Backend `apps/api/src/routes/pages.ts:269` 用 `input.title ?? DEFAULT_TITLE` 替换 `input.title ?? ''`;Frontend `apps/web/src/stores/pages.ts` `createPage` 永远在 API payload 里带 `title`,不再 `...(opts.title !== undefined ? { title } : {})` 省略
- **标签添加 Enter 无反应**:`LabelAddPopover.vue:112` 的 `@keydown.stop` 把所有按键(包括 Enter)冒泡终止,document 监听器收不到事件 → 删该修饰符,Enter 走 `submit()` 创建;Esc 仍由 document 监听器关闭
- **标签位置从顶部 H1 上挪到右 TocPanel 「页面关注者」之上**:ReadView / EditView 主体底部仍保留可编辑 `<LabelPills>`(用户可在阅读时打标签);右 TOC 加 read-only chip 镜像区(同名同源 `page.labels` reactive),同步双向更新。标签样式重做按 `design/wiki-read.html` line 418 风格:左侧 `sell` icon + chips(bg-subtle / text-2 / weight 600 / 12px / 2px 6px / 3px radius)+ 文字按钮「添加标签 / 编辑标签」(accent 蓝),去掉 dashed `+` chip + 常驻 `×` 移除按钮(改为 hover 才显形)
- **发布按钮的 boundary snapshot bug**:`flushPendingSave` 早返条件从 `if (!isDirty.value) return` 改成 `if (!isDirty.value && !hasUnsnapshottedEdits.value) return` —— publish 路径下 `persistNow` 已经清掉 `isDirty` 但 `hasUnsnapshottedEdits` 是 true,旧逻辑提前 return 导致 boundary snapshot 走不到
- **删除「保存草稿」按钮**(`EditView.vue`):跟 auto-save 行为完全重复(`persistNow` 走同一条 PATCH 路径),「草稿」语义在 wiki 上下文里错位(没有 draft 状态),主流编辑器(Notion / GDocs / Confluence)均不提供;footer 只剩 meta + 字数统计
- **VersionPanel 打开即刷新**:`usePageVersions.refresh(pageId)` 强清缓存重拉,确保看到最新边界快照(用户在别的标签页 / 同事刚写的版本);列表为空时仍走 skeleton
- **VersionDiffView 简化**:不再 2-列 side-by-side 矩阵(空 unchanged-run 产空白行丑);改单列 unified diff:空态「当前版本与 v{N} 内容一致」;有变化时显示 summary(−N 行 / +N 行)+ 顺序行的 `− / +` 列表(strikethrough 红 / 绿);long unchanged-run 不再展开,折叠到自然跳过
- **VersionPanel 样式重做**:从「v1 LE 刚刚 ▾」五列 grid + 「当前版本 | V1 · 测试一下历史快照」表头感 → 「头像 + 信息(版本号 + 作者 + 时间 / 当前版本 tag + 自动/恢复 note)+ caret」卡片布局,空态 / hover / active / current-tag 状态清晰

### Removed
- **页面模板功能(commit b2e0605 中未验证的整块)** —— 删 5 个文件 + 11 个混合文件模板片段:
  - D `apps/api/src/auth/seedBuiltInTemplates.ts`(422 行)
  - D `apps/api/src/routes/pageTemplates.ts`(228 行)
  - D `apps/web/src/components/page/TemplatePickerDialog.vue`(253 行)
  - D `apps/web/src/components/page/TemplatePickerTrigger.vue`(162 行)
  - D `apps/web/src/composables/useTemplates.ts`(97 行)
  - `apps/api/src/db/schema.ts`:删 `pageTemplates` pgTable + 2 个 RowType
  - `apps/api/src/db/migrations/0006`:删 `page_templates` CREATE TABLE + index
  - `apps/api/src/auth/bootstrap.ts`:删 stage-6 seed 调用 + `builtInTemplatesSeeded` 字段
  - `apps/api/src/index.ts`:卸 `/api/templates` 路由挂载
  - `apps/api/src/routes/adminSpaces.ts`:恢复 `pages` import + 删 `tx.delete(pageTemplates)` 段
  - `apps/web/src/lib/api.ts`:删 `templates.{list,create,delete}` 块 + 3 个 import
  - `apps/web/src/stores/auth.ts`:删 `useTemplates().invalidate()` 调用
  - `apps/web/src/components/layout/Sidebar.vue`:模板选择器整段拆掉,按钮还原 `<button class="create-page-btn">`
  - `packages/shared/src/schemas.ts`:删 `PageTemplateSchema` + `CreateTemplateInputSchema` + 两条 type + 注释里指向已删 schema 的引用
  - `packages/shared/src/types.ts`:删 PageTemplate / CreateTemplateInput re-export

### CLAUDE.md 硬约束新增
- **不做页面模板功能。** 不建 `page_templates` 表、不挂 `/api/templates` 路由、不做模板选择器 / 模板按钮 / 内置模板 seed。复制需求一律走页面复制(`POST /api/pages/:id/duplicate`,title 前缀 `复制自`,新页落在源页正下方同 sibling 组)。
- **Labels：ReadView / EditView 内容底部都有可编辑 `<LabelPills>`；右 TOC 另有只读 chip 镜像展示。** ReadView 在 `.read-content` 之后、`.subpages` / `.reactions` / `CommentsSection` 之前;EditView 在 `RichEditor` 之后、`.edit-footer` 之前。两边始终同步(同一份 reactive `page.labels`)。
- **Auto-save 永远静默,version 只在 idle / route-leave 边界自动打;不做手动「保存为版本」按钮。** `PATCH /api/pages/:id` 只更新 `pages` 行,**不**写 `page_versions`。`POST /api/pages/:id/snapshots` 是打 checkpoint 的唯一入口(前端 EditView 30s idle timer + `flushPendingSave` 末尾各调一次)。Restore 端点自管 version insert。Retention 30 行复用 `apps/api/src/routes/pageVersions.ts` 的 `RETENTION`。

---

## [0.6.0] - 2026-07-07

Stage 8: 附件 / 懒加载 / 搜索 / 历史页 / 性能。覆盖 8 个 commit(`13d908d` / `ce9c77a` / `ce99d05` / `4a57454` / `61a3367` / `1667145` / `f9c1a19` / `6a747e1`)。

### Added
- **页面级附件(Stage 8 主线)** — S3 直传 + DB 元数据:`POST /api/attachments/upload-url` + `POST /finalize` 两步上传(浏览器 `PUT` 到 presigned URL,字节不经过 API),`GET /:id/raw` 流式下载(image `inline` / file `attachment`);`attachments` 表(migration `0009_add_attachments.sql`,带 `COMMENT ON`)+ `imageAttachmentExtension`(Tiptap 节点)+ `ImageAttachmentView`(inline image / file 卡片)+ `AttachmentLightbox`(全屏查看);S3 走 `apps/api/src/lib/s3.ts`,`@aws-sdk/client-s3` 入依赖;`packages/shared/src/constants.ts` 加 `ALLOWED_MIME_TYPES` / `MIME_TO_EXT` / `MAX_UPLOAD_BYTES_DEFAULT`;`docker-compose.yml` 起 minio,主机端口锁 `9100/9101`(避 Windows 9000 占用)。`sanitize.ts` 的 img src 白名单只放行 `/api/attachments/*`,挡 `https://` / `data:` / `blob:` / `javascript:`。
- **侧栏懒加载** — `PageTree` 首次只拉根级,`expand` 节点时再 `GET /api/pages?parentId=X` 拉子页;`pages.ts` 加 `getPageChildren` 端点,PageTree 缓存 children by parentId,避免 N+1。
- **Confluence 三栏宽度可拖** — `Sidebar` / `TocPanel` 手柄持久化(本地存储),刷新保留。
- **打开子页自动展开定位** — `pagesStore.setActive` 后,PageTree 找到该页路径所有 ancestor → 全部 `expand`,然后 `scrollIntoView` 滚到节点 + 高亮闪一下。
- **零中间件全文搜索** — `GET /api/search?q=...` 直走 Drizzle `ILIKE` over `pages.title` + `pages.content_text`,LIKE 通配符 escape,无 ES / 无 Redis;`TopSearch.vue` debounce 200ms + 键盘 `↑↓ Enter Esc` + 跨 space 结果分组 + 命中高亮。
- **Admin personal-space 写拦截硬约束** — `SpaceEditView` 等管理 UI 显式提示 "admin 不可写 personal space",`personalSpaceGuard` 在 `assertAdminNotWritingPersonalSpace` 抛 `personal_space_readonly`。
- **DB 列注释硬约束** — migration `0008_add_column_comments.sql` 给所有 `pages` / `comments` / `notifications` / `page_versions` / `users` / `spaces` / `groups` / `sessions` 列加 `COMMENT ON COLUMN`,`pgmeta` / `pg_dump` 出来自带文档;CLAUDE.md 加硬约束一条。
- **历史页全屏化** — `HistoryView.vue` 从弹层改为独立 `/p/:id/history` 顶级路由,左右双栏(版本列表 + diff 视图);`VersionList` 改组件卡。
- **inline 字符级 diff** — `apps/web/src/lib/textDiff.ts` 自研 `diffChars`(LCS + 字符对齐),`VersionDiffView` 弃用 side-by-side 矩阵,改单行内 `−` 红 / `+` 绿 inline 渲染 + 行级 fallback。
- **页面级附件 + 替换/布局/防误触** — `App.vue` 全局 `beforeunload` 拦截未保存编辑;MarkdownSerializer 加 image serializer;sanitize 文件名。
- **MinIO 主机端口锁 9100/9101** — `docker-compose.yml` 显式注释原因(Windows 上 9000 经常被 VMware NAT 占用),`.env` 的 `S3_ENDPOINT` 必须用 9100。

### Changed
- **折叠块 read 模式默认收起** — `ReadView.vue` `safeHtml` 在 `sanitizeAndHardenLinks` 之后再走 `collapseTogglesByDefault`,strip 所有 `<details open>`;与 Confluence 行为对齐。用户点 summary 仍可展开,刷新回到 collapsed。
- **小标题可输入表情** — `EmojiPicker` 接受 `target` prop,toolbar 表情按钮 mousedown 时捕获 `activeElement`(`<input>` / `<textarea>`),picker 命中后走原生选区 API 插入 + dispatch `input` 事件;退化链 target → `document.activeElement` → ProseMirror,评论框等也一并生效。
- **comments 双行布局回退** — `CommentItem.vue` 改双行:第一行 username · time · edited,第二行文本,头像保留;长 URL `overflow-wrap: anywhere`。
- **Star / Recent / Search UX 收尾** — `Sidebar` 顶区重排,空态插画 + 引导文案;`stores/recent` 加去重 + 时间衰减;`TopSearch` 加搜索框 + 跨 space 分组。
- **PDF 导出走 `window.print()` + `print.css`** — `print.css` `@page A4` + `@media print` 隐藏 chrome;h1 自动 `page-break-before`(首例外);`pre/callout/toggle/table` 避免内部跨页;`a[href]::after` 打印 href。

### Fixed
- **`1667145` admin 冷启动并发 `PATCH /api/pages/:id` storm** — bootstrap 路径加幂等去重;`personalSpaceGuard` 在写路径必走。
- **`61a3367` 清 b2e0605 残留** — `page_templates` 表已 drop(migration `0007_drop_page_templates.sql`),`apps/api/src/routes/pageTemplates.ts` 删除,`TemplatePickerDialog` / `TemplatePickerTrigger` 组件 + `useTemplates` composable 整块拆;labels / history / version 同步修复。
- **`4a57454` `textDiff` 空 unchanged-run 不再产空行** — VersionList skeleton 占位,空态统一显示「当前版本与 v{N} 内容一致」。
- **`f9c1a19` perf memo** — `/api/pages` 列表分页 `limit/offset`,Pinia store `markStale` 模式,PageTree 懒加载不重复拉。
- **`ce9c77a` 拖拽时 N+1 复拉** — `PageTree` 拖拽时不再重新拉 children,共享 module-scope `childrenByParent` 缓存。
- **`6a747e1` 折叠块小标题无法输入表情** — EmojiPicker 走原生选区 API(见 Changed)。

### CLAUDE.md 硬约束新增
- **MinIO dev 端口锁死 9100/9101** — 改 `.env` 的 `S3_ENDPOINT` 必须用 9100,Windows 上 9000 经常被占。
- **Star / 收藏 toggle 不打 `page_version`** — `PATCH /:id` 只更新 `pages.starred`,**不**写 `page_versions`(metadata,不是 content)。
- **DB 表 / 字段必须有 SQL `COMMENT`(已升级到 12 张表)** — `0008_add_column_comments.sql` + `0009_add_attachments.sql` 补齐,新表 / 新列默认带注释。

---

## [Unreleased-prior]

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
- **评论区 UX 三连修**:
  - 去列表圆形头像(垂直间距省一半,Username-only 行);composer 保留
  - `CommentsSection.vue` 加 `watch(props.pageId)`:切页时清空 `items` 并重 fetch,避免上一页评论带过来
  - `回复` / `删除` 直接图标(`reply` / `delete`,`material-symbols-outlined`),kebab menu + onClickOutside 模式整体废弃 — 旧菜单"很难收回"就是因为没有 dismiss 监听
- **@mention 弹层换皮肤 + 搜索框**(`MentionList.vue` + `mentionExtension.ts`):
  - Tippy 加自定义 `theme: 'pw-mention'` + `arrow: false` 干掉默认 `light-border` 的硬黑边;卡片用 `--bg` / `--border` / `--shadow-lg` 重做,8px 圆角 + 浅灰边 + 蓝色 soft focus 环
  - 弹层顶部加 `<input class="mention-search">` 配 `search` 图标 + `progress_activity` 加载 spinner,`open()` 时 `requestAnimationFrame` 自动 focus,预填 Tiptap 给的 `props.query`
  - 150ms debounce 调 `api.comments.mentionCandidates(pageId, q)`,`fetchSeq` 丢弃过期响应
  - 弹层内的 `↑/↓/Enter/Esc` 由 input 的 `onkeydown` 自处理(编辑器 keymap 不冒泡到 popover 节点)
  - 底部 footer 三个 kbd 提示(`↑↓ 选择 / Enter 选中 / Esc 关闭`);`hideOnClick: true` — 点回编辑器自动关
  - 候选缓存(`candidatesRef`)+ `pageIdRef` + `fetchCandidates` 提到 module-scope,`items` 改返缓存(首次空时 await 一次填充);`@query` 文档文本只在选中时由 Suggestion `command` 替掉,搜索框内打字不动文档
- **ReadView TOC 不再带 `#` 前缀**(`TocPanel.vue`):
  - 根因:`headingAnchors.ts` 给每个 `h2/h3` 前注的 `<a class="heading-anchor">#</a>` 复制链接被 `el.textContent` 读走,变成 TOC 行首的 `#`
  - 修法:跟 `ReadView.vue:152` 对齐,clone 节点 + 删 `a.heading-anchor` 再读 `textContent`;编辑模式本来走 `.heading-content` 选择器,不受影响
- **登出空闪屏修掉**(`App.vue` + `UserMenu.vue`):
  - 根因:登录时 `transitioning` 罩被 `showBoot = authInitialising || (isAuthed && transitioning)` 双重门住;登出时 `isAuthed` 变 false,罩出不来,中间会经过"authed shell 卸载 + RouterView 渲染一个空 HomeView"的空白帧
  - `showBoot` 改成 `authInitialising || authStore.transitioning`,`isAuthed` 守卫去掉 — 进出方向同一根管
  - `UserMenu.onLogout` 跟 `LoginView.onSubmit` 对称:`transitioning = true` → `await logout()` → `await router.replace({ name: 'login' })` → 80ms 尾延迟 → `finally { transitioning = false }`
- 修正过期文档(README / CLAUDE.md / CHANGELOG):去除文档里的旧里程碑编号,改写为"功能 + 状态"描述;token 速查表与 `tokens.css` 对齐;补全 admin / manager 章节;API 端点列表与代码 1:1

### Stage 7: 个人空间"发布到" + 编辑器 + 树拖拽 + 任务列表对齐
- **个人空间"发布到"**(原"移动到"语义改写):
  - 全新 `POST /api/pages/:id/publish` 端点:源页必须 `space.kind === 'personal' && space.ownerId === me.id`,目标只能是 team space 且 ≠ 源 space;新页标题自动加 `（来自 {userName} 的个人分享）` 后缀(已带后缀则不重复);保留原页不动
  - 新组件 `PublishToSpaceMenu.vue`(替换 `MoveToSpaceMenu.vue`):"发布到团队空间"popover,目标列表 = `spaces.filter(s => s.kind !== 'personal' && s.id !== sourceSpaceId)`;成功后切到目标 space 并跳到新副本
  - `PageTree.vue` ⋯ 菜单项重命名 `移动到...` → `发布到...`(icon 也换 `publish`);`canPublish` 计算属性按上述规则过滤可见性
  - `packages/shared` 加 `PublishPageInputSchema`;`apps/web/src/lib/api.ts` + `stores/pages.ts` 加 `publishPageToSpace`(乐观更新,失败回滚 + banner)
- **通知中心从独立 view 收进 bell 弹层**:
  - 删 `NotificationsView.vue`(`/notifications` 路由同步移除);`NotificationBell.vue` 扩成"前 N 条 + 全部已读 + 跳转"全功能下拉
- **编辑器右侧 TOC 锚定**:
  - `TocPanel.vue` 加 `MutationObserver + rAF` 跟 live DOM,匹配 `h1/h2/h3` + `.heading-wrapper[data-level]` 两套结构;edit / read 双视图统一
  - `EditView.vue` 把 `TocPanel` 嵌进三栏布局(原 `no-toc` 类移除);通过 `content-mount` 事件 + `requestAnimationFrame` 抓 ProseMirror 容器
- **编辑器修缮**:
  - H2 颜色在 edit 模式不再因 onBeforeUnmount 清 timer 而丢(改 `onBeforeRouteLeave` 触发 `flushPendingSave`);`ReadView.vue` byline 由 `createdAt` 改为 `updatedAt`,`EditView` 顶部 byline 同改
  - **代码块 / Toggle 块易删**:`CodeBlockView.vue` + `ToggleView.vue` 在容器边缘加 hover 浮起的删除按钮,`setNodeSelection` + `deleteSelection` 模式,直接点 X 即删;`RichEditor` 转发 `content-mount` 事件给父组件
  - **SlashMenu**:`mention` / `date` 两条目扩出 picker 弹层(emoji / 日期);键盘导航 + Enter / Esc 完备
- **页面树拖拽排序**:
  - `PageTree.vue` `dragState` 从 per-instance ref 改为 module-scope `reactive()`,所有 `PageTree` 实例共享 `draggingId` / `dropTarget`;HTML5 drag API 落点提示 `drop-before` / `drop-after`(上下半区分),cycle 由 `pagesStore.movePage` 拦截
  - `Sidebar` / `PageTree` 收尾
- **自研 confirm 弹窗替换浏览器 confirm**:
  - `apps/web/src/composables/useConfirm.ts`:Promise-based,挂 `<Teleport to="body">` 的 `<ConfirmDialog>`;`danger` / `confirmText` / `cancelText` 可配
  - `CommentItem.vue` 删除评论从 `confirm('...')` 切到 `await confirm({...})` 走自研弹窗;`PageTree.vue` 删页同步替换
- **任务列表 checkbox / 文字对齐**:
  - `components.css` 改 `align-items: flex-start` + 固定 `1.6em` 居中为 `align-items: baseline`(checkbox 底部 = 文字基线);`<p>` 顶 margin 清零;`vertical-align: middle` 兜底。实测 edit / read 两视图 checkbox 中心 ↔ 文字 glyph 中心 delta = 0px(Range API 测)
- **HomeView 修正文案**:"本地存储 / 浏览器 localStorage" → "云端存储 / 存储备份",跟 0.4 切到 API 后的现状对齐

### 单页导出 + 评论单行布局

**单页导出(HTML / Markdown / PDF)** — ReadView 操作区新增"导出"按钮:
- 新组件 `apps/web/src/components/editor/ExportMenu.vue`:`.btn` 浅灰底 + `ios_share` 16px 图标,沿用 `UserMenu.vue` 的容器锚定 popover pattern(容器内 `position:absolute` + document mousedown outside-click + Esc 关闭);导出 in-flight `disabled` + `progress_activity` spinner 防连点;失败时 inline error 标红;文件名走 `sanitizeFilename`(剔除 `/\\:*?"<>|` + 控制字符,80 字符截断)
- 新 lib `apps/web/src/lib/exportPage.ts`:三格式 orchestrator + `triggerDownload` + `buildStandaloneHtmlDoc` + `MINIMAL_PROSE_CSS`(独立 HTML 文档,不泄漏内部变量,内联 highlight.js 高亮后的代码块)
- 新 lib `apps/web/src/lib/markdownSerializer.ts`:单例隐藏 Tiptap editor(`document.createElement('div')` detached,SSR safe)+ 5 个自定义 serializer(`callout` → GitHub 标准 `> [!NOTE/TIP/WARNING/CAUTION]`;`toggle` → 原生 `<details>`;`pageRef` → `[Title](#/p/{id})`;`dateInline` → ISO `YYYY-MM-DD`;`mention` → `@{label}`);`Markdown` 扩展的 `setContent` 会把 Tiptap JSON `.toString()` 化,绕过方法是 dispatch 原始 ProseMirror `tr.replaceWith`
- 新增依赖 `tiptap-markdown@0.8.10`(Tiptap 2.x 最后一版兼容;0.9+ 要 Tiptap 3) ;`@tiptap/extension-markdown` alias 由该包提供
- 新样式 `apps/web/src/styles/print.css`:`@page A4` + `@media print` 隐藏 topbar/sidebar/TOC/page-actions/comments 等 chrome;h1 自动 `page-break-before`(首例外);`pre/callout/toggle/table` 避免内部跨页;`a[href]::after` 打印 href,代码块 / callout `print-color-adjust: exact` 背景保真
- `ReadView.vue` 把 `<ExportMenu>` 接到 `.page-actions` 编辑按钮前;`main.ts` 增 `import './styles/print.css'`;`package.json` + `pnpm-lock.yaml` 同步
- 非范围:`HomeView.vue:113-121` 的 disabled "导入/导出" 按钮保持原样(单页范围下 HomeView 无"导哪页"语义);批量导出 / 导入不在这期

**评论列表单行布局**(`apps/web/src/components/comments/CommentItem.vue`):
- 行内全部塞一行(`author · time · (edited) · text · (展开/收起) · actions`),`align-items: flex-start`,`padding` 10→6,单条评论从 ~70px 降到 ~38px
- 长文本(`/ 60 字符或含 \n`)用 `-webkit-line-clamp: 1` 截断 + 省略号 + "展开" 按钮;展开后 `-webkit-line-clamp: unset` + `display: block` 显示全文,按钮文案切到 "收起"
- `watch(contentMd)` 在内容变更时重置 `expanded`,避免编辑后残留旧展开态
- 不再用 `ref + scrollHeight` 测量(每条评论挂载多一次强制 reflow,评论密度高的页面不值)— 启发式误判最坏只是多一个点了无用的"展开"按钮,无副作用
- 取消前头像列 + icon 直出(`reply` / `delete`,`material-symbols-outlined`);`@mention` 沿用 `mention.css` 的 `.mention-chip` 全局规则,跟 editor live view / saved HTML read view 样式一致

### Stage 7 (continued): tree per-space + 评论分页 + composer @mention + 收尾
- **tree 展开态 per-space**(`stores/ui.ts` + `components/layout/PageTree.vue`):
  - `expanded` 由 `string[]` 改成 `Record<spaceId, string[]>`:切 space 不再互相覆盖
  - 老用户 `string[]` 数据自动落到 `__legacy__` 兜底 key,新 space 第一次 toggle 才物化自己,避免"首次 toggle clobber 整个老展开态"
  - `isExpanded` / `toggle` / `expand` 加 `spaceId` 参数;`setExpanded` 已无 caller,直接删
  - `PageTree.vue` 用 `computed` 包 `spacesStore.activeSpaceId.value ?? ''` 透传
- **`useMentionCandidates` composable**(`apps/web/src/composables/useMentionCandidates.ts`):
  - 候选缓存 `candidatesRef` / `pageIdRef` / `loadingRef` / `fetchSeq` / `bindPage` / `reset` 提到 module-scope composable
  - `MentionList.vue`(编辑器弹层)与 `mentionExtension.ts`(Tiptap `items` 回调)共享同一份 state;不再"两处都从 SFC 内部 import"
  - 旧的 `debouncedFetch` 仍由 `MentionList.vue` 局部包装(让 UI 副作用跟数据 fetch 解耦)
- **mention.css 集中**(`apps/web/src/styles/mention.css`,新文件):
  - `.mention-chip` / `.mention-chip[data-mention="0"]` 从 `components.css` 移出
  - `.mention-suggestion-host` / `.mention-header` / `.mention-row` / `.mention-footer` 等弹层规则从 `MentionList.vue` 的非-scoped `<style>` 块移出(本来因为 Tippy 把节点挂到 `document.body` 不得不 global,集中到一个文件更易读)
  - `main.ts` 增 `import './styles/mention.css'`;`CommentItem.vue` / `MentionView.vue` 注释里旧的"global rule in components.css"同步更新
- **评论区分页加载**(`CommentsSection.vue`):
  - 切到 `usePaginatedList(api.comments.list, { pageSize: 20 })`(`?limit=20&offset=N`,后端已支持)
  - 列表底部"加载更多"圆角 pill 按钮 + spinner(`disabled` 时灰显),`— 已加载全部 —` 收尾
  - 顶部 `refreshing` 进度条(B.3 stale-items 模式):切 page 不闪空白,旧评论先停在背景里
  - 标题 `评论 (N)` → `评论 (N+)` 表示还有更多;Skeleton 占位替换原来"加载评论中…"文字
  - `pageId` watch 触发 `reset()`;`paginatedError` 转成 `localError` 维持原有 UX 文案
- **评论列表样式 polish**(`CommentItem.vue`):
  - 头像位置已删,行内只有 username · 时间 · edited — `ci-time` 加 `margin-left: 2px` 拉开跟 username 距离
  - `ci-head-actions` 默认 `opacity: 0.55`,`hover` / `focus-within` 评论行再 `1`,减少视觉噪音
  - `.ci-text` 加 `overflow-wrap: anywhere` 折长 URL
  - `.ci-replies` `padding-left` 12 → 14,`border-left` 颜色 `var(--border, #ebeef0)` 调浅
  - `.comment-item:last-child` 去掉最后一个底边
- **评论 composer @mention**(`useCommentMention` composable + `CommentsComposer.vue`):
  - `<textarea>` 监听 `@` 输入,弹 Tippy 弹层,候选 = 该 page space 的访问组成员(与编辑器同源,`useMentionCandidates` 共享)
  - 弹层位置用 mirror div + 计算样式复刻 textarea 字体 / padding / scrollTop 量出 `@` 字符的 `DOMRect`
  - 候选 `@<name> ` 插入到光标位置 + 自动 focus 回 textarea,光标停在 `name` 之后
  - 候选 userId 进入 `mentionedUserIds: Set<string>`,提交时随 `api.comments.create({ ..., mentionedUserIds })` 一并发出;后端事务前 re-verify,客户端伪造的 userId 会被丢弃
  - 弹层内 `↑/↓/Enter/Esc` 由 composable 自处理;Cmd/Ctrl+Enter 仍走 composer 的提交,跟弹层互不干扰
  - placeholder 改成 "输入 @ 提及成员"
- **`verify_*.py` 挪到 `scripts/`**:3 个 `git mv`,仓库根目录不再有散落脚本;`git log -M` 视为 rename 而非 delete+add

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

[Unreleased]: ../../compare/v0.6.0...HEAD
[0.6.0]: ../../compare/v0.5.0...v0.6.0
[0.5.0]: ../../compare/v0.4.0...v0.5.0
[0.4.0]: ../../compare/v0.3.0...v0.4.0
[0.3.0]: ../../compare/v0.2.0...v0.3.0
[0.2.0]: ../../compare/v0.1.0...v0.2.0
[0.1.0]: ../../tree/v0.1.0
