# API 端点

`apps/api` 监听 `:8787`,前端通过 Vite proxy 走 `:5173/api`。所有非 auth / health 路由 `requireAuth`;`/api/admin/*` 全部 `requireAdmin`;**`requireAuth` 不给 admin bypass,personal-space 写保护**在路由里显式 `assertAdminNotWritingPersonalSpace` 抛 403 `personal_space_readonly`(见 [docs/data-model.md](./data-model.md))。

完整契约以 `@power-wiki/shared/src/schemas.ts` 的 zod schema 为准,所有路由用 `*.parse()` 在响应边界二次校验(防 schema 漂移)。

`apps/api/src/index.ts` 挂载的 21 个 route mount(`app.route` 23 次调用 —— `pageLabelsRouter` 同时挂到 `/api/pages` 和 `/api/labels`,`avatarPresetsRouter` + `publicSharesRouter` 挂到 `/api`):

| 路径前缀 | 路由文件 | 备注 |
|---|---|---|
| `/api/auth` | `routes/auth.ts` | 公开,sign-in / sign-out / session / reset-password |
| `/api/user-avatars` | `routes/avatarRaw.ts` | M11 公开头像 raw proxy(同 username 一样对外公开,放在 requireAuth **之前**) |
| `/api` | `routes/avatarPresets.ts` | M11 v2 公开预设清单(扫 `apps/web/public/avatars/` 同步给客户端) |
| `/api` | `routes/publicShares.ts` | Phase D 公开分享 GET `/public/pages/:token` + `/public/pages/:token/attachments/:id/raw`(匿名只读,在 requireAuth **之前**) |
| `/api/pages` | `routes/pages.ts` | 页面 CRUD + tree + trash + publish + duplicate + move + snapshots + page_event 查询 |
| `/api/pages` | `routes/pageVersions.ts` | 子路由,版本历史 + restore |
| `/api/pages` + `/api/labels` | `routes/pageLabels.ts` | 子路由,挂两前缀;labels CRUD + 搜索 |
| `/api/pages` | `routes/pageRestrictions.ts` | Phase B 页面级 view/edit 限制(单行 UPSERT + 整组 PUT) |
| `/api/pages` | `routes/pageShares.ts` | Phase D 公开分享管理(auth + edit-access 三端点) |
| `/api/attachments` | `routes/attachments.ts` | MinIO 附件 upload-url / finalize / list / raw / delete |
| `/api/spaces` | `routes/spaces.ts` | 用户可见 space 列表 + 单个详情 |
| `/api/spaces` | `routes/spacePermissions.ts` | Phase A 空间角色管理(per-user / per-group grant,viewer/editor/admin) |
| `/api/comments` | `routes/comments.ts` | 评论 CRUD + mention-candidates(分页 list) |
| `/api/notifications` | `routes/notifications.ts` | 通知 list / unread-count / mark-read / clear-all |
| `/api/users` | `routes/users.ts` | 自服务 user profile(me 读写 + watched 列表 + recent 列表/清空 + me dashboard 聚合 + 头像上传 presign / finalize) |
| `/api/search` | `routes/search.ts` | 零中间件全文搜索 |
| `/api/admin/users` | `routes/adminUsers.ts` | admin 后台用户管理(CRUD + disable / enable / reset-password / **anonymize** + **impact**) |
| `/api/admin/groups` | `routes/adminGroups.ts` | admin 后台用户组管理(CRUD + members + **impact** + DELETE 拒绝 pg-*) |
| `/api/admin/spaces` | `routes/adminSpaces.ts` | admin 后台空间管理(legacy `/access` 保留) |
| `/api/admin/settings` | `routes/adminSettings.ts` | admin 后台全局设置(按 key 读 / 写) |
| `/api/admin` | `routes/adminAudit.ts` | Phase C 权限变更审计日志(GET /audit?kind=&targetKind=&actorId=&from=&to=) |

## Auth(`/api/auth/*`,公开)

| Method | Path | 说明 |
|---|---|---|
| POST | `/sign-in` | body `{email,password}` → `Set-Cookie: pw_session` + `{user, mustResetPassword, personalSpaceId}` |
| POST | `/sign-out` | 清 cookie + 删 session,204 |
| GET  | `/session` | 当前用户信息,401 表示未登录;返 `{user, mustResetPassword, personalSpaceId}` |
| POST | `/reset-password` | body `{currentPassword,newPassword}`,需登录;返 `{user, personalSpaceId}` |

