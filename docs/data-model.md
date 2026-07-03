# Data Model

Drizzle schema、recursive CTE 模式、auth 设计、空间隔离、级联删除约定。

## Schema 概览

`apps/api/src/db/schema.ts` 7 张表,**无外键约束**(所有表不写 `.references()`,所有 `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` 类的 DDL 都不写)。级联删除必须显式在路由里用 recursive CTE 完成。

| 表 | 用途 |
|---|---|
| `users` | 用户账号,argon2 哈希 + 状态 + 时间戳 |
| `sessions` | DB sessions,HTTP-only cookie |
| `user_groups` | 用户组 |
| `user_group_members` | 多对多 |
| `spaces` | 空间(`personal` / `shared`) |
| `space_group_access` | 空间对哪些组可见 |
| `pages` | 页面主表(contentJSON + contentHTML 双写) |
| `page_versions` | 版本历史(retention 30 行,自动快照 + restore) |

## Pages 表关键字段

```ts
{
  id: string;              // nanoid(10),31 字符字母表(去掉 0/o/1/i/l)
  parentId: string | null; // null = 顶级
  spaceId: string;         // 必填,创建时校验
  title: string;
  contentJSON: jsonb;      // Tiptap JSON 序列化(回填到编辑器)
  contentHTML: text;       // Tiptap HTML(ReadView 渲染,sanitize 后)
  icon: string | null;
  order: number;           // 同级排序
  createdAt: bigint;       // Date.now() ms
  updatedAt: bigint;
  authorId: string;
  starred: boolean;
  deletedAt: bigint | null;// 软删除时间,NULL = 正常
  deletedBy: string | null;
}
```

`contentJSON` + `contentHTML` 双写 —— JSON 给编辑器回填(避免重新解析 HTML),HTML 给 ReadView 渲染(避免 JSON → HTML 的开销 + 序列化风险)。

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

如果新父节点是当前节点的子孙 → 返 409 cycle。

### 级联硬删

`pages.ts` DELETE `?purge=true` 走 recursive CTE 一次删完整子树:

```sql
WITH RECURSIVE subtree AS (
  SELECT id FROM pages WHERE id = $1
  UNION ALL
  SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
)
DELETE FROM pages WHERE id IN (SELECT id FROM subtree);
```

类似模式在:
- `adminGroups.ts` DELETE → 事务里先扫 `userGroupMembers` + `spaceGroupAccess` 清理
- `adminSpaces.ts` DELETE → 事务里先扫 `spaceGroupAccess` 清理
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

admin 自动看全部,所以 `routes/pages.ts` 的 list 走两路:admin 不 join,普通用户 join。

## 软删除 + 回收站

`pages.deletedAt IS NULL` = 正常,`IS NOT NULL` = 软删。`pages.list()` 自动过滤,`pages.trash` 是 admin 专属。

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

## Personal Space 自动初始化

`apps/api/src/lib/ensurePersonalSpace.ts`:

首次登录(以及 bootstrap 启动时给每个用户跑一遍):

1. 建 personal space(kind='personal')
2. 建 `pg-<userId>` 组(只有该用户一个成员)
3. 给 personal space 授权给该组
4. 复制一份欢迎页模板到该 space(标题:「欢迎使用 power-wiki」)

这一套在 `db/bootstrap.ts` 启动期 + `auth.ts` 路由的「首次 sign-in」两个时机各跑一遍。

## Admin 写保护

`apps/api/src/lib/personalSpaceGuard.ts`:`assertAdminNotWritingPersonalSpace(user, page)` —— admin 能看任何人的 personal space 页,但写(POST/PATCH/DELETE)personal space 一律 403 `personal_space_readonly`。

理由:personal space 是用户私人草稿区,admin 不应越权改;硬拦在 server 层比前端过滤可靠。

## Index 策略

- `pages(spaceId, deletedAt, parentId, order)` —— 树查询、可见过滤、软删过滤都用
- `pages(deletedAt) WHERE deleted_at IS NOT NULL` —— partial index,回收站查询
- `user_group_members(userId, groupId)` —— 复合主键
- `space_group_access(spaceId, groupId)` —— 复合主键
- `sessions(userId)` —— kill-sessions 用

具体 DDL 走 `pnpm -F api db:generate` 生成迁移,不要手写。