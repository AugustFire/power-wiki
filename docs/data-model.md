# Data Model

Drizzle schema、recursive CTE 模式、auth 设计、空间隔离、级联删除约定、附件元数据、评论 / 通知 / 标签表。

## Schema 概览

`apps/api/src/db/schema.ts` **12 张表**,**无外键约束**(所有表不写 `.references()`,所有 `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` 类的 DDL 都不写)。级联删除必须显式在路由里用 recursive CTE + 多步事务完成。migration 历史见 `apps/api/src/db/migrations/0000..0009`。

| 表 | 用途 | 引入 |
|---|---|---|
| `users` | 用户账号,argon2 哈希 + 状态 + 时间戳 | 0.4 |
| `sessions` | DB sessions,HTTP-only cookie | 0.4 |
| `user_groups` | 用户组 | 0.4 |
| `user_group_members` | 多对多 | 0.4 |
| `spaces` | 空间(`personal` / `shared`) | 0.5 |
| `space_group_access` | 空间对哪些组可见 | 0.5 |
| `pages` | 页面主表(`contentJSON` + `contentHTML` 双写) | 0.4 |
| `page_versions` | 版本历史(retention 30 行,边界快照 + restore) | 0.4 + 0.8 |
| `page_labels` | 页面标签(全局自由文本,Notion 风格,非 Confluence 命名空间) | 0.8 |
| `comments` | 评论 + 二级回复(顶 + replies) | 0.6 |
| `notifications` | 通知(mention / reply / comment_on_my_page) | 0.6 |
| `attachments` | 页面级附件元数据,S3 object 字节在 MinIO | 0.8 |

## 关键表字段

### `pages`

```ts
{
  id: string;              // nanoid(10),31 字符字母表(去掉 0/o/1/i/l)
  parentId: string | null; // null = 顶级
  spaceId: string;         // 必填,创建时校验;nullable at DB 层(migration safety)
  title: string;           // default DEFAULT_TITLE(共享常量)
  contentJson: jsonb;      // Tiptap JSON(default '{}')
  contentHtml: text;       // Tiptap HTML(ReadView 渲染,sanitize 后)
  icon: string | null;
  sortOrder: number;       // 同级排序,lower comes first
  createdAt: bigint;       // Date.now() ms
  updatedAt: bigint;
  authorId: string;        // free-form,可为 'me'(旧 seed)
  starred: boolean;        // metadata,**PATCH starred 不打 page_version**
  deletedAt: bigint | null;// 软删除时间,NULL = 正常
  deletedBy: string | null;
}
```

`contentJSON` + `contentHTML` 双写 —— JSON 给编辑器回填(避免重新解析 HTML),HTML 给 ReadView 渲染(避免 JSON → HTML 的开销 + 序列化风险)。

### `page_versions`

```ts
{
  id: string;
  pageId: string;          // No FK
  versionNumber: number;   // monotonic per-page(MAX+1 事务内算)
  title: string;           // editable fields 快照
  contentJson: jsonb;
  contentHtml: text;
  icon: string | null;
  editedBy: string;        // free-form(同 pages.authorId)
  editedAt: bigint;        // Date.now() ms
  changeNote: string | null; // restore 路径自动设 "restored from v{N}"
}
```

索引:`page_versions_page_idx(pageId, versionNumber)`(list 路径)+ `page_versions_page_version_uq(pageId, versionNumber)`(并发 PATCH 的并发保护)。**starred-only PATCH 不写这一行**(metadata,不是 content)。

### `page_labels`

```ts
{
  pageId: string;          // No FK
  label: string;           // lowercase + trim + ≤32 字符,服务端 normalize
  authorId: string;        // free-form
  createdAt: bigint;
}
```

**复合 PK = (pageId, label)** —— 同 label 重复加 idempotent。索引 `page_labels_label_idx`(`/api/labels/search` 走这里)。**作用域全局**:同一个 `工程` label 可挂在多个 team space 的页面上,搜索 JOIN 用户可见 pages 过滤;不像 Confluence 有 namespace 隔离。

### `comments`

```ts
{
  id: string;
  pageId: string;          // No FK
  parentId: string | null; // null = 顶,replies 只挂顶,**v0 最大嵌套深度 = 2**
  authorId: string;        // free-form
  contentMd: string;       // markdown body
  contentText: string;     // markdown-stripped 快照(通知预览直接用)
  mentionedUserIds: jsonb; // text[],通知 fan-out 唯一来源,last-write-wins(v0 接受)
  isEdited: boolean;       // PATCH 后 true
  editedAt: bigint | null;
  createdAt: bigint;
  updatedAt: bigint;
  deletedAt: bigint | null;// 软删除(author 或 admin),deletedBy 记录谁
  deletedBy: string | null;
}
```