错误码:`400 invalid_input` / `401 unauthorized` / `403 account_disabled`(user.status='disabled')。sign-in 故意**不**区分「用户不存在」vs「密码错」,统一返 401 + 通用文案防账号枚举。

## Pages(`/api/pages`)

普通用户自动按可见 space 过滤,admin 看全部(但写 personal space 仍 403)。

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET    | `/` | 普通 | 按可见 space 过滤,admin 看全部;`?space=` 可选过滤单空间;`?parentId=` 树懒加载用 |
| GET    | `/trash` | admin | 跨空间回收站(`?space=` 必填) |
| GET    | `/:id` | 普通 | 不可见 space 返 404(防越权猜测) |
| POST   | `/` | 普通 | body `{parentId?,title?,icon?,spaceId,...}`,`spaceId` 必填 |
| PATCH  | `/:id` | 普通 | body `{title?,contentJSON?,contentHTML?,icon?}`;metadata-only PATCH 不打 `page_versions` |
| PATCH  | `/:id/move` | 普通 | body `{newParentId,newOrder?}`,循环返 409 `cycle` |
| POST   | `/:id/snapshots` | 普通 | 手动 / 边界快照入口(EditView 30s idle + route leave 末段自动调),retention 30 行 |
| POST   | `/:id/publish` | 普通 | body `{targetSpaceId, includeChildren?, depth?}` → 201 + 新 `PageNode`(personal space → team space 的「发布到」语义:源页保留,新页标题自动加 `（来自 {userName} 的个人分享）` 后缀,源页只读于自己 personal space)。附件随发布**独立复制**(S3 对象 + DB 行 + 内容引用改写,防跨空间裂图)。`includeChildren:true` 时按 `depth`(默认 1 = 仅直接子级,max 50 当「全部」)BFS 递归复制子树,子页保留原标题、独立复制各自附件,`published` 事件只打根页 |
| POST   | `/:id/duplicate` | 普通 | 同 sibling 组复制,标题前缀 `复制自`,新页落在源页正下方 |
| POST   | `/:id/restore` | admin | 恢复软删除页 |
| DELETE | `/:id` | 普通(soft) / admin(`?purge=true`) | 默认软删进回收站;`?purge=true` 硬删整棵子树(recursive CTE + comments / notifications / attachments 三表三步事务清理) |
| GET    | `/:id/versions` | 普通 | 分页列表,DESC 排序,`?limit=20&offset=`,返 `{items, hasMore, limit, offset}` |
| POST   | `/:id/versions/:vid/restore` | 普通 | 恢复历史版本,创建新 version + 更新 page content,`changeNote = "restored from v{N}"` |
| POST   | `/:id/labels` | 普通 | body `{label}` → 204(idempotent,同 label 重复加不返错) |
| DELETE | `/:id/labels/:label` | 普通 | → 204 |
| GET    | `/labels/search` | 普通 | `?q=&limit=`(max 50,default 20)→ `string[]`,挂 `/api/labels/search` 同一路由 |

### Page Restrictions(Phase B,挂在 `/api/pages` 同前缀)

Confluence 风格 view / edit 限制。`requireAuth` + `canManageRestrictions`(作者 / space-admin / global admin / space-editor 四选一)。view 限制 + 公开分享互斥,创建 share 时校验 view 限制存在性 → 400 `share_forbidden`。

| Method | Path | 说明 |
|---|---|---|
| GET    | `/:id/restrictions` | 返 `{view, edit}` 完整结构(含 grantedBy/grantedAt 元信息);读限制需要 `canReadPage` |
| GET    | `/:id/restrictions/candidates` | 给限制 dialog 的 people / group picker;返回全部 active users + 非 personal groups(pg-* 排除);`canManageRestrictions` 守 |
| PUT    | `/:id/restrictions` | 整组替换,body `{view?: [], edit?: []}`(两者空 = 清空);事务内拍 before / after snapshot |
| POST   | `/:id/restrictions/:kind/users/:userId` | body `{}`(可选 grantedBy),单行 UPSERT(`ON CONFLICT DO UPDATE` 幂等) |
| DELETE | `/:id/restrictions/:kind/users/:userId` | 单行删;原行存在才写 audit `_remove` |
| POST   | `/:id/restrictions/:kind/groups/:groupId` | body `{}`,单行 UPSERT |
| DELETE | `/:id/restrictions/:kind/groups/:groupId` | 单行删 |

### Page Shares(Phase D,挂在 `/api/pages` 同前缀)

