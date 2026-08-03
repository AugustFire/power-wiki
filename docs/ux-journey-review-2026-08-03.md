# power-wiki 用户旅程打磨路线图(2026-08-03)

> 这份文档按**用户实际使用产品时经历的旅程**逐节点审视体验问题。
> 视角刻意避开 `docs/` 下既有的「按代码模块 + P0/P1/P2」分析模板(`product-gap-analysis-*`、架构 / 数据模型 / 权限各自一份),从用户视角反推「哪些节点会卡住他 / 让他失望 / 让他感到产品不可信」。
>
> 评估时不涉及:全文检索、评论优化、reaction、通知、历史、最近活动、a11y、生产部署、安全(开发打磨期,CLAUDE.md 硬约束)。
>
> 代码证据以 `apps/web/src/...` / `apps/api/src/...` 的相对路径给出。

---

## 0. 阅读对象

- 产品 owner:看「旅程体验描述 → 关键差距」段,决定要不要推进。
- 工程师:看「位置(代码锚点)→ 建议」段,评估实施成本。

---

## 1. 旅程全景

| # | 旅程 | 典型用户 | 主要节点 |
|---|---|---|---|
| A | **首日进入** | 新员工 / 重置密码后的老员工 | 登录 → 选空间 → 个人 vs 团队区分 |
| B | **浏览 & 阅读** | 找资料的工程师 / 看新内容的成员 | 切空间 → 翻侧栏 → 点页面 → 看附件 / 标签 |
| C | **创建 & 编辑** | 写文档的产品 / 写周报的工程师 | 新建 → 选父页 → 编辑器 → 保存 / 复制 / 移动 |
| D | **分享 & 协作** | 想把页面给外群的人 / @同事 / 公开 | 创建公开链接 / @mention / 标签 |
| E | **空间 & 成员管理** | space-admin / global admin | 创建空间 / 加成员 / 限制权限 / 看审计 |
| F | **全局站点配置** | global admin(尤其种子 admin) | 站点名称 / 默认首页 / 全局开关 |
| G | **回收 / 归档 / 删除** | 误删恢复者 / 长期清理者 | 回收站 / 空间归档 / hard-delete |