索引 4 条:`comments_page_idx(pageId, createdAt)` / `comments_parent_idx(parentId)` / `comments_author_idx(authorId)` / `comments_page_live_idx(pageId, deletedAt)`(list 路径过滤 live 行)。

### `notifications`

```ts
{
  id: string;
  userId: string;          // 收件人,**私域**,不暴露给别人
  actorId: string;         // 触发人(LEFT JOIN users 拿 actorName)
  kind: 'mention' | 'reply' | 'comment_on_my_page';
  pageId: string;          // 落地目标,/p/{pageId}#comment-{commentId}
  pageTitle: string | null;// 触发时的标题快照(后续页面改名不追溯)
  commentId: string | null;
  mentionUserId: string | null; // 仅 kind='mention' 有
  isRead: boolean;        // default false
  readAt: bigint | null;
  createdAt: bigint;
}
```

索引 3 条:`notifications_user_unread_idx(userId, isRead, createdAt)`(bell 红点 hot path)+ `notifications_user_created_idx(userId, createdAt)`(列表 hot path)+ `notifications_page_idx(pageId)`(page purge cascade)。**只看自己的**(`WHERE user_id=me.id`,无 admin bypass)。

### `attachments`

```ts
{
  id: string;              // nanoid(12),也是 S3 object key 第二段
  pageId: string;          // No FK
  uploaderId: string;      // No FK
  originalFilename: string; // ≤255 字符,展示用
  storageKey: string;      // 格式 {page_id}/{id}{ext}
  mimeType: string;        // ALLOWED_MIME_TYPES 之一
  sizeBytes: number;       // HeadObject 写入,不信前端 size
  kind: 'image' | 'file';  // 决定编辑器 / read view 渲染 image 节点还是 file 卡片
  createdAt: bigint;       // Date.now() ms
}
```

**字节存 MinIO,DB 只存元数据**。S3 object 删除是 best-effort(DB 是事实来源,orphan 对象容忍)。索引 2 条:`attachments_page_idx(pageId, createdAt)` + `attachments_uploader_idx(uploaderId)`。

## Recursive CTE 模式

**没有 FK CASCADE**,所有层级删除 / 移动必须显式用 recursive CTE 一次拿全。

### 移动循环保护

`apps/api/src/lib/ids.ts` 的 `isDescendantOrSelf(parentId, candidateChildId)`:

```sql
WITH RECURSIVE subtree AS (
  SELECT id FROM pages WHERE id = $1
  UNION ALL
  SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
)
SELECT 1 FROM subtree WHERE id = $2 LIMIT 1;
```

如果新父节点是当前节点的子孙 → 返 409 `cycle`。同文件还有 `getPageSubtree(rootId)` —— page purge 时返回整棵子树的 id 列表(配套 `pages.ts` DELETE 用)。

### 级联硬删

`pages.ts` DELETE `?purge=true` 走 multi-table recursive CTE,事务内三步清理(顺序重要,FK 反模式不存在所以**没有** FK 错误):

```sql
-- Step 1: 拿子树
WITH RECURSIVE subtree AS (
  SELECT id FROM pages WHERE id = $1
  UNION ALL
  SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
)
DELETE FROM notifications WHERE page_id IN (SELECT id FROM subtree);
DELETE FROM comments     WHERE page_id IN (SELECT id FROM subtree);
DELETE FROM attachments  WHERE page_id IN (SELECT id FROM subtree);
DELETE FROM page_labels  WHERE page_id IN (SELECT id FROM subtree);
DELETE FROM page_versions WHERE page_id IN (SELECT id FROM subtree);
DELETE FROM pages        WHERE id       IN (SELECT id FROM subtree);
```

S3 对象在事务外 best-effort `deleteObject`(失败仅日志,orphan 容忍)。

类似模式:
- `adminGroups.ts` DELETE → 事务里先扫 `userGroupMembers` + `spaceGroupAccess` 清理
- `adminSpaces.ts` DELETE → 事务里先扫 `spaceGroupAccess` + 同样五张 page-relation 表(无 pages 自分支因为 space 下可能有 page,但 page 自身有 spaceId,空间删除得先把 pages 移走或一起删)
- `adminUsers.ts` disable / reset-password → 先调 `killSessionsForUser` 清 sessions

### 可见空间过滤

`apps/api/src/lib/accessibleSpaceIds.ts` 根据 userId 查可见 space id 列表:

```sql
SELECT s.id
FROM spaces s
JOIN space_group_access sga ON sga.space_id = s.id
JOIN user_group_members ugm ON ugm.group_id = sga.group_id
WHERE ugm.user_id = $1
```

admin 自动看全部,所以 `routes/pages.ts` 的 list 走两路:admin 不 join,普通用户 join。`canAccessSpace(userId, spaceId)` 是单点 O(1) 检查(看 spaceId 是否在结果集里)。

