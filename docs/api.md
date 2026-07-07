# API 端点

`apps/api` 监听 `:8787`,前端通过 Vite proxy 走 `:5173/api`。所有非 auth / health 路由 `requireAuth`;`/api/admin/*` 全部 `requireAdmin`;**`requireAuth` 不给 admin bypass,personal-space 写保护**在路由里显式 `assertAdminNotWritingPersonalSpace` 抛 403 `personal_space_readonly`(见 [docs/data-model.md](./data-model.md))。

完整契约以 `@power-wiki/shared/src/schemas.ts` 的 zod schema 为准,所有路由用 `*.parse()` 在响应边界二次校验(防 schema 漂移)。

`apps/api/src/index.ts` 挂载的 13 个 route mount:

| 路径前缀 | 路由文件 | 备注 |
|---|---|---|
| `/api/auth` | `routes/auth.ts` | 公开,sign-in / sign-out / session / reset-password |
| `/api/pages` | `routes/pages.ts` | 页面 CRUD + tree + trash + publish + duplicate + move + snapshots |
| `/api/pages` | `routes/pageVersions.ts` | 子路由,版本历史 + restore |
| `/api/pages` + `/api/labels` | `routes/pageLabels.ts` | 子路由,挂两前缀;labels CRUD + 搜索 |
| `/api/attachments` | `routes/attachments.ts` | MinIO 附件 upload-url / finalize / list / raw / delete |
| `/api/spaces` | `routes/spaces.ts` | 用户可见 space 列表 + 单个详情 |
| `/api/comments` | `routes/comments.ts` | 评论 CRUD + mention-candidates(分页 list) |
| `/api/notifications` | `routes/notifications.ts` | 通知 list / unread-count / mark-read / clear-all |
| `/api/search` | `routes/search.ts` | 零中间件全文搜索 |
| `/api/admin/users` | `routes/adminUsers.ts` | admin 后台用户管理 |
| `/api/admin/groups` | `routes/adminGroups.ts` | admin 后台用户组管理 |
| `/api/admin/spaces` | `routes/adminSpaces.ts` | admin 后台空间管理 |

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
| PATCH  | `/:id` | 普通 | body `{title?,contentJSON?,contentHTML?,icon?,starred?}`;`starred` 是 metadata,不打 `page_versions` |
| PATCH  | `/:id/move` | 普通 | body `{newParentId,newOrder?}`,循环返 409 `cycle` |
| POST   | `/:id/snapshots` | 普通 | 手动 / 边界快照入口(EditView 30s idle + route leave 末段自动调),retention 30 行 |
| POST   | `/:id/publish` | 普通 | body `{targetSpaceId}` → 201 + 新 `PageNode`(personal space → team space 的「发布到」语义:源页保留,新页标题自动加 `（来自 {userName} 的个人分享）` 后缀,源页只读于自己 personal space) |
| POST   | `/:id/duplicate` | 普通 | 同 sibling 组复制,标题前缀 `复制自`,新页落在源页正下方 |
| POST   | `/:id/restore` | admin | 恢复软删除页 |
| DELETE | `/:id` | 普通(soft) / admin(`?purge=true`) | 默认软删进回收站;`?purge=true` 硬删整棵子树(recursive CTE + comments / notifications / attachments 三表三步事务清理) |
| GET    | `/:id/versions` | 普通 | 分页列表,DESC 排序,`?limit=20&offset=`,返 `{items, hasMore, limit, offset}` |
| POST   | `/:id/versions/:vid/restore` | 普通 | 恢复历史版本,创建新 version + 更新 page content,`changeNote = "restored from v{N}"` |
| POST   | `/:id/labels` | 普通 | body `{label}` → 204(idempotent,同 label 重复加不返错) |
| DELETE | `/:id/labels/:label` | 普通 | → 204 |
| GET    | `/labels/search` | 普通 | `?q=&limit=`(max 50,default 20)→ `string[]`,挂 `/api/labels/search` 同一路由 |

