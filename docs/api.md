# API 端点

`apps/api` 监听 `:8787`,前端通过 Vite proxy 走 `:5173/api`。所有非 auth / health 路由 `requireAuth`;`/api/admin/*` 全部 `requireAdmin`。

完整契约以 `@power-wiki/shared/src/schemas.ts` 的 zod schema 为准,所有路由用 `*.parse()` 在响应边界二次校验(防 schema 漂移)。

## Auth(`/api/auth/*`,公开)

| Method | Path | 说明 |
|---|---|---|
| POST | `/sign-in` | body `{email,password}` → `Set-Cookie: pw_session` + `{user, mustResetPassword}` |
| POST | `/sign-out` | 清 cookie + 删 session |
| GET  | `/session` | 当前用户信息,401 表示未登录 |
| POST | `/reset-password` | body `{currentPassword,newPassword}`,需登录 |

## Pages(`/api/pages`)

普通用户自动按可见 space 过滤,admin 看全部。

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET    | `/` | 普通 | 按可见 space 过滤,admin 看全部;`?space=` 可选过滤单空间 |
| GET    | `/trash` | admin | 跨空间回收站(`?space=` 必填) |
| GET    | `/:id` | 普通 | 不可见 space 返 404(防越权猜测) |
| POST   | `/` | 普通 | body `{parentId?,title?,icon?,spaceId,...}`,`spaceId` 必填 |
| PATCH  | `/:id` | 普通 | body `{title?,contentJSON?,contentHTML?,icon?,starred?}` |
| PATCH  | `/:id/move` | 普通 | body `{newParentId,newOrder?}`,循环返 409 |
| POST   | `/:id/publish` | 普通 | body `{targetSpaceId}` → 201 + 新 `PageNode`(personal space → team space 的"发布到"语义:源页保留,新页标题自动加 `（来自 {userName} 的个人分享）` 后缀,源页只读于自己 personal space) |
| POST   | `/:id/duplicate` | 普通 | 同 sibling 组复制,标题前缀 `复制自`,新页落在源页正下方 |
| POST   | `/:id/restore` | admin | 恢复软删除页 |
| DELETE | `/:id` | 普通(soft) / admin(`?purge=true`) | 默认软删进回收站;`?purge=true` 硬删整棵子树 |
| GET    | `/:id/versions` | 普通 | 分页列表,DESC 排序,`?limit=20&offset=` |
| POST   | `/:id/versions/:vid/restore` | 普通 | 恢复历史版本,创建新 version + 更新 page content |
| POST   | `/:id/snapshots` | 普通 | 手动 / 边界快照入口,retention 30 行 |

## Spaces(`/api/spaces`)

普通用户。

| Method | Path | 说明 |
|---|---|---|
| GET | `/` | 当前用户可见 space 列表 |
| GET | `/:id` | 单个,不可见返 404 |

## Admin(`/api/admin/*`,全部 `requireAdmin`)

### Users

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表(`?limit=200`) |
| POST   | `/` | 建用户 |
| GET    | `/:id` | 单个 |
| PATCH  | `/:id` | 改基础字段 |
| POST   | `/:id/disable` | 禁用 + 清 sessions |
| POST   | `/:id/enable` | 启用 |
| POST   | `/:id/reset-password` | 重置初始密码 + 清 sessions |

### Groups

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表 |
| POST   | `/` | 建组 |
| GET    | `/:id` | 单个 |
| PATCH  | `/:id` | 改名等 |
| DELETE | `/:id` | 硬删(事务里先扫 `userGroupMembers` + `spaceGroupAccess`) |
| POST   | `/:id/members` | 加成员 |
| DELETE | `/:id/members/:userId` | 移成员 |

### Spaces

| Method | Path | 说明 |
|---|---|---|
| GET    | `/` | 全量列表 |
| POST   | `/` | 建 space |
| GET    | `/:id` | 单个 |
| PATCH  | `/:id` | 改基础字段 |
| DELETE | `/:id` | 硬删(事务里先扫 `spaceGroupAccess`) |
| PUT    | `/:id/access` | 整组替换 access |
| POST   | `/:id/access/:groupId` | 加一组 access |
| DELETE | `/:id/access/:groupId` | 删一组 access |

## 错误响应规范

```ts
// 单条错误
{ "error": "not_found" }
{ "error": "has_children" }      // 409,有未删子节点
{ "error": "parent_trashed" }    // 409,父页在回收站
{ "error": "personal_space_readonly" }  // 403,admin 写 personal space
```

每个具体 code 在前端 `apps/web/src/lib/api.ts` 的 `ApiError` 类里有映射,banner 文案在 stores 端组装。

## 跨视图共享数据

复杂聚合(成员数 / 空间页数等)走后端 `LEFT JOIN + GROUP BY + COUNT(*)`,不让前端为了拿一个 count 跑 `Promise.all(items.map(getDetail))`。详见 [loading-ux.md](./loading-ux.md)。