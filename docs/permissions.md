# 权限模型

power-wiki 的权限是什么、谁能做什么、为什么这样设计。

> **两分钟搞明白「谁可以做什么」** → [能力速查](#能力速查)
>
> **想搞清楚为什么这套规则是这样的、改它会动到哪** → [技术参考](#技术参考)

涵盖 4 个 Phase 落地后的全部行为:**A** 空间角色分层(viewer / editor / admin)、**B** 页面级限制(view / edit)、**C** 变更审计日志、**D** 公开链接分享。代码事实来源是 `apps/api/src/lib/permissions.ts` —— 这里所有「✅ / ❌」都对应那里的判定逻辑。

---

## 目录

### 上半:人话(产品 / 设计 / 运营 / 新来的开发)

1. [能力速查](#能力速查) — 单一表格扫完所有角色 × 所有能力
2. [角色是什么](#角色是什么) — 每种身份的来龙去脉
3. [三个容易踩的不对称](#三个容易踩的不对称) — 用之前必须知道
4. [页面级权限怎么算](#页面级权限怎么算) — view / edit 限制怎么传、谁管
5. [公开链接分享](#公开链接分享) — 内部分享 + 外部分享
6. [审计:谁动了什么](#审计谁动了什么) — 改动追溯
7. [UI 里能看到哪些入口](#ui-里能看到哪些入口) — 按钮 / 菜单显隐

### 下半:技术参考(改代码必读)

8. [权限解析算法](#权限解析算法) — `effectiveSpaceRole` / `canReadPage` / `canEditPage`
9. [ER 图与表](#er-图与表) — `space_role_grants` / `page_restrictions` / `page_public_shares` / `permission_audit`
10. [关键 UI gate(代码级)](#关键-ui-gate代码级) — `.vue` 里 `computed` / `v-if` 锚点
11. [边界场景 FAQ](#边界场景-faq) — 8 个真有人问过的 case
12. [实现位置索引](#实现位置索引) — 文件路径速查
13. [错误码参考](#错误码参考) — `humanizeApiError` 映射

---

# 上半:人话

## 能力速查

这张表是整个文档最重要的部分 —— 6 种身份 × 25 项能力,所有权限问题先在这里查。

### 阅读约定

- ✅ **可以**
- ❌ **不可以**(一般是 404,防止空间存在性被探测)
- ✅\*** 有条件地可以(脚注解释)
- — **不适用**(这一身份本来就不会出现在这个场景)

### 6 种身份速认

| 身份 | 怎么来的 | 一句话概括 |
|---|---|---|
| **全局 admin** | `users.role = 'admin'`(系统级) | 超级管理员,**任何** shared space 都有全权;唯一能管平台层资源(改空间名、删空间、看审计) |
| **space-admin** | 该 space 上被显式 / 隐式授予 `role='admin'` | 空间管理员,**本空间**的事全权(管成员、改权限、改空间名/描述/颜色),但**不能**删空间、看不到审计、管不了用户组 |
| **space-editor** | 该 space 上有 `role='editor'` | 空间编辑者,读写内容 + 分享 + 设限制,**不能**管成员 |
| **space-viewer** | 该 space 上有 `role='viewer'` | 空间浏览者,只读,但能点赞、关注、发评论 |
| **页作者** | `pages.authorId = me.id`(与空间角色正交) | 自己写的页面,view / edit 限制都不挡;share / 编辑都行 |
| **Anonymous** | 未登录 + 命中 `share token`(`/api/public/pages/:token`) | 纯只读,只能看被分享的那一页(连兄弟页都看不到) |

### 能力矩阵

| 能力 | 全局 admin | space-admin | space-editor | space-viewer | 页作者 | 匿名 + token |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **读** | | | | | | |
| 读 shared space 内所有页面 | ✅ | ✅ | ✅ | ✅ | ✅¹ | — |
| 读 personal space 内容(监督 / 合规) | ✅² | — | — | — | — | — |
| 看公开分享页(命中 token) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **写页面内容** | | | | | | |
| 创建 / 编辑 / 软删 shared space 内页 | ✅ | ✅ | ✅ | ❌ | ✅³ | ❌ |
| 创建 / 编辑 / 软删 *自己写的* 页(其他 space) | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| 创建 / 编辑 personal space 页 | ❌ ⁴ | — | — | — | ✅ (owner) | — |
| Permanent delete(`?purge=true`) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **写附属物** | | | | | | |
| 传 / 删附件,改 labels | ✅ | ✅ | ✅ | ❌ | ✅³ | ❌ |
| 打 page version snapshot / restore | ✅ | ✅ | ✅ | ❌ | ✅³ | ❌ |
| **评论** | | | | | | |
| 发评论(view-semantic,任何能读的都能发) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 改自己 / 删自己评论 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 改他人 / 删他人评论 | ✅ | ✅⁵ | ❌ | ❌ | ❌ | ❌ |
| 改自己 / 删自己的回复 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **互动** | | | | | | |
| 点赞 / 关注 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **页面级权限限制** | | | | | | |
| 改 view / edit 限制(`⋯` → 限制) | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| **公开链接分享** | | | | | | |
| 创建 share 链接 | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| 撤销 / 列出 share | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| **空间管理**(成员角色 + 元信息) | | | | | | |
| 管空间成员(viewer / editor / admin 授权) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 改空间基本信息(名 / 描述 / 颜色 / 图标) | ✅ | ✅⁶ | ❌ | ❌ | ❌ | ❌ |
| 删除空间 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 创建 / 删除 / 重命名用户组 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 创建新空间 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **系统层** | | | | | | |
| 看 / 导出审计日志 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 看 / 还原回收站(trash) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

**脚注**

¹ 页作者在 *自己写的* 所有页上,view / edit 限制都不挡,跟空间角色无关。
² admin 读 personal space 内容受 `assertAdminNotWritingPersonalSpace` 只挡写不挡读 —— 监督 / 合规查需要。
³ 页作者对自己写的页面有完整权限(读、写、share、限制、版本),跟他在哪个 space、有没有角色无关。
⁴ `assertAdminNotWritingPersonalSpace` 拦 global admin 在 personal space 上的写(403 `personal_space_readonly`)。personal space 只 owner 能写。
⁵ 删他人评论需要 `canEditPage`;这跟空间 admin 角色(space-admin)无关,纯粹是「你能不能编辑这个页面」。
⁶ space-admin 改空间基本信息**仅限 shared space**(personal space 走 `assertAdminNotWritingPersonalSpace` 写保护,owner-only)。改动通过 `PATCH /api/spaces/:id`,`kind !== 'shared'` 直接 404。

---

## 角色是什么

按「能力↑ 责任↑」的顺序排列。每种角色都有最朴素的一句话身份:

```
全局 admin           平台所有者 + 任何空间的全权管理员
  ↓
space-admin          某一个 shared space 的管理员
  ↓
space-editor         某一个 shared space 的贡献者
  ↓
space-viewer         某一个 shared space 的读者
  ↓
页作者               自己写的页面(独立于空间角色)
  ↓
Anonymous            命中 share token 的未登录访客
```

### 全局 admin(`users.role = 'admin'`)

- **范围**:整个系统任意 shared space,personal space 受 `assertAdminNotWritingPersonalSpace` 写保护(只读)。
- **来由**:user 行上的 `role` 字段(`admin` / `user`)。**这条不能被任何空间授权动作覆盖** —— 全局身份靠 user row,不是 space_role_grants。
- **能做什么别人做不了的**:删空间 / 看审计 / 管用户组 / 新建 space / 改 personal space 元信息(personal space 写保护只挡 admin,空间级 metadata 写保护 user 级才挡)。

### space-admin / space-editor / space-viewer

由 **三选一** 的方式拿到角色:

1. **直接授权(user grant)**:`space_role_grants WHERE principal_kind='user' AND principal_id=me.id`,把一个具体用户钉成 viewer / editor / admin。
2. **组授权(group grant)**:`space_role_grants WHERE principal_kind='group' AND principal_id IN (用户的组)` —— 用户 *任意一个所属组* 拿到该角色即生效。
3. **legacy `space_group_access`**:Phase A.5 之前的旧格式,视为 `editor`(最宽松)。Phase A.5 起,通过新权限页对该 group 授权时,**就地迁到** `space_role_grants role='editor'` 并 DELETE 旧行。

- **取最大角色**:`editor + viewer` 两个 grant 落到同一用户 → effective = `editor`(`MAX(rank)`)。UNIQUE 索引挡同组 / 同人重复写入。
- **不变式**:`role='admin'` **不能** 授给组(只能授给具体用户)—— 避免「哪个组员做了 admin 动作」审计不清。
- **不变式**:personal space 一定至少有一个 user-grant admin(典型是 owner 本身);试图把最后一个 user-admin 移除 → 409 `cannot_remove_last_admin`。

### 页作者(`pages.authorId = me.id`)

- **独立性**:跟空间角色正交。哪怕用户在 A space 只有 viewer,他在 A space 自己写的页面上仍然有 *编辑 / share / 改限制* 全权。
- **不变式**:view / edit 限制 **不挡** 作者本人(Confluence 默认行为)。如果用户 A 写了页 X,后来 A 在 space 里降成 viewer,他写的 X 上 view 限制仍不挡他 —— A 还是作者。
- **没保护**:如果你把页 X 的作者改成别人,前作者就 *不是* 作者了,view / edit 限制重新挡他。

### Anonymous(匿名 + share token)

- **唯一的访问通路**:`GET /api/public/pages/:token`,挂在 `requireAuth` **之前**;命不中 → 404。
- **权限极窄**:只能看 *那一页*,不返兄弟页、不返兄弟子树、不带 cookie、不需要登录。
- **不变式**:
  - page 必须在 `kind='shared'` 空间(personal space 永不可分享 → 创建 share 时 400 `share_forbidden`)。
  - page 必须 **没有** view restriction(否则「公开」就绕过了 view 限制,创建时也 400 `share_forbidden`)。
  - sha256(token) 命中 / 未撤销 / 未过期 / 未被 `?purge=true` 删。
- **明文 token 一次性给**:`POST /api/pages/:id/share` 返回明文一次,**DB 只存 sha256 hex**(即使 DB 泄漏也不会暴露活 token)。

---

## 三个容易踩的不对称

这套权限最容易被绕的几个点:

### 1. **`space-admin` ≠ `全局 admin`**

space-admin 是 *空间级* 管理员,对本空间管成员、改权限、**改**空间元信息(名 / 描述 / 颜色 / 图标,**仅限 shared space**)。**删不掉**空间,**看不了**审计日志,**管不了**用户组 / 新建 space。这三件事只有全局 admin 能做。

**踩坑模式**:「我是这个空间的 owner,改个空间名怎么不行?」—— 改空间名走 `PATCH /api/spaces/:id`,`requireSpaceAdmin`-style 门(全局 admin OR `canAdminSpace`)。space-admin 通过这条路径即可改名。删除 / 审计 / 用户组 / 新建 space 走 `requireAdmin`,space-admin 不通过,得找全局 admin。

### 2. **`role='admin'` 不能授给组**

试图 `POST /api/spaces/:id/permissions/groups/:gid` body `{role: 'admin'}` → 400 `admin_role_to_group`。

**为什么**:Confluence 也不允许,审计里写「alice 做了 admin 动作」清楚,写「工程组做了 admin 动作」需要去查组里当时都有谁 —— 责任不清。

**绕路**:给具体用户授 admin;组天然只能是 viewer / editor(很多空间核心需求都够用)。

### 3. **personal space 是 owner-only**

`assertAdminNotWritingPersonalSpace` 拦全局 admin 在 personal space 上的写操作 → 403 `personal_space_readonly`。personal space 的 *写* 只有 owner 本人有,即使全局 admin 也不行。

- **读不受限**:全局 admin 永远能 *读* 任何 personal space(监督、合规)。
- **restore 回收站例外**:回收站治理走 admin-only 路径,绕过 personal 守卫。

### 4.(附赠)页作者身份是跟空间角色 *正交* 的

哪怕用户被降成 viewer / 被踢出 space,他 *自己写的页面* 上仍然有完整权限,view / edit 限制都不挡。这是 Confluence 的设计 —— "你写的内容还是你的"。

---

## 页面级权限怎么算

页面有两种限制:**view** 和 **edit**。结构一样,**继承规则不一样**。

### 形态:`(principal_kind, principal_id) → 在不在 list 里`

- `principal_kind = 'user'` + `principal_id = alice.id` → Alice 在不在 view/edit 限制的允许名单里
- `principal_kind = 'group'` + `principal_id = eng_group.id` → 工程组成员在不在

`isInAllowList(user, myGroups, list)`:user 直接命中,或 *所属任一 group* 命中,就 true。

### 反 default-deny

`page_restrictions WHERE kind='view'` 有行 = **限制生效**。非列表内主体一律拒绝(404,不返 403 防探测)。

### **view 沿父链 BFS 继承**(Confluence 标准)

```
看页面 X:
  X 自己有 view 限制 → 必须满足 X 的 view allow-list
  否则 X 没限制,上溯到父页 X.parent:
    父页有 view 限制 → 必须满足父页 view allow-list
    否则继续上溯
  直到根还没限制 → 回退 canReadSpace(看你在该空间有没有 read 角色)
```

**实战结论**:在父页加了 view 限制,所有后代子页都默认收紧。要"完全保密"某个子页,在子页自身也加 view 限制。

**已知局限**(v0):`pageReadableDirectFilter`(侧栏树的 SQL `WHERE`)不沿父链 BFS —— 理论上受限子页在侧栏看见、点开后 404。后续优化:denormalized 父链 view-inheritance JSONB 列 + trigger,把 BFS 收进 SQL。

### **edit 不继承**(Confluence 标准)

只看本页。父页 edit 限制不影响子页。

**为什么这样设计**:大多数团队的实际场景是"父页公开给团队所有人,某几个子页只让核心组改" —— 继承反着需求。

### 作者本人 + 全局 admin 都短路返回 true

author / admin:view / edit 限制都不挡。

### 谁管页面限制(谁有「⋯ → 限制」按钮)

`canEditPage` 即可,意味着:

- 全局 admin ✅
- space-admin / space-editor ✅(只要他 *本身能读到那个页面*,因为 `canEditPage` 蕴含 `canReadPage`)
- space-viewer ❌
- 页作者 ✅
- Anonymous ❌

### 谁管 view(子页受限意味着看不到)

view 限制 *必须* 让管理员能编辑 —— 但 `canEditPage` 已经蕴含 `canReadPage`,所以条件等价。能进 = 能管。

---

## 公开链接分享

### 创建(POST `/api/pages/:id/share`)

谁能创:
- 全局 admin / space-admin / space-editor / 页作者 ✅(条件:`canEditPage`,与编辑同权限)
- space-viewer ❌ → 404(避免探测)
- Anonymous ❌

前置校验:
- 空间必须是 `kind='shared'`(personal space → 400 `share_forbidden`)
- 页面 *不能* 有 view 限制(否则"公开"绕过 view 限制 → 400 `share_forbidden`)
- 页面必须在主目录(`deleted_at IS NULL` → 回收站里也不让 share)

返回:`{ id, token: '<明文 31 字符 nanoid>', url: '/public/pages/<token>', expiresAt }`。**明文 token 仅此一次出现在响应里**,DB 只存 `sha256(token)`。

### 读取(GET `/api/public/pages/:token`,**无需 auth**)

校验链:
1. `sha256(input) == token_hash`
2. `revoked_at IS NULL`
3. `expires_at IS NULL OR > now`
4. `page.deleted_at IS NULL`
5. `space.kind = 'shared'`

任一失败 → 404(`share_invalid` / `share_revoked` / `share_expired` / `share_forbidden`)。响应体跟登录用户的 ReadView **同形**,只是少了 authorEmail 等敏感字段。

`Cache-Control: public, max-age=60`,命中后 fire-and-forget 更新 `last_accessed_at`。

### 撤销(DELETE `/api/pages/:id/share/:tokenId`)

谁能撤:跟创建同权限(`canEditPage` + space-admin)。撤销后 GET 返 404。**不级联 audit 行**(审计 append-only)。

### 为什么 `expire` 用大整数时间戳而不是 `expires_at` 列

`page_public_shares.expires_at bigint` 存毫秒;`expires_at IS NULL` = 永不过期。客户端用 `{expiresInDays: null|7|30}` 三档(detail 见 Phase D 设计)。

---

## 审计:谁动了什么

每次权限变更,*同事务* 写一条 `permission_audit` 行。append-only,无 UPDATE / DELETE 入口。

### 8 类事件

| kind | 触发端点 |
|---|---|
| `space_grant_set` | `PUT /api/spaces/:id/permissions`(full-replace) |
| `space_grant_add` | `POST .../permissions/{groups\|users}/:id`(单条追加) |
| `space_grant_remove` | `DELETE .../permissions/{groups\|users}/:id` |
| `page_restriction_set` | `PUT /api/pages/:id/restrictions` |
| `page_restriction_add` / `_remove` | `POST` / `DELETE` 单条 |
| `page_share_create` | `POST /api/pages/:id/share` |
| `page_share_revoke` | `DELETE /api/pages/:id/share/:tokenId` |

### payload 形态

```json
{
  "kind": "space_grant_add",
  "actorId": "alice_id",
  "targetKind": "space",
  "targetId": "space_xxx",
  "before": { "role": "editor" },
  "after":  { "role": "admin" }
}
```

### 谁看

`GET /api/admin/audit`:**全局 admin only**(`adminAuditRouter` 挂 `requireAdmin`)。UI 在 `/manager/audit`,看到的是按 `created_at DESC` 排序的列表 + actor / target / diff 过滤 + CSV 导出。

**事务回滚时不写入**(关键 invariant):tx rollback → audit 行不在,这是 `recordPermissionAudit(tx, ...)` 强制把 `tx` 当形参而非 connection 的原因 —— lint 看得见。

---

## UI 里能看到哪些入口

每个 UI 点的显示条件,跟后端 gate 对齐。改 UI 时**先确认后端 gate** 再改前端,反过来可能引入"按钮在但点了 404"。

每个 UI 点的显示条件,跟后端 gate 对齐。改 UI 时**先确认后端 gate** 再改前端,反过来可能引入"按钮在但点了 404"。

| UI 点 | 位置 | 显示条件 | 后端 gate |
|---|---|---|---|
| 「编辑」按钮(subheader) | `ReadView.vue` | admin OR 空间角色 ≥ editor OR 页作者 | `canEditPage` |
| 「⋯」菜单 | `ReadView.vue` | 永远(只有 items 受权限) | — |
| 「⋯」→「限制」菜单项 | `ReadView.vue` | 同「编辑」(`canEditPage`) | `canEditPage` |
| 「⋯」→「分享」菜单项 | `ReadView.vue` | 同「编辑」 + 非 personal + 无 view 限制 | `canEditPage` + `!isPersonal` + `!hasViewRestriction` |
| 「⋯」→「历史」子菜单 | `ReadView.vue` | 永远(数据本身按权限过滤) | 通过 `canReadPage` 加载 |
| 编辑器 mount 重定向 | `EditView.vue` | `canEditPage` 不通过 → `router.replace('/p/:id?readonly=1')` | `canEditPage` |
| 「新建子页面」 | `ReadView.vue` | 同「编辑」 | `canEditPage` |
| 「+」在 PageTree 子节点上 | `PageTree.vue` | 同「编辑」 | `canEditPage` |
| HomeView 「新建页面」CTA | `HomeView.vue` | `canCreateInSpace`(`viewerRole` ≥ editor OR 作者) | `canCreateInSpace` |
| Sidebar 底部「创建页面」/「导入 MD」 | `Sidebar.vue` | 同上;不满足显示 `readonly-badge` 占位 | `canCreateInSpace` |
| 「关注」「点赞」 | `ReadView.vue` | `canReadPage` | `canReadPage` |
| 「⋯」→「添加评论」 | `ReadView.vue` | `canReadPage` | `canReadPage` |
| UserMenu 「管理后台」入口 | `UserMenu.vue:202` | `authStore.isAdmin` | `requireAdmin`(`adminXxxRouter`) |
| `/spaces/:id`(SpaceEditView) | `SpaceEditView.vue` | 全局 admin OR space-admin(顶层 `meta.requiresAuth`,组件内部分 section gate) | `isAdmin OR canAdminSpace` |
| `SpaceEditView` 基本信息(name / desc / color / icon) | `SpaceEditView.vue` | 全局 admin OR space-admin(组件内 v-if,`canEditMetadata`) | `PATCH /api/spaces/:id`(`isAdmin OR canAdminSpace`,`kind === 'shared'`) |
| `SpaceEditView` 访问控制(用户组 + 个人 两栏) | `SpaceEditView.vue` | 全局 admin OR space-admin | `isAdmin OR canAdminSpace` |
| `SpaceEditView` 危险操作「删除空间」 | `SpaceEditView.vue` | 全局 admin only(组件内 v-if) | `requireAdmin` |
| Sidebar 「管理空间」icon 按钮 | `Sidebar.vue` | `canAdminActiveSpace`(全局 admin OR `s.viewerRole === 'admin'`) | `isAdmin OR canAdminSpace` |
| `/manager/audit` 审计日志 | `AuditView.vue` | 全局 admin(403 时显示 "没有权限") | `requireAdmin` |
| `/manager/*` 整个管理后台 | `ManagerLayout` | 全局 admin(`meta.requiresAdmin`) | `requireAdmin` |
| 公开分享页访问 | `PublicPageView` | token 命中(无 auth) | `tokenHash` match + 未撤销 + 未过期 |
| `/manager/spaces/:id`(旧路径兼容) | redirect → `/spaces/:id` | 进入后跳新路径(书签兼容) | — |

> ✅ **v0.7 落地**:`/spaces/:id` 顶层路由(`meta.requiresAuth` only,无 `requiresAdmin`)。组件按身份切 section 显示:
>
> - 全局 admin:看全功能 — 基本信息表单(name / desc / 颜色 / 图标)+ 访问控制 + 危险操作(删除空间)
> - space-admin:看基本信息表单(name / desc / 颜色 / 图标,**仅 shared space**)+ 访问控制;**危险操作始终隐藏**(删除走 `/api/admin/spaces/:id`,`requireAdmin` 兜底)
>
> 保存路径也分流:
>
> - admin:`PATCH /api/admin/spaces/:id`(旧入口,契约不变)
> - space-admin:`PATCH /api/spaces/:id`(新入口,`isAdmin OR canAdminSpace` + `kind === 'shared'`,失败统一 404)
>
> 两个 endpoint 共用 `apps/api/src/lib/spaceMetadata.ts` 的 `updateSpaceMetadata` helper,字段语义统一(`description` / `icon` 显式 `null` 清空,`name` 仅 trim)。
>
> 数据加载也分流:
>
> - admin 路径:`api.admin.spaces.get` + `api.admin.groups.list` + `api.admin.users.list`
> - space-admin 路径:`api.spaces.get`(非 admin)+ 新接口 `api.spaces/:id/permissions/candidates`(非 admin)
>
> 后端 `/api/spaces/:id/permissions/candidates`(Phase 加在 `spacePermissions.ts`)独立提供了"可选 group + 可选 user"的下拉数据,跟 admin-only 的 `/api/admin/groups/list` / `/api/admin/users/list` 解耦。
>
> 旧路径 `/manager/spaces/:id` 保留作 redirect(书签兼容),跳转 `/spaces/:id` 后由新路由接手。

---

# 技术参考

下面这块是给改代码的人看的:SQL 解析路径、表结构、文件位置。前面的"人话"已经够用,这一节只在改这块代码时才需要点进来。

---

## 权限解析算法

唯一权威 SQL 来源:**`apps/api/src/lib/permissions.ts`**(全部 6 个谓词 + 2 个 list helper)。

### Subject:Principal

```ts
type PrincipalKind = 'user' | 'group' | 'anonymous'
interface Principal {
  kind: PrincipalKind
  id: string
  isAdmin: boolean  // 全局 admin 标记
}
```

`c.var.user`(由 `requireAuth` 中间件塞进)经 `principalFromUser()` 转成 Principal。

### 空间级 — `effectiveSpaceRole(me, spaceId)`

```sql
admin (isAdmin=true)         → 'admin'   -- 全局短路
anonymous                    → null      -- 匿名不走这条,走 token
regular user:
  SELECT MAX(rank) FROM (
    -- 直接 user grant
    SELECT role FROM space_role_grants
      WHERE space_id=$1 AND principal_kind='user' AND principal_id=$2
    UNION ALL
    -- 组 grant
    SELECT role FROM space_role_grants
      WHERE space_id=$1 AND principal_kind='group'
      AND principal_id IN (SELECT group_id FROM user_group_members WHERE user_id=$2)
    UNION ALL
    -- legacy,视作 'editor'
    SELECT 'editor' FROM space_group_access sga
      JOIN user_group_members ugm ON sga.group_id=ugm.group_id
      WHERE sga.space_id=$1 AND ugm.user_id=$2
  ) all_grants
  rank: admin=3, editor=2, viewer=1, null=0
```

### 6 个谓词总览

| 谓词 | 返回 true 的条件 |
|---|---|
| `canReadSpace(me, sp)` | admin;regular = role !== null |
| `canEditSpace(me, sp)` | admin;regular = role ∈ {admin, editor} |
| `canAdminSpace(me, sp)` | admin;regular = role === 'admin' |
| `canReadPage(me, pg, sp, author)` | admin OR 作者 OR `effectivePageReadAccess` |
| `canEditPage(me, pg, sp, author)` | admin OR 作者 OR `effectivePageEditAccess` AND `canReadPage`(edit 蕴含 read) |
| `isInAllowList(me, myGroups, list)` | `me.id ∈ list.users` OR `∃ g ∈ myGroups ∩ list.groups` |

### 页面级 — `canReadPage`(BFS 父链累计 view)

```
admin  → true
作者本人 → true   -- view 限制不挡作者
anonymous → false
regular:
  cur = pageId
  visited = ∅
  while cur not in visited:
    visited += cur
    r = loadPageRestrictions(cur)
    if r.view.users ∪ r.view.groups 非空:
      return isInAllowList(me, myGroups, r.view)
    cur = parentId(cur)
  return canReadSpace(me, spaceId)   -- 父链全无限制 → 回退空间角色
```

### 页面级 — `canEditPage`(只看本页)

```
admin  → true
作者本人 → true   -- edit 限制不挡作者
anonymous → false
regular:
  r = loadPageRestrictions(pageId)
  if r.edit.users ∪ r.edit.groups 非空:
    return isInAllowList(me, myGroups, r.edit)
  return canReadSpace(me, spaceId)   -- 看 spec:edit 限制不存在时回退到空间角色
```

> **edit 蕴含 read**:`canEditPage = effectivePageEditAccess AND canReadPage`。编辑一个 *看不到* 的页是不该发生的 —— Confluence 行为。详见 [边界场景 FAQ](#edit-权限是否隐含-view-权限)。

### 列表路径优化

`getEffectiveSpaceRolesForUser(me, ids[])`:一次 SQL 拿 N 个 space 的 effective role,UI 列表路径用,避免 N+1。`pageReadableDirectFilter(me)` 在 `GET /api/pages` SQL `WHERE` 过滤可读页 —— **不沿父链 BFS**(已知 v0 局限)。

---

## ER 图与表

权限子系统涉及 9 张表(4 张核心 + 5 张支撑)。所有表 **没有 FK**(CLAUDE.md 硬约束),级联删除显式在路由 handler 同事务里 sweep。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  用户 / 用户组                                                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│   ┌──────────────┐         ┌──────────────────┐                              │
│   │    users     │◄────────│ user_group_members│                              │
│   │  id (PK)     │    1:N  │  user_id+group_id │                              │
│   │  role enum   │         └──────────┬────────┘                              │
│   └──────┬───────┘                    ▼                                       │
│          │                 ┌──────────────────┐                              │
└──────────┼────────────────│   user_groups    │──────────────────────────────┘
           │                 │   id (PK)        │
           │                 └──────────────────┘
           │ author_id / updated_by / granted_by / created_by
           │ (无 FK,删 user 后行留作 audit)
           │
┌──────────┼───────────────────────────────────────────────────────────────────┐
│ 空间 / 页面                                                                 │
├──────────┼───────────────────────────────────────────────────────────────────┤
│          ▼                                                                   │
│   ┌──────────────┐                                                          │
│   │   spaces     │  kind: shared | personal, ownerId 仅 personal 有           │
│   └──┬───────┬───┘                                                          │
│      │       │                                                              │
│      │       └─────────────┐                                                │
│      ▼                     ▼                                                │
│   ┌─────────────────────┐  ┌──────────────────────────────┐                │
│   │  space_role_grants  │  │   space_group_access (legacy) │ ← A.5 写入时迁移│
│   │  UNIQUE(space,pk,pid)│  │   (space_id, group_id)       │                │
│   │  role: viewer|      │  └──────────────────────────────┘                │
│   │     editor|admin    │                                                   │
│   └─────────────────────┘                                                   │
│                                                                              │
│      ▼ N:1                                                                   │
│   ┌──────────────┐                                                          │
│   │    pages     │  space_id, parent_id, author_id, deletedAt                │
│   └──┬───────┬───┘                                                          │
│      │       │                                                              │
│      ▼ 1:N   ▼ 1:N                                                          │
│   ┌──────────────────┐  ┌──────────────────────────┐                       │
│   │ page_restrictions│  │  page_public_shares      │ ← Phase D             │
│   │  UNIQUE(page,kind,│  │  token_hash UNIQUE       │   sha256(token)      │
│   │   pk,pid)         │  │  明文永不入库            │                       │
│   └──────────────────┘  └──────────────────────────┘                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ 审计(append-only)                                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│   ┌──────────────────────────┐                                              │
│   │   permission_audit       │                                              │
│   │   kind enum × 8          │                                              │
│   │   actor_id, target_(kind,id), created_at DESC 索引                       │
│   │   payload jsonb {before, after}                                          │
│   └──────────────────────────┘                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 表与字段索引

| 表 | 关键列 | 约束 / 索引 |
|---|---|---|
| `users` | `role`: `admin\|user`,`status`: `active\|disabled\|must_reset_password` | — |
| `user_groups` | `name` | — |
| `user_group_members` | composite PK | 无 FK |
| `spaces` | `kind`: `shared\|personal`,`ownerId` 仅 personal | personal space 写由 `assertAdminNotWritingPersonalSpace` 拦 |
| `space_role_grants` | `principalKind`: `user\|group`,`role`: `viewer\|editor\|admin` | `UNIQUE (space_id, pk, pid)`;2 B-tree + 1 UNIQUE |
| `space_group_access`(legacy) | `(space_id, group_id)` | A.5 起写入迁移到 `space_role_grants role='editor'` |
| `pages` | `space_id`, `parent_id`, `author_id`, `deleted_at` | 树形,软删除 |
| `page_restrictions` | `kind`: `view\|edit`,`principalKind`: `user\|group` | `UNIQUE (page_id, kind, pk, pid)`;反 default-deny |
| `page_public_shares` | `tokenHash` UNIQUE,`expiresAt`,`revokedAt` | sha256(token);明文不入库 |
| `permission_audit` | `kind` × 8 枚举,`payload` jsonb | append-only;3 B-tree DESC |

`pg_description` 完整性:每张新表 + 每列必须有中文字面量 `COMMENT ON`,见 [CLAUDE.md 硬约束](../CLAUDE.md)。迁移 `0008_add_column_comments.sql` / `0009_add_attachments.sql` / `0024-0028_phase_*` 落库,schema JSDoc 与之一一对应。

---

## 关键 UI gate(代码级)

改 UI 显示条件时,确认这里的 computed / `v-if` 跟后端 gate 对齐。

| Gate | 文件 | 表达式 / 判断 |
|---|---|---|
| `canCreateInSpace` | `Sidebar.vue`, `HomeView.vue` | `s.viewerRole in {editor, admin}` OR author |
| `canEditThisPage` | `ReadView.vue`, `EditView.vue` | 整合 `authStore.isAdmin`, `page.viewerRole`, `me.id === page.authorId` |
| ReadView 「⋯」菜单 | `ReadView.vue` | items: `canEditPage`(限制 + 分享 + 编辑)、`canReadPage`(历史 + 关注) |
| EditView mount 重定向 | `EditView.vue` `onMounted` | 拉详情 → 不通过 → `router.replace('/p/:id?readonly=1')` |
| 「空间设置」入口 | `TopBar.vue` | `isAdmin OR canAdminSpace(...)` |
| 「访问控制」入口 | `SpaceEditView.vue` | 同上;基本信息 = `isAdmin OR canAdminSpace`(shared only);危险 = `requireAdmin` 兜底 |
| `/manager/*` 全局 | `router/index.ts` | `meta: { requiresAdmin: true }` |
| `canManageRestrictions` | `routes/pageRestrictions.ts` | `canEditPage`(`canReadPage` 已蕴含) |
| `gateShareManage` | `routes/pageShares.ts` | `canEditPage OR canAdminSpace` |
| `requireSpaceAdmin` | `routes/spacePermissions.ts` | `me.isAdmin OR canAdminSpace(me, spaceId)` |
| `assertAdminNotWritingPersonalSpace` | `lib/personalSpaceGuard.ts` | `space.kind='personal'` → 403 |
| `migrateLegacyGroupGrant(tx, ...)` | `lib/permissions.ts` | POST 时同事务把 legacy group 行迁到新表 |

---

## 边界场景 FAQ

> 这一节是 investigative —— 每个 case 都来自用户的真实提问 + 当时的代码现状。"已知 v0 局限"标记的事后续会修,但不应 *无意中* 被改坏。

### editor 在 space 里看不到「创建页面」按钮

**当前是 hide**(按钮不渲染 + readonly-badge 占位)。**不**走 disabled 按钮 —— Confluence / Notion 都这么做,viewer 进来是"干净的工作空间",button 缺失不让人误操作。

为什么不 disable:tooltip 要同时解释"权限 + 怎么申请",信息密度太高。`readonly-badge` 跟 `.create-page-btn` 同高,布局不跳。

### edit 权限是否隐含 view 权限?

**已隐含**(`canEditPage = effectivePageEditAccess AND canReadPage`)。

短路保真:
- admin:两边都 true → AND 仍 true
- page 作者:edit 短路 true + read 在作者也短路 true → AND 仍 true
- 其他用户:edit 通过 ∧ read 通过(view 沿父链 BFS)

边界 case:
- 用户 X 在 edit allow-list、不在 view allow-list → `PATCH /api/pages/:id` → false → 404(语义对:不能编辑看不到的内容)

### 分享链接提示"输入内容不合法,请检查后重试"是什么意思?

历史 bug:`pageShares.ts` 把 `specific code` 放在 `code` 字段,通用 `invalid_input` 放在 `error` 字段;前端 `humanizeApiError` 只读 `error`,匹配到泛化文案。把 `error` 直接设成 `share_forbidden` / `share_already_revoked` 等具体码即可正确翻译。

### view-restricted 子页能不能在侧栏树看到?

**能** —— `pageReadableDirectFilter` 不沿父链 BFS(view 继承 BFS 只在 GET `/:id` 路径跑)。

**实战建议**:想"完全保密"一个子页,把 view 限制 *也加到子页本身*(不能只加父页,否则子页在侧栏可见)。后续 v0.x 优化方向:denormalized 父链 view-inheritance JSONB 列 + trigger,把 BFS 收进 SQL。

### user 和 group 同时授权同一用户会不会重复 / 冲突?

不会。SQL `MAX(rank)`,UNIQUE 索引挡行。

例子:
- 工程组 `g-eng` 授 editor,Alice 直授 viewer → effective = `editor`
- 工程组 `g-eng` 授 viewer,Alice 直授 admin → effective = `admin`
- 同组+同人写多次?`space_role_grants UNIQUE (space_id, pk, pid)` 挡,`onConflictDoUpdate` 幂等

### admin 写个人空间

不能。`assertAdminNotWritingPersonalSpace` 在路由层拦截,403 `personal_space_readonly`。豁免:**读**(合规 / 监督)+ restore / purge trashed(回收站治理)。

### 作者本人短路

无论空间角色是 viewer 还是 admin,只要 `pages.authorId === me.id`:`canReadPage` / `canEditPage` 都直接 true,view / edit 限制都不挡。

### 公开链接为什么重定向到登录页?

理论上不该发生(`publicSharesRouter` 在 `requireAuth` 之前 mount,GET 不会 401)。

防御性补丁:`/public/pages` 在 `PUBLIC_AUTH_PATHS` 名单里 + `App.vue` / `useNotifications` 检测 `route.meta.public === true` 短路认证 polling + `unauthorizedHandler` 短路跳转。如果补丁完整还遇到,问题不在权限层 —— 提供 token 末段 + 浏览器控制台 Network。

### 公开分享链接 GET 一次后会缓存多久?

`Cache-Control: public, max-age=60`(60 秒)。`last_accessed_at` 在响应发出后 fire-and-forget 更新,不阻塞 GET。

### legacy `space_group_access` 现在还能用吗?

旧表保留 + 旧 `/api/admin/spaces/:id/access` 端点保留(`@deprecated`),是 rollback 安全网。`effectiveSpaceRole` UNION legacy 视为 `editor`;**写入新表时同事务迁移**(`migrateLegacyGroupGrant`)。全量 DROP 留作后续 follow-up。

### 分享 link 在 DB dump 里能看到明文吗?

**不能**。`page_public_shares` 只存 `sha256(token) hex`,明文 token 仅 `POST /share` 响应里出现一次。`scripts/verify_phase_d_public_shares.py` 显式断言 dump 里找不到原 token。

---

## 实现位置索引

### 后端(权威,所有 gate 走这里)

| 主题 | 文件 |
|---|---|
| 权限 SQL 唯一来源 | `apps/api/src/lib/permissions.ts`(848 行,6 谓词 + 2 list helper + migrateLegacy) |
| 兼容 shim + admin 写守卫 | `apps/api/src/lib/accessibleSpaceIds.ts`、`apps/api/src/lib/personalSpaceGuard.ts` |
| 审计 helper(强制 tx) | `apps/api/src/lib/auditLog.ts` |
| Share token 工具 | `apps/api/src/lib/shareTokens.ts` |
| 个人空间自动创建 | `apps/api/src/lib/ensurePersonalSpace.ts` |
| 表 + JSDoc | `apps/api/src/db/schema.ts` |
| 迁移 + COMMENT ON | `apps/api/src/db/migrations/0024-0028_phase_*` |
| 空间角色 API | `apps/api/src/routes/spacePermissions.ts` |
| 页面级限制 API | `apps/api/src/routes/pageRestrictions.ts` |
| 公开链接管理(auth) | `apps/api/src/routes/pageShares.ts` |
| 公开链接只读(无 auth) | `apps/api/src/routes/publicShares.ts` |
| 审计读(admin only) | `apps/api/src/routes/adminAudit.ts` |
| 旧 /access 端点(`@deprecated`,rollback 用) | `apps/api/src/routes/adminSpaces.ts` |
| 路由 mount 顺序敏感 | `apps/api/src/index.ts` |

### 前端 gates

| 主题 | 文件 |
|---|---|
| 能力矩阵里"读"按钮共享门 | `apps/web/src/components/layout/Sidebar.vue`(`canCreateInSpace`) |
| HomeView "新建页面" + 只读 badge | `apps/web/src/views/HomeView.vue` |
| PageTree 「+」子节点 + drag 重排 | `apps/web/src/components/layout/PageTree.vue` |
| ReadView 「⋯」菜单 + canEditThisPage | `apps/web/src/views/ReadView.vue` |
| EditView mount-time redirect + readonly banner | `apps/web/src/views/EditView.vue` |
| SpacePermissionsView(成员角色编辑) | `apps/web/src/views/manager/SpacePermissionsView.vue` |
| SpaceEditView(空间元信息 + 权限页入口) | `apps/web/src/views/manager/SpaceEditView.vue` |
| PageRestrictionsDialog | `apps/web/src/components/page/PageRestrictionsDialog.vue` |
| ShareDialog | `apps/web/src/components/page/ShareDialog.vue` |
| PublicPageView(匿名只读) | `apps/web/src/views/PublicPageView.vue` |
| AuditView | `apps/web/src/views/manager/AuditView.vue` |
| API client(`api.spaces.permissions` / `api.pages.restrictions` / `api.pages.shares` / `api.admin.audit`) | `apps/web/src/lib/api.ts` |
| 类型 + zod schema | `packages/shared/src/schemas.ts`、`packages/shared/src/types.ts` |
| 错误码中文映射 | `apps/web/src/lib/humanizeApiError.ts` |

### 验证脚本

| 脚本 | 覆盖 |
|---|---|
| `scripts/verify_phase_a_permissions.py` | viewer / editor / admin 角色、admin-role-to-group、最后 admin、legacy 迁移 |
| `scripts/verify_phase_b_page_restrictions.py` | view 限制 / 继承、edit 不继承、双重限制、purge cascade |
| `scripts/verify_phase_c_audit.py` | 事务内 audit、rollback 行为、admin-only、排序 |
| `scripts/verify_phase_d_public_shares.py` | 创建 / GET / revoke / 过期 / 坏 token、**DB dump 无明文 token**、purge cascade |
| `scripts/snap_*.py` | UI 截图 |
| `scripts/smoke_viewer_gating.py` | 端到端冒烟(devreadonly viewer vs happy editor) |

---

## 错误码参考

`apps/web/src/lib/humanizeApiError.ts`:`errBody.error`(由后端 `error` 字段直接出)→ 中文案。

### 空间权限相关(Phase A)

| code | 中文 | 触发场景 |
|---|---|---|
| `invalid_role` | 无效的角色类型 | body.role 不是 viewer/editor/admin |
| `admin_role_to_group` | 不能把管理权限授予用户组 | POST `.../permissions/groups/:gid` body `{role: 'admin'}` |
| `cannot_remove_last_admin` | 不能移除最后一个空间管理员 | DELETE 把最后 user-grant admin 干掉了 |
| `permission_denied` | 没有权限执行此操作 | 通用 fallback |

### 页面权限相关(Phase B)

| code | 中文 | 触发场景 |
|---|---|---|
| `page_restricted` | 该页面已设置编辑限制,您没有编辑权限 | 不在 edit allow-list 但试图编辑 |
| `view_restricted` | 该页面已设置查看限制,您没有访问权限 | 不在 view allow-list 但试图 GET |

### 公开分享相关(Phase D)

| code | 中文 | 触发场景 |
|---|---|---|
| `share_forbidden` | 该页面不可分享 | POST share 时是 personal space 或有 view 限制 |
| `share_expired` | 该分享链接已过期 | GET public,token 命中但已过期 |
| `share_revoked` | 该分享链接已被撤销 | GET public,token 命中但 `revoked_at IS NOT NULL` |
| `share_invalid` | 该分享链接无效 | GET public,token hash 不命中 |

### 已有(不在 Phase A-D 范围)

| code | 中文 | 触发 |
|---|---|---|
| `not_found` | 页面不存在 / 无权限 | 权限拒绝统一 404(防探测) |
| `personal_space_readonly` | 个人空间禁止写入 | `assertAdminNotWritingPersonalSpace` |
| `share_already_revoked` | 该分享链接已被撤销 | DELETE share 时已是 revoked 态 |