公开链接管理。`requireAuth` + `canEditPage OR canAdminSpace`(即 canManageRestrictions 同源)。明文 token **只此一次**出现在 `POST /share` 响应,DB 只存 `sha256(token)`。

| Method | Path | 说明 |
|---|---|---|
| POST   | `/:id/share` | body `{expiresInDays?: 7\|30\|90\|null}`(null = 永不过期)→ 201 `{id, token, url, expiresAt, createdAt}`;**校验:** shared space(否则 400 `share_forbidden`)+ 无 view 限制(否则 400 `share_forbidden`)+ `deleted_at IS NULL` |
| GET    | `/:id/shares` | → `{shares: ShareRow[]}`(DESC by createdAt;revoked / active 都返) |
| DELETE | `/:id/share/:shareId` | → 204;若已 revoked → 400 `share_already_revoked`;**不**做 cascade(page purge 才扫 shares) |

### Public Shares(Phase D,挂在 `/api` 同前缀,**无需 auth**)

`publicSharesRouter` 挂在 `app.use('/api/*', requireAuth)` **之前**,匿名访问。

| Method | Path | 说明 |
|---|---|---|
| GET | `/public/pages/:token` | `sha256(token)` 命中 + `revoked_at IS NULL` + (`expires_at IS NULL OR > now`) + page `deleted_at IS NULL` + `spaces.kind='shared'`;任一失败 → 404;命中后 fire-and-forget 更新 `last_accessed_at`;`Cache-Control: public, max-age=60`;返回前把 contentHTML 内联的 `/api/attachments/{id}/raw` 改写成 `/api/public/pages/{token}/attachments/{id}/raw` |
| GET | `/public/pages/:token/attachments/:id/raw` | 匿名附件流。校验同上(复用 `lookupShare`),再确认 attachment 归属该 share 的 page(别页附件 → 404,防横向枚举);S3 流式,image→inline / file→attachment;`Cache-Control: public, max-age=60`;S3 错误 → 502 |

**`PATCH /:id` 永不打 `page_versions`** — version 只在 `POST /:id/snapshots` 边界打;EditView 30s idle + `flushPendingSave` 末尾各调一次。Retention 30 行复用 `apps/api/src/routes/pageVersions.ts` 的 `RETENTION`。

## Spaces(`/api/spaces`)

普通用户;`/api/spaces/:id` 不可见返 404。**DTO 富化**:返回的 `SpaceNode` 含 `pageCount` / `childPageCount` / `lastPageUpdatedAt`,admin 路径额外带 `accessGroupIds` + `accessGrants`(Phase A 结构化 grants,group/user 每条带 role/grantedBy/grantedAt),personal space 路径额外带 `ownerName`(所有这些字段都在后端 `LEFT JOIN + GROUP BY` 算好,前端不需要 N+1)。

| Method | Path | 说明 |
|---|---|---|
| GET | `/` | 当前用户可见 space 列表 |
| GET | `/:id` | 单个,不可见返 404 |
| PATCH | `/:id` | body `UpdateSpaceInput = {name?, description?(\|null), color?, icon?(\|null)}`,空 patch → 400 `invalid_input`;**仅 `kind === 'shared'` 且 `me.isAdmin OR canAdminSpace(me, id)`**,其余(不存在 / personal / 无权限)统一 404,跟 GET 不可见策略一致;成功返 `SpaceSchema` + `viewerRole: 'admin'`(元信息编辑不写 `permission_audit`,与 global admin PATCH 同语义) |

### Space Permissions(Phase A,挂在 `/api/spaces` 同前缀)

`requireAuth` + 路由内 `me.isAdmin OR canAdminSpace` 二级判定。`role='admin'` 不能授给组(只能授具体 user,后端返 400 `admin_role_to_group`)。legacy `/api/admin/spaces/:id/access` 系列保留作 rollback。

| Method | Path | 说明 |
|---|---|---|
| GET    | `/:id/permissions` | 返 `{groups, users}` 完整结构化 grants(admin 路径额外带 `grantedBy` / `grantedAt` 元信息) |
| GET    | `/:id/permissions/candidates` | space-admin 用 —— 拿 `groups` + `users` 候选列表(非 admin 也能用,避免调 admin 路径) |
| PUT    | `/:id/permissions` | 整组替换,body `{groups?: [{groupId, role}], users?: [{userId, role}]}`;refine 至少一个非空 |
| POST   | `/:id/permissions/groups/:groupId` | body `{role}` 单行 UPSERT,idempotent;**role='admin' → 400** |
| POST   | `/:id/permissions/users/:userId` | 同上(可授 admin);移除最后一个 user-admin → 409 `cannot_remove_last_admin` |
| DELETE | `/:id/permissions/groups/:groupId` | 单行删,legacy `space_group_access` 行同事务迁移到 `space_role_grants role='editor'` |
| DELETE | `/:id/permissions/users/:userId` | 同上 |

## Attachments(`/api/attachments`)

**两步上传**(S3 字节不经过 API):

1. `POST /upload-url` — body `{pageId,originalFilename,mimeType,sizeBytes}` → `{uploadUrl, attachmentId, storageKey, expiresAt}`,**不写 DB**。
2. 浏览器 `PUT uploadUrl` 直传字节到 MinIO。
3. `POST /finalize` — body `{attachmentId, storageKey, sizeBytes,...}` → 201 `Attachment`,HeadObject 校验真实 size,匹配才 INSERT。

| Method | Path | 说明 |
|---|---|---|
| POST | `/upload-url` | body `{pageId, originalFilename, mimeType, sizeBytes}` → 200 presign |
| POST | `/finalize` | body `{attachmentId, storageKey, sizeBytes, ...}` → 201 `Attachment` |
| GET  | `/?pageId=` | 列表(DESC by createdAt) |
| GET  | `/:id/raw` | 流式响应;image `Content-Disposition: inline`,file `attachment; filename=...` |
| DELETE | `/:id` | → 204;DB 行删 + S3 `deleteObject` best-effort(失败仅日志) |

权限:写(upload-url / finalize / delete)走 `canAccessSpace` + `assertAdminNotWritingPersonalSpace`;读(list / raw)走 `canAccessSpace`,跨空间 404。MIME 白名单在 `packages/shared/src/constants.ts:ALLOWED_MIME_TYPES`(`image/*` + PDF + Office + md/txt/csv/zip)。

## Comments(`/api/comments`)

| Method | Path | 说明 |
|---|---|---|
| GET    | `/?pageId=&limit=&offset=` | `?pageId` 必填;返 `{items: Comment[] with embedded replies, hasMore, limit, offset}`(**不是**通用 `PaginatedList`,comment list 端点特殊);top-level `parent_id IS NULL`,replies 平铺在每个 top-level 的 `replies: Comment[]` 内,**最大嵌套深度 = 2** |
| GET    | `/mention-candidates?pageId=&q=` | `?pageId` 必填;返 `string[]` 候选 userId;后端限定为该 page space 的访问组成员(JOIN `space_group_access × user_group_members × users WHERE status='active'`) |
| POST   | `/` | body `{pageId, contentMd, contentText, parentId?, mentionedUserIds?}` → 201 `Comment`;**单事务**内 `INSERT comment + enqueueNotifications(kind=mention|reply|comment_on_my_page)`,作者与目标相同时不发 |
| PATCH  | `/:id` | body `{contentMd, contentText, mentionedUserIds?}`;**author-only**(admin 不能编辑他人评论,Confluence / Notion / 飞书 默认);`isEdited=true, editedAt=now`;事务前 re-verify mentions,伪造 userId 丢弃 |
| DELETE | `/:id` | 软删除,`deletedAt=now, deletedBy=me.id` → 204;author-or-admin |

## Notifications(`/api/notifications`)

**只看自己的**(`WHERE user_id=me.id`,无 admin bypass)。

| Method | Path | 说明 |
|---|---|---|
| GET | `/?limit=&offset=` | `PaginatedList<Notification>`,DESC by `createdAt`;limit 1-100,default 50 |
| GET | `/unread-count` | → `{count}`;TopBar bell 30s 轮询 |
| POST | `/mark-read` | body `{ids?: string[]}` 或 `{all: true}` → `{ok: true}`;不传 ids + 不传 all 返 400 `invalid_input` |
| POST | `/clear-all` | 删所有 `isRead=true` 行,返 `{deleted: number}` |

`Notification.kind` 枚举:`mention` / `reply` / `comment_on_my_page` / `page_like`,见 `packages/shared/src/schemas.ts:NotificationSchema`。

## Users(`/api/users`,自服务)

`requireAuth`,无 admin 要求 —— 当前登录用户自己的 profile + 派生数据(watched 列表、recent 浏览、me dashboard 聚合)。**不走 admin/users**(那是 admin 视角的全量用户管理)。