**`PATCH /:id` 永不打 `page_versions`** — version 只在 `POST /:id/snapshots` 边界打;EditView 30s idle + `flushPendingSave` 末尾各调一次。Retention 30 行复用 `apps/api/src/routes/pageVersions.ts` 的 `RETENTION`。

## Spaces(`/api/spaces`)

普通用户;`/api/spaces/:id` 不可见返 404。**DTO 富化**:返回的 `SpaceNode` 含 `pageCount` / `childPageCount` / `lastPageUpdatedAt`,admin 路径额外带 `accessGroupIds`,personal space 路径额外带 `ownerName`(所有这些字段都在后端 `LEFT JOIN + GROUP BY` 算好,前端不需要 N+1)。

| Method | Path | 说明 |
|---|---|---|
| GET | `/` | 当前用户可见 space 列表 |
| GET | `/:id` | 单个,不可见返 404 |

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
| PATCH  | `/:id` | body `{contentMd, contentText, mentionedUserIds?}`;author-or-admin;`isEdited=true, editedAt=now`;事务前 re-verify mentions,伪造 userId 丢弃 |
| DELETE | `/:id` | 软删除,`deletedAt=now, deletedBy=me.id` → 204;author-or-admin |

## Notifications(`/api/notifications`)

**只看自己的**(`WHERE user_id=me.id`,无 admin bypass)。

| Method | Path | 说明 |
|---|---|---|
| GET | `/?limit=&offset=` | `PaginatedList<Notification>`,DESC by `createdAt`;limit 1-100,default 50 |
| GET | `/unread-count` | → `{count}`;TopBar bell 30s 轮询 |
| POST | `/mark-read` | body `{ids?: string[]}` 或 `{all: true}` → `{ok: true}`;不传 ids + 不传 all 返 400 `invalid_input` |
| POST | `/clear-all` | 删所有 `isRead=true` 行,返 `{deleted: number}` |

`Notification.kind` 枚举:`mention` / `reply` / `comment_on_my_page`,见 `packages/shared/src/schemas.ts:NotificationSchema`。

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
| POST   | `/:id/disable` | 禁用 + 清 sessions(`killSessionsForUser`) |
| POST   | `/:id/enable` | 启用 |
| POST   | `/:id/reset-password` | 重置初始密码 + 清 sessions → 200 `{user, initialPassword}` |

### Groups

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表 |
| POST   | `/` | 建组 |
| GET    | `/:id` | 单个 |
| PATCH  | `/:id` | 改名等 |
| DELETE | `/:id` | 硬删(事务里先扫 `userGroupMembers` + `spaceGroupAccess`) |
| POST   | `/:id/members` | body `{userId}` 加成员 |
| DELETE | `/:id/members/:userId` | 移成员 |

### Spaces

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表(含 personal),DTO 同样有 `pageCount` / `childPageCount` / `lastPageUpdatedAt` |
| POST   | `/` | body `{name,kind:'personal'\|'shared'}` → 201;`kind='personal'` 自动建 `pg-<userId>` 组并 grant 给该 user |
| GET    | `/:id` | 单个;admin 路径额外带 `accessGroupIds`(完整 `pg-*` / 业务组列表) |
| PATCH  | `/:id` | 改名 / 改 owner 等 |
| DELETE | `/:id` | 硬删(事务里先扫 `pages` + `spaceGroupAccess` + `comments` / `notifications` / `attachments` recursive) |
| PUT    | `/:id/access` | 整组替换 access(事务) |
| POST   | `/:id/access/:groupId` | 加一组 access |
| DELETE | `/:id/access/:groupId` | 删一组 access |

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
| `internal` | 500 | 未处理异常(全局 `app.onError` 兜底) |

每个具体 code 在前端 `apps/web/src/lib/api.ts` 的 `ApiError` 类里有映射,banner 文案在 stores 端组装。

## 跨视图共享数据

复杂聚合(成员数 / 空间页数 / 评论回复树 / 未读通知数等)走后端 `LEFT JOIN + GROUP BY + COUNT(*)`,不让前端为了拿一个 count 跑 `Promise.all(items.map(getDetail))`。详见 [docs/loading-ux.md](./loading-ux.md)。