每段旅程后面是「**当前流程**(what works)→ 关键体验差距(what's broken)→ 优先级」。

---

## 2. 旅程 A · 首日进入

### 当前流程
1. 用户被邀请进一个空间。邮件给一个临时密码 + 登录链接。
2. 打开 `LoginView.vue`,输邮箱密码 → 命中 `authStore.login()`(`LoginView.vue:46-96`)。
3. 登录成功,如果 `needsPasswordReset` → 跳 `ResetPasswordView`;否则 `spacesStore.init()` 拿空间列表 → `pagesStore.init()` 拉 active space 根页 → `router.replace('/')`。
4. 进入 `/` 看到当前 active space 的首页仪表盘(若该空间有 `homepagePageId` 则跳到那篇页面,见 `SpaceHomeView.vue:49-63` 的 redirect 逻辑)。

### 体验好的部分(不展开)
- 登录失败分四种错误码(account_disabled / 401 / 403 / generic),都有针对性提示。
- `resolveRedirect()` 对管理员允许 `?redirect=`、对普通用户强制 `/`,避免别人留下的链接把新用户带进陌生空间。

### 关键差距
- **A-1 ·「选空间」对普通用户不可见**(P2)
  - 普通用户登录后被 `resolveRedirect()` 直接送到 `/`(`LoginView.vue:43`),即第一个有权限的空间。但**没有任何视觉提示告诉他「你刚被加到了空间 X」**。需要他自己点 SpaceSwitcher 才意识到。
  - 建议:登录后首次进入,如果是新用户(由 `me.createdAt` 距今 < 1h 判断),先弹一个轻量 toast「欢迎,你所在的空间:X / Y / Z」,3 秒后自动消失。
- **A-2 · 临时密码 → ResetPasswordView 路径无引导**  (P2)
  - 用户拿到临时密码 → 登录后跳 `/reset-password`,改完后 `router.replace('/')`。但 `LoginView.vue:52-55` 跳过去后,**没有显式说明**「为什么你要改密码」(虽然 ResetPasswordView 自身有顶部 banner,但用户先看见的是 LoginView 的「登录中…」→ 跳走)。
  - 建议:加 toast 「出于安全需要,请重置你的初始密码」,或者 LoginView 错误码区分 `must_reset_password`。

**优先级**:**P2**(低频且不阻塞,放进 backlog)。

---

## 3. 旅程 B · 浏览 & 阅读

### 当前流程
1. 用户进 `/`。侧栏显示当前空间的 page tree。
2. 用户点击一篇页 → 进 ReadView。
3. 页面有面包屑 / 标题 / 内容 / 标签 / 附件 / 子页 / byline。
4. 用户切空间 → 侧栏刷新。

### 关键差距

#### B-1 · 视图限制在 list 路径显示「幽灵条目」(P0)
- **用户体验**:用户 A 在「研发空间」创建「项目 X 资料」,**对该页设 view 限制**(只允许 `[用户 C, 用户组 G1]` 看到)。其下挂十几个子页面。
- 用户 B(不在 allow-list)打开「研发空间」首页 / 侧栏:**仍然看到「项目 X 资料」及其所有子页面**(因为 list 接口只校验本页 view 限制,不沿父链)。
- 用户 B 点「项目 X 资料 / 子页 / 设计文档」:**ReadView 渲染 `404 view_restricted`**(`apps/api/src/lib/permissions.ts:699-733` 的 `effectivePageReadAccess` 走父链 BFS 正确拒绝)。
- **结果**:侧栏的「入口」像「承诺」,点开像「说谎」。admin 加 view 限制反而引发 404 投诉。
- **位置**:`apps/api/src/lib/permissions.ts:580-611` 的 `pageReadableDirectFilter` SQL 没做父链 BFS;注释自承 v0 折衷。
- **建议**:`pageReadableDirectFilter` 增加 `WITH RECURSIVE ancestors(...) AS (...)` 一次性把 pageId 链上的 view 限制聚合,然后 JOIN filter。Workload 约 1 周。
- **配套 UX**:即便过滤生效,父链 view 限制的子页应有视觉提示(lock icon + hover 显示「父页限制了谁可访问」),让 admin 一眼能区分「我看不到」vs「这个页是被限制的」。
- **优先级**:**P0**(product-critical:视图限制是产品核心承诺之一,「加限制反而引发 404」会让 admin 弃用此功能)。

#### B-2 · ReadView 把编辑 affordance 暴露给纯读者(P1)
- **用户体验**:用户 B(只有 viewer 角色)打开 ReadView,**看到**:
  - 标签行有一个 **`+ 添加标签`** 按钮(`apps/web/src/components/page/LabelPills.vue:118-124`)。
  - 每个现有标签右侧有一个 **`×`** 按钮(默认隐藏,hover 才出现,见 `LabelPills.vue:170-186`)。
  - 附件区每条附件后有一个**删除按钮**(`apps/web/src/components/page/AttachmentsSection.vue`,无 `canDelete` prop gate)。
- 用户 B 点 `+` → popover → 选标签 → **前端乐观写入成功(`LabelPills.vue:60-78`)** → 后端 `POST /api/pages/:id/labels` 在 `apps/api/src/routes/pageLabels.ts:85` 校验 `canEditPage` 不通过 → 返回 404。
- **结果**:UI 告诉用户「你可以加」,后端告诉用户「你不能加」—— 红色 banner 弹出 + console 异常,产品解读为「页面有问题」。
- **位置**:`apps/web/src/views/ReadView.vue:989 / :993` 没传 `canEdit` 给 LabelPills / AttachmentsSection。
- **建议**:`LabelPills.vue` 与 `AttachmentsSection.vue` 加 `canEdit: boolean` prop;ReadView 接 `canEdit`(已有 computed,见 `ReadView.vue:597-605`)。`canEdit=false` 时:`+` 触发器与 `×` 删除按钮整段不渲染;hover 不暴露 popover。
- **优先级**:**P1**(典型「UI 夸口,API 拒收」反模式;每个 viewer 打开 ReadView 都会触发)。

#### B-3 · 列表接口未返回限制标志位(P1)
- **用户体验**:ReadView 想给受限页面(自己有访问权的)展示 lock 图标、SpaceMembersTab 想显示「这个页有 view 限制」。当前**两个标志都没有**。
- **位置**:`apps/api/src/lib/selectPagesWithAuthor.ts` 没 SELECT `EXISTS ... FROM page_restrictions ...`;`apps/api/src/lib/rowToPageNode.ts` 没把字段映射进 `PageNode`。但 `packages/shared/src/schemas.ts:130-140` 与 `apps/api/src/routes/pages.ts:441` 的注释都承诺「list 时 EXISTS 子查询返回 hasViewRestriction」,与代码脱节。
- **建议**:`selectPagesWithAuthor` 末尾追加两个 EXISTS 子查询;`rowToPageNode.ts` 同步映射。前端可以据此:
  - ReadView title 旁加 lock icon。
  - SpaceMembersTab 的 page-level 限制列填入 `view` / `edit` 的实际状态。
- **优先级**:**P1**(API 契约错误,前端凡是依赖这两个字段的 UI 都静默失效)。

#### B-4 · WatchedSidebar 网络错误被静默吞掉(P2)
- **用户体验**:用户的关注列表突然空白了,但没有任何错误提示。`apps/web/src/components/layout/WatchedSidebar.vue:71-96` 的 `load()` 有 `try/finally` 但**没有 catch**,异常一路冒到顶层被默认处理(可能 console 一行红字),UI 不反馈。
- **建议**:把 `loadError.value = humanizeApiError(e)` 加上,UI 模板里渲染一行 muted 错误 + 重试按钮。
- **优先级**:**P2**(容错性问题,但因为用户并不经常改网络,影响面小)。

---

## 4. 旅程 C · 创建 & 编辑

### 当前流程
1. 用户点 `+ 新建页面` → `SpaceHomeView.vue:120` 的 `createRoot()` 生成 client nanoid → router.push → 后端异步 create。
2. 编辑器打开 → 用户输入 → 500ms debounce auto-save → 30s idle 自动打 version snapshot(`EditView.vue:596-615`)。
3. 用户在 PathPicker(`PathPicker.vue`)选父页把页面移为子页。
4. ReadView 顶部「⋯」菜单提供复制、复制整棵子树、移动、删除。

### 关键差距

#### C-1 · 后端调试污染仍在主路径(P0)
- **用户体验**:用户每创建一个页面,服务器日志就被污染一行:
  ```
  !!! INTENTIONALLY_BROKEN_FOR_DEBUG !!!
  ```
- **位置**:`apps/api/src/routes/pages.ts:499` —— 注释自承「故意接近语法错误以触发 nodemon 重启」。
- **建议**:**直接删除**这一行(grep 全仓无其它 `INTENTIONALLY_BROKEN_FOR_DEBUG` 引用)。
- **优先级**:**P0**(每次写操作都打日志,长期噪音 + 误以为是 fatal)。

#### C-2 · 「复制子树」入口在不同位置不一致(P1)
- **用户体验**:用户在一棵树的根页,**想复制整棵子树**:
  - 在 ReadView 「⋯」菜单:**只有「复制页面」**,没有 subtree 选项(`apps/web/src/components/page/PageMoreActionsMenu.vue`)。
  - 在侧栏右键菜单 PageTree:**同时有「复制页面」和「复制整棵子树」**(见 `apps/web/src/components/layout/PageTree.vue:722-757`)。
- **结果**:从 ReadView 入口,用户根本不知道 subtree 复制存在;只能在侧栏右键。
- **建议**:`PageMoreActionsMenu.vue` 接 `hasChildren` prop;有子页时把「复制」项变成 submenu,展开「仅本页」/「连同子树」。
- **优先级**:**P1**(UX 一致性问题,典型「双入口语义不一致」)。

#### C-3 · PathPicker 没有搜索(P2)
- **用户体验**:用户创建子页时,想放到「项目 X 资料 / 设计草案」下,得在 PathPicker 里点开四五层才能找到目标页。
- **位置**:`apps/web/src/components/editor/PathPicker.vue:11-14` 自承「故意不做: 搜索/过滤(v1 假设 space 体量小,目测足够)」。
- **建议**:PathPicker 顶部加 search input,按页面名 LIKE 过滤;命中后展示完整路径前缀(`研发空间 / 项目 X / 设计草案`),点击直接选中。10+ 命中时虚拟滚动。
- **优先级**:**P2**(在用户基数小(<5 空间)的现状下不阻塞,但要排进 backlog)。

---

## 5. 旅程 D · 分享 & 协作

### 当前流程
1. 页面 owner / space-admin / global admin 在 EditView / ReadView 点「分享」→ `ShareDialog.vue` 弹出。
2. 选过期时间(7d / 30d / 90d / 永不)→ 创建 → 一次性明文 banner 展示 URL + 复制按钮(1.2s 后自动收起)。
3. 列表里展示所有 share 的状态 / 创建人 / 过期 / 撤销。
4. 协作 @mention 通过编辑器 Mention 扩展;标签通过 LabelPills。

### 关键差距

#### D-1 · 「复制链接」忽略公开 share 存在(P1)
- **用户体验**:用户 C 是页面「季度规划」的 owner,且刚创建了公开 share。他从 ReadView 顶栏「⋯ → 复制链接」(`PageMoreActionsMenu.vue:91-118`):
  - **实际复制的是内部 URL**:`https://wiki.example.com/#/p/<page-id>`。
  - **用户预期的是公开 URL**:`https://wiki.example.com/#/public/pages/<token>`(他刚创建 share 就是为了对外发)。
- **位置**:`PageMoreActionsMenu.vue:92` 写死 `${window.location.origin}${window.location.pathname}#/p/${props.page.id}`,无论 page 是否存在 active share。
- **建议**:
  - 优先:**`copyLink()` 在 page 有 active public share 时复制公开 URL;否则保持现状**。
  - 进一步:超过 1 个 active share 时,弹一个小选择器让用户选哪一条 share。
- **优先级**:**P1**(复制链接是高频操作;「我要给外群发链接」的语义被忽略)。

#### D-2 · ShareDialog 现有 share 行没有「复制 URL」快捷键(P2)
- **用户体验**:用户创建 share 后,1.2s 内没复制就关了 banner,**再也没法在 UI 上找回那个 URL**。要恢复只能撤销旧的、重 create 一条。
- **位置**:`apps/web/src/components/page/ShareDialog.vue:171-189` 的 banner 自动消失机制;`ShareDialog.vue:294-336` 的 list 没有「复制 URL」行级按钮。
- **建议**:list 每行后加一个「复制 URL」按钮,**但**不存明文 token,而是从 store 缓存的 shareId 派生(需要后端 list 响应在 share row 上保留 sha256 token 的前 8 位作为「share pointer」)。点击时提示「如需分发,请使用创建时的原始 token;如丢失,请撤销并重建」。
- **优先级**:**P2**(典型「token-only-once」是合理安全姿态;但 admin 在调试时希望再拿一次)。

---

## 6. 旅程 E · 空间 & 成员管理

### 当前流程
1. global admin 进 `/manager/spaces` 创建空间、配置 owner、设置 homepagePageId。
2. 在 `SpaceMembersTab` 加成员 / 用户组 → 选角色(viewer / editor / admin)。
3. global admin / space-admin 进 `/manager/people` 启停账号。
4. 任何 admin 在页面上点「限制」→ `PageRestrictionsDialog` 加 view / edit 限制。
5. admin 进 `/manager/audit` 看审计。

### 关键差距

#### E-1 · 作者授权绕过(author bypass)是最严重的安全语义偏离(P0)
- **用户体验(可观察到的)**:用户 A 在「研发空间」创建「设计草案」。管理员 B 把 A 移除出该空间(B 想让 A 不再访问该空间)。
- A 此时:
  - 直接打开 `https://wiki.example.com/#/p/<id>`:**仍然能看到全文**(GET /api/pages/:id 通过 author short-circuit,`permissions.ts:714`)。
  - 直接打开 `https://wiki.example.com/#/p/<id>/edit`:**仍然能改**(PATCH 通过 author short-circuit,`permissions.ts:751`)。
  - **sidebar 看不到空间**(因 `getEffectiveSpaceRolesForUser` 不返回 role),但 URL 直访是通的。
- 产品解读:admin 「移出成员」操作**没有被尊重**;空间隔离的承诺破裂。
- **位置**:
  - `apps/api/src/lib/permissions.ts:714` `if (meta?.authorId === me.id) return true`
  - `apps/api/src/lib/permissions.ts:751` `if (authorId === me.id) return true`
  - 注释(`permissions.ts:712`、`permissions.ts:750`)说这是 Confluence 「作者始终能管自己内容」快捷路径;但 Confluence 实际语义是「作者在仍有任意空间访问时保持管自己内容」,被移出空间后只保留只读 view,而不是 full edit。
- **建议(任一)**:
  - **方案 A(推荐)**:`effectivePageReadAccess` / `effectivePageEditAccess` 的 author 短路**前**先调用 `canReadSpace` / `canEditSpace`。被移除出空间时,author 短路不生效 → 走完整流程,read 走 view 限制 / 父链 → 404,edit 走 view 限制 → 404。这是「移除成员 = 关闭该人所有路径」的产品承诺。
  - 方案 B(保守):仅在 `PATCH /api/pages/:id` 加 `assertInSpace` 守卫;read 路径不变(作者仍能 read 自己写的页)。
- **测试用例**:create page → 把作者移除空间 → GET / PATCH / share 三条路径都必须拒绝。
- **优先级**:**P0**(空间隔离是产品定位的核心承诺)。

#### E-2 · admin 视图看不到页面的限制状态(P1)
- 同旅程 B-3,admin 在 SpaceMembersTab / page 列里看不到 page 的 view / edit 限制标志。
- **优先级**:**P1**(合并到 B-3 一起修)。

#### E-3 · admin 加 view 限制后,「幽灵条目」会让用户误以为限制没生效
- 同旅程 B-1;admin 在 admin 视角(也是 B 视角)都看得到。
- **优先级**:**P0**(合并到 B-1 一起修)。

---

## 7. 旅程 F · 全局站点配置

### 当前流程
- `apps/api/src/routes/adminSettings.ts` 路由存在,但 `apps/web/src/views/manager/ManagerLayout.vue:54-71` 的 sub-nav **没有「站点设置」入口**。
- admin 想改站点名称 / logo / 默认首页 / 全局开关,只能改数据库。

### 关键差距

#### F-1 · 站点设置 UI 缺失(P2)
- **用户体验**:global admin 想给站点改个名称 / 配默认首页 URL / 关闭附件上传总开关,**没有 UI**。
- **位置**:`apps/web/src/views/manager/ManagerLayout.vue:54-71` sub-nav 只有 5 项;`apps/api/src/routes/adminSettings.ts` 有端点但没 view。
- **建议**:加 `SiteSettingsView.vue`(route `manager-site-settings`):
  - 站点 logo / 名称 / slogan / 默认时区。
  - 全局开关(注册 / 公开 share / 附件上传 总开关)。
  - 数据合规项目(用户协议链接 / 隐私链接)。
  - 备份与恢复(引导至「审计日志」与外部备份脚本)。
- **优先级**:**P2**(开发期不阻塞;在 admin 用户数 > 1 之后会从 P2 提到 P1)。

---

## 8. 旅程 G · 回收 / 归档 / 删除

### 当前流程
- 全局管理员进 `/manager/trash` 看软删页面,可恢复或 hard-delete。
- `SpaceEditView` 归档空间(已存 active 行不能再写,但读路径仍可见)。

### 体验观察
- 软删 → 恢复路径完整。
- hard-delete 由 admin confirm + append-only audit 行。
- 空间归档后,**非 admin 用户** 在 `/api/spaces` 列表里**看不到**已归档空间(7-31 报告 §1 已经覆盖)。

### 关键差距
- 经审计未发现新 P0/P1/P2。7-31 报告 §1 标记的「归档空间整空间自动只读 / 非 admin 不见归档」继续成立。

---

## 9. 优先级路线图(汇总)

| 优先级 | 项 | 关联旅程 | 主要工作量 |
|---|---|---|---|
| **P0** | B-1 view 限制 list 父链失效 | B / E | 1 周(SQL 改造)+ UX lock icon |
| **P0** | E-1 author bypass | E / B | 半天(2 行 predicate 调整)+ 测试用例 |
| **P0** | C-1 后端调试污染 | C | 5 分钟(删 1 行) |
| **P1** | B-2 reader 看到编辑按钮 | B | 半天(prop 接线) |
| **P1** | B-3 hasViewRestriction 字段缺失 | B / E | 1 天(SQL 子查询 + mapper) |
| **P1** | C-2 复制子树入口不一致 | C | 半天(submenu) |
| **P1** | D-1 复制链接忽略 public share | D | 半天(分支判断) |
| **P2** | A-1 登录后无空间引导 | A | 半天 |
| **P2** | A-2 临时密码路径无说明 | A | 半天 |
| **P2** | B-4 WatchedSidebar 错误吞错 | B | 1 小时 |
| **P2** | C-3 PathPicker 无搜索 | C | 1 周 |
| **P2** | D-2 ShareDialog 列表复制 URL | D | 1 天(后端 schema 改 + UI) |
| **P2** | F-1 SiteSettings UI 缺失 | F | 1 周 |

---

## 10. 不再复述的已完成工作

`docs/product-gap-analysis-2026-07-31.md` §1 列出的 16 项继续成立:空间生命周期 / 空间成员视图 / 个人空间写保护 / 页面级限制 / AppShell 与 Manager 共享 TopBar / Home 双轨 / 空间切换器 / 管理 IA 作用域拆分 / 编辑器基线 / 阅读视图 / 自动保存 / 导出导入 / 详情聚合页 2K 视口 / 空态视觉收敛 / 面包屑 + page-actions 全站统一组件。本文不再重复。

---

## 11. 下一步建议

1. **本周**:E-1(author bypass)、B-1(view 限制 list 父链)、C-1(调试污染)三件 P0 必做。其中 E-1 半天,B-1 一周,C-1 5 分钟;预算合计约 1 周。
2. **下周**:B-2 / B-3 / C-2 / D-1 四件 P1 收尾。
3. **下月**:P2 全部铺开;`PathPicker` 搜索与 `SiteSettings` UI 可以并行(独立模块)。

> 如果需要把这份路线图拆成可执行的 plan(by week / by feature),下一步可以走 superpowers:writing-plans 把 §9 展开成阶段化 plan;不在本文档自动完成。