| Method | Path | 说明 |
|---|---|---|
| GET    | `/me` | 当前用户完整 profile(同 `/api/auth/session`,实现上是同一行) |
| PATCH  | `/me` | body `{name?,email?}`;email 改动会触发下次登录生效,清 session(同 auth 流) |
| GET    | `/me/watched` | → `PageNode[]` 当前用户 watch 的页(`user_watched_pages` JOIN pages,带可见 space 过滤) |
| GET    | `/me/recent?limit=` | per-user 最近浏览(`user_recent_pages` DESC),limit 1-50,default 20 |
| DELETE | `/me/recent` | 清空当前用户 recent(头像 menu 「清空最近」按钮) |
| GET    | `/me/dashboard` | MeDashboard 聚合一次返:recent + watched + 我创建的页 + 我最近编辑的页 + 通知 unread-count,后端 `LEFT JOIN + GROUP BY` 算好,前端不再 N+1 |

## Search(`/api/search`)

**零中间件全文搜索** — 后端 Drizzle `ILIKE` over `pages.title` + `pages.content_text`,LIKE 通配符在 query 里 escape。**不**引 ES / Meili / Typesense。

| Method | Path | 说明 |
|---|---|---|
| GET | `/?q=&space=&label=&limit=&offset=` | `PaginatedList<PageNode>`;limit 1-50,default 20;`?space` / `?label` 过滤;`?q` 命中 title + `content_text`(Tiptap JSON 写入时抽出的纯文本) |

## Admin(`/api/admin/*`,全部 `requireAdmin`)

### Users

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表(`?limit=200`) |
| GET    | `/:id` | 单个 |
| POST   | `/` | body `{email,name,role}` → 201 `{user, initialPassword}`(明文密码**仅此一次**返,前端 display 后清) |
| PATCH  | `/:id` | 改基础字段(email / name / role / status) |
| POST   | `/:id/disable` | 禁用 + 清 sessions(`killSessionsForUser`);最后一个 admin → 409 `last_admin` |
| POST   | `/:id/enable` | 启用 |
| POST   | `/:id/reset-password` | 重置初始密码 + 清 sessions → 200 `{user, initialPassword}` |
| POST   | `/:id/anonymize` | 改 name=「已注销用户」+ email=`{id}@anonymized.invalid` + status='disabled' + 清 avatar + sweep sessions / notifications / recent / watched / likes / group_memberships / space_grants(principal_kind='user');**不动** pages / comments(保留痕迹);audit `user_anonymized`;自删 → 409 `self_anonymize`;已 disabled user 二次调用 idempotent |

### Groups

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表 |
| POST   | `/` | 建组 |
| GET    | `/:id` | 单个 |
| PATCH  | `/:id` | 改名等 |
| DELETE | `/:id` | **拒绝** `pg-*`(个人组保护,→ 404 `not_found`);非 pg-* → 事务里 sweep `user_group_members` + `space_role_grants`(`principal_kind='group'`) |
| GET    | `/:id/impact` | 删前影响评估 → `{memberCount, legacyGrantCount, roleGrantCount, restrictionCount}` 四项计数 |
| POST   | `/:id/members` | body `{userId}` 加成员 |
| DELETE | `/:id/members/:userId` | 移成员 |

### Spaces

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表(含 personal),DTO 同样有 `pageCount` / `childPageCount` / `lastPageUpdatedAt` |
| POST   | `/` | body `{name,kind:'personal'\|'shared'}` → 201;`kind='personal'` 自动建 `pg-<userId>` 组并 grant 给该 user |
| GET    | `/:id` | 单个;admin 路径额外带 `accessGroupIds` + `accessGrants`(完整 pg-* / 业务组列表 + 结构化 grants) |
| PATCH  | `/:id` | 改名 / 改 owner 等 |
| DELETE | `/:id` | **拒绝** `personal`(→ 400 `personal_space_cannot_delete`);非空(有未删页)→ 409 `space_not_empty`;空 shared space → 事务里 sweep `pages` + `space_role_grants` + `comments` / `notifications` / `attachments` recursive |
| PUT    | `/:id/access` | **legacy** 整组替换 access(保留作 rollback;Phase A 起写入时同事务迁到 `space_role_grants`) |
| POST   | `/:id/access/:groupId` | legacy 加一组 access |
| DELETE | `/:id/access/:groupId` | legacy 删一组 access |

### Settings

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量 `admin_settings` 键值对(`key → value`) |
| GET    | `/:key` | 单个 key → `{key, value, updatedAt, updatedBy}` |
| PATCH  | `/:key` | body `{value}` → 200;写值 + 记录 `updatedBy=me.id, updatedAt=now` |