## 软删除 + 回收站(全表统一模式)

**所有可软删的表都遵循 `deletedAt IS NULL` = 正常,`IS NOT NULL` = 软删** 这个语义:

- `pages.deletedAt` / `pages.deletedBy` —— 回收站(详见 [docs/architecture.md](./architecture.md))
- `comments.deletedAt` / `comments.deletedBy` —— author 或 admin 可软删;行保留让已发出的通知不丢锚点(UI 降级为 page-level 链接)

后端 list 已过滤,前端 `getTree()` 也再过一道 `p.deletedAt == null`(兜底,乐观更新 `softDeletePage` 在响应回来前会有 deletedAt != null 的行短暂存在)。

## Auth 设计

**自研薄 auth**(不引 third-party):

- 密码哈希:`@node-rs/argon2`(argon2id)
- Sessions:`sessions` 表 + HTTP-only cookie(`pw_session`, `SameSite=Lax`, 30 天固定过期)
- 启动时 `purgeExpiredSessions` 自动清理过期
- `auth/session.ts` 的 `killSessionsForUser(userId)` 在 admin 禁用 / 重置密码时清空该用户所有 session
- 三态登录:`active` / `disabled` / `must_reset_password`,新用户首次登录强制改密

中间件:
- `requireAuth` → 没 cookie 或 session 失效返 401
- `requireAdmin` → user.role !== 'admin' 返 403
- `assertAdminNotWritingPersonalSpace(c, me, targetSpaceId)` → 写路径(POST / PATCH / PATCH-move / DELETE-soft)的最后一道 guard

## Personal Space 自动初始化

`apps/api/src/lib/ensurePersonalSpace.ts`:

首次登录(以及 bootstrap 启动时给每个用户跑一遍):

1. 建 personal space(kind='personal')
2. 建 `pg-<userId>` 组(只有该用户一个成员)
3. 给 personal space 授权给该组
4. 复制一份欢迎页模板到该 space —— 标题 `欢迎来到 ${userName} 的个人空间`,内容是 Tiptap doc 树 + 匹配的 HTML(HTML 是 canonical 渲染,ReadView 走 v-html)

这一套在 `db/bootstrap.ts` 启动期 + `auth.ts` 路由的「首次 sign-in」两个时机各跑一遍。

## Admin 写保护

`apps/api/src/lib/personalSpaceGuard.ts` 的核心函数:

```ts
async function assertAdminNotWritingPersonalSpace(
  c: Context,
  me: AuthenticatedUser,
  targetSpaceId: string | null,
): Promise<Response | null>
```

- 3 个参数(Hono context + 当前用户 + 目标 spaceId)
- 非 admin / 没 targetSpaceId → 返 null(caller 继续)
- admin + `spaces.kind === 'personal'` → 返 403 `personal_space_readonly`(caller 直接 `return c.json(...)`)
- 同文件 `getSpaceKind(spaceId)` 拿 kind,O(1) 单行查

写路径在 `pages.ts` 的 POST / PATCH / PATCH-move / DELETE-soft 都调这个 guard。Confluence Cloud 默认语义:admin 是 supervisor 不是 editor。

## Index 策略

实际建好的索引(只列业务 hot path,PK 不计):

| 索引 | 用途 |
|---|---|
| `pages(parentId)` | 子页查询(树懒加载) |
| `pages(parentId, sortOrder)` | 同级排序(拖拽) |
| `pages(spaceId)` | 按 space 过滤 |
| `pages(spaceId, deletedAt)` | 回收站 partial-ish 过滤 |
| `page_versions(pageId, versionNumber)` | 历史 list(DESC) |
| `page_versions(pageId, versionNumber)` UNIQUE | 并发 PATCH 保护 |
| `page_labels(label)` | 标签搜索 hot path |
| `comments(pageId, createdAt)` | 评论 list |
| `comments(parentId)` | replies 关联 |
| `comments(authorId)` | 用户维度查询 |
| `comments(pageId, deletedAt)` | live 行过滤 |
| `notifications(userId, isRead, createdAt)` | bell 红点 hot path |
| `notifications(userId, createdAt)` | 通知 list |
| `notifications(pageId)` | page purge cascade |
| `attachments(pageId, createdAt)` | 附件 list |
| `attachments(uploaderId)` | 用户维度查询 |
| `user_group_members(userId, groupId)` | 复合 PK |
| `space_group_access(spaceId, groupId)` | 复合 PK |
| `sessions(userId)` | kill-sessions |

具体 DDL 走 `pnpm -F api db:generate` 生成迁移,不要手写。新增索引必须同步 `apps/api/src/db/schema.ts` 的 JSDoc **和** 迁移里的 `COMMENT ON INDEX`(见 [CLAUDE.md 硬约束](../CLAUDE.md))。