### Audit(Phase C,挂在 `/api/admin` 同前缀)

`requireAdmin` 兜底。append-only 后端,GET 是唯一入口,无 POST / PATCH / DELETE 暴露给 HTTP 层;**唯一写入路径**是 `recordPermissionAudit(tx, ...)`,在 mutation 路由的 `db.transaction()` 内调。

11 个 `kind` 事件:Phase A 的 4 个(`space_grant_set` / `_add` / `_remove` + legacy 兼容)+ Phase B 的 3 个(`page_restriction_set` / `_add` / `_remove`)+ Phase D 的 2 个(`page_share_create` / `_revoke`)+ 资源生命周期的 3 个(`space_deleted` / `group_deleted` / `user_anonymized`,0029 迁移扩展 CHECK)。5 个 `target_kind`:`space` / `page` / `page_share` / `group` / `user`。

| Method | Path | 说明 |
|---|---|---|
| GET | `/audit?kind=&actorId=&targetKind=&targetId=&from=&to=&limit=&offset=` | 按 `created_at DESC` 排序的分页列表;actor LEFT JOIN `users` 平铺展示(name / email / color / avatar);payload JSONB 自由形态 `{before, after}`,前端按 kind 分支展示 |

## 错误响应规范

```ts
// 单条错误
{ "error": "not_found" }
{ "error": "has_children" }      // 409,有未删子节点
{ "error": "parent_trashed" }    // 409,父页在回收站
{ "error": "cycle" }             // 409,移动产生环
{ "error": "personal_space_readonly" }  // 403,admin 写 personal space
```

完整错误码(各路由 4xx 段):

| Code | Status | 触发场景 |
|---|---|---|
| `invalid_input` | 400 | zod schema 校验失败 |
| `unauthorized` | 401 | 没 cookie / session 失效 |
| `account_disabled` | 403 | `users.status === 'disabled'` |
| `forbidden` | 403 | 一般权限不足(admin 跨组操作等) |
| `personal_space_readonly` | 403 | admin 写 personal space(所有写路由统一抛) |
| `not_found` | 404 | 资源不存在 / 不可见 space(防越权猜测)|
| `not_trashed` | 409 | `restore` 路径但页不在 trash |
| `page_trashed` | 409 | 在已 trashed 的页上做操作 |
| `has_children` | 409 | 硬删前还有子页未删 |
| `parent_trashed` | 409 | 父页在回收站 |
| `cycle` | 409 | `move` 产生环(`isDescendantOrSelf` 检测) |
| `invalid_label` | 400 | label 字符串不通过 `LABEL_REGEX` |
| `size_mismatch` | 400 | attachments finalize 阶段 HeadObject size 与请求不符 |
| `upload_not_found` | 404 | finalize 时 S3 上找不到对应 storageKey |
| `storage_unavailable` | 503 | MinIO 不可达 / presign 失败 |
| `admin_role_to_group` | 400 | POST `.../permissions/groups/:gid` body `role='admin'` |
| `cannot_remove_last_admin` | 409 | DELETE 把最后一个 user-grant space-admin 干掉了 |
| `page_restricted` | 403 | 不在 edit allow-list 但试图编辑 |
| `view_restricted` | 403 | 不在 view allow-list 但试图 GET |
| `share_forbidden` | 400 | POST share 时是 personal space 或有 view 限制 |
| `share_already_revoked` | 400 | DELETE share 时已是 revoked 态 |
| `share_invalid` / `share_revoked` / `share_expired` | 404 | GET public 失败原因(token 不存在 / 已撤销 / 已过期) |
| `personal_space_cannot_delete` | 400 | DELETE `/admin/spaces/:id` 时 `kind='personal'` |
| `space_not_empty` | 409 | DELETE `/admin/spaces/:id` 时有未删页 |
| `last_admin` | 409 | disable / anonymize 最后一个 admin |
| `self_anonymize` | 409 | 自己 anonymize 自己 |
| `internal` | 500 | 未处理异常(全局 `app.onError` 兜底) |

每个具体 code 在前端 `apps/web/src/lib/api.ts` 的 `ApiError` 类里有映射,banner 文案在 stores 端组装。

## 跨视图共享数据

复杂聚合(成员数 / 空间页数 / 评论回复树 / 未读通知数等)走后端 `LEFT JOIN + GROUP BY + COUNT(*)`,不让前端为了拿一个 count 跑 `Promise.all(items.map(getDetail))`。详见 [docs/loading-ux.md](./loading-ux.md)。
