# power-wiki 产品差距分析（2026-07-29）

**审计视角**：以现有代码为证据，对照 Confluence 的内部团队使用基线（典型用户空间数 ≤5，无社交属性，个人空间只对 owner + global admin 开放）。所有发现都不含安全 / 生产部署相关项。文中"通俗描述"指用户能直接看到的行为，而非技术实现细节。

> 本文档面向产品迭代决策，代码证据以 `apps/web/src/...` / `apps/api/src/...` 的相对路径给出。所有"已经做到位"的项目不再列入 P0/P1/P2，避免重复投入。

---

## 0. 已经做到位的（不在本文档再提）

为避免重复，先列出审计确认完成、无需再投入的模块：

- **空间生命周期**：归档 / 解归档 / 删除限制（仅 admin；非空不能删；个人空间不能删）端到端完整；归档后整空间自动只读；非 admin 用户在 `/api/spaces` 看不到归档空间，但管理员 SpacesView 仍可见，Sidebar 也能 ribbon 出来。
- **空间成员视图**：`SpaceMembersTab` 把"成员 + 有效角色 + 来源"全部画在一行，并能从来源 pill 跳转到对应 grant 行 + 高亮（`SpaceEditView.vue:135-184`）。Confluence-grade 的统一视图。
- **个人空间写保护**：`personalSpaceGuard.ts` 是单一 choke point，pages / attachments / labels / versions / comments（后者走更进一步的 `commentGuards.ts` 组合）所有写路径都过这个守卫。已审计确认没有漏点。
- **页面级限制**：view 类限制沿页面树 BFS 向下继承；edit 类限制不继承（与 Confluence 一致）；author + global admin 短路。`PageRestrictionsDialog` 顶栏白话解释了这个语义。
- **AppShell 与 Manager 复用同一 TopBar**：登录后的所有路由都进 `AppShell`，Manager 不另起壳。Home 双轨（`/me` 个人工作台 / `/` 当前空间首页）分工清晰，符合项目硬约束"团队空间首页 ≠ 个人工作台"。
- **空间切换器**：≤5 个空间场景下足够快，个人空间置顶并标"仅自己可见"，归档空间只对管理员可见。
- **管理 IA 作用域拆分**：TopBar 管理菜单明确区分"当前空间管理"与"全局管理"；global admin 才能看到全局入口；space-admin 直接进入当前空间页。
- **编辑器基线**：12 种可插入块类型齐全（H1/H2/H3、列表、任务列表、3×3 表格、代码块、引用、分割线、Callout 4 色、Toggle、Page link、@mention + date、附件）。表格尤其强：插入 / 移动行列 / 合并拆分 / header toggle / cell color / 对齐 / resize / colwidth round-trip。
- **阅读视图渲染**：所有 slash menu 块都有对应渲染路径；任务列表在阅读态可交互；Page link 500ms hover 预览；代码块走 highlight.js；空页面 placeholder 区分了"刚创建"和"被清空"两种状态。
- **自动保存**：debounce 500ms + 30s idle snapshot + route-leave flush + dirty check + 状态指示 pending/saving/saved/error 五件套齐全。
- **导出与导入**：PDF 已老老实实写"通过打印对话框保存"（不是欺骗性"PDF 生成"）；Markdown 单页导入走 PathPicker 选目标。

---

## 模块 1 · 空间与权限

### P1 · 普通用户看不到「我在哪些空间、各自什么角色」

**现象**：你被 admin 加进一个团队空间后，唯一能看到这事的入口是 TopBar 的空间切换器，里面只列空间名，没有任何角色提示。Sidebar 也只展示当前激活空间的页面树；如果你意外被加进一个你根本不想看到的空间，你没办法自己退，必须找 admin 改。

**问题**：管理员视角的 SpacesView 完善，但用户视角是空白的。「我作为 user 的角色身份」这件事在产品里完全没有承载。

**证据**：`SpaceSwitcher.vue:60-63`（只列空间、无角色）；`usePinnedPages.ts` 之类是 localStorage 而非 per-user 视图；DB schema 也无 `joinedAt` / 离开字段。

**建议**：在 `/me`（个人工作台）增加一栏"我的空间与角色"，每行展示空间名 + 角色 pill（与 SpaceMembersTab 一致但仅本人一行）；同一行右侧加"查看空间首页"与"离开空间"按钮（owner 全局管理员禁止离开；admin 可踢）。

### P1 · 团队空间之间不能移动页面

**现象**：你想把 A 团队空间的某篇页面挪到 B 团队空间去，发现后端直接 409 拒绝。唯一能跨空间的"移动"是 `publish-to-personal`，但那是个人→团队的发布流，不是真正的双向移动。

**问题**：Confluence 支持任意两个团队空间之间移动（带权限检查），用户经常因为「这个文档更属于 B 组」而需要搬家。power-wiki 现在强行让这条路必须经过"个人空间中转"或"复制粘贴内容"。

**证据**：`apps/api/src/routes/pages.ts:1025`（跨空间移动分支）；`apps/web/src/components/page/MovePageDialog.vue` 只允许「同空间内移动」+「团队→个人」两条路径，无团队↔团队。

**建议**：放开 `POST /api/pages/:id/move` 接受 `{toSpaceId, toParentId}`；权限 = 源空间 editor + 目标空间 editor；UI 在 MovePageDialog 顶部加一个跨空间 tab。需要先解决"目标空间是否支持层级同构"的判断（root 节点搬迁如何落 sortOrder）。

### P2 · 权限的"MAX-rank 合并"对外不可见

**现象**：你在 SpaceMembersTab 看到某成员的 effective role 是 `editor`，但他其实有两条来源——一条直接 `viewer`，一条经某用户组 `editor`。你只看到 `editor`，看不到"哪条在赢"。

**问题**：管理员想搞清楚"为什么 X 有这个权限"时，会被这个统一的 pill 误导——以为直接授权生效，实际上是组授权覆盖。透明度上的半成品。

**证据**：`apps/api/src/lib/permissions.ts:116-145` 实现 MAX-rank；UI 在 `SpaceMembersTab.vue` 仅渲染 effective + 来源列表，但 `sources` 没有"winning"标记。

**建议**：在来源 pill 中给"赢的那一条"加颜色高亮或 ✓ 标记，hover tooltip 解释"覆盖规则"。

### P2 · 受限页面没有「为什么我看不到」的引导

**现象**：你被一个页面加上了 view-restrict 限制，你点链接进去，只看到通用的 404。

**问题**：用户/管理员无从分辨"页面被删了"和"页面有 view 限制"。`PageRestrictionsDialog` 只对管理者展示，**对当前被阻挡的用户不展示**。

**证据**：`apps/api/src/lib/permissions.ts:699-733` 的 `canReadPage` 抛 404；UI 无任何诊断。

**建议**：被阻挡时给出专用页「此页面存在访问限制。如需申请权限请联系空间管理员」，并附上空间名 + 管理员邮箱 / 链接（如果有的话）。

### P2 · 归档空间没有页面内的"只读"横幅

**现象**：空间被归档后，Sidebar 给激活空间加了"已归档"灰带和 chip；但如果用户通过深链直接打开归档空间里的某页面，看到的是一个完全正常的页面，没有"这空间已归档，你是只读"的提示，点了保存才发现无效。

**问题**：归档语义只表达在"换空间时"，没表达在"读内容时"。

**证据**：归档 hook 只在 `Sidebar.vue:509-524`、`SpaceSwitcher.vue:60-63` 表现；`ReadView.vue` / `EditView.vue` 没读 `space.archivedAt`。

**建议**：ReadView 在页面顶部插入一条横幅"此空间已归档，仅可阅读"；EditView 直接 disable 编辑器并提示。

---

## 模块 2 · 团队空间首页与全局导航

### P0 · 团队空间首页不能成为真正的"主页"

**现象**：进入一个团队空间，落在 `/` 上，看到的是一个系统生成的仪表盘：空间描述、页面统计、快捷操作、最近编辑卡片、根页面列表。它能告诉你"这里有什么"，但**不能让团队写一段"欢迎来到 XX 组，我们做什么，怎么上手"**。

**问题**：Confluence 的 space homepage 是团队核心入口——新人 onboarding、使命宣言、关键链接都靠它。power-wiki 当前的系统仪表盘无法承载这些。

**证据**：`SpaceHomeView.vue:172-288` 是只读模板；`apps/api/src/db/schema.ts:140-175` 空间表只有 `name/description/icon/...`，**没有 `homepage_page_id` 字段**；API 没有任何"设为主页"端点。

**建议**：

1. `spaces` 表加 `homepage_page_id`（可空，按项目硬约束不写 FK，应用层校验）。
2. `SpaceEditView.vue` 增加"主页设置"区，让管理员从该空间任意页面选一篇。
3. `SpaceHomeView.vue` 改为：`if (homepage) → 渲染该页面内容（read 样式）；else → 当前的仪表盘`。
4. 用户切到该空间时，`/` 直接跳到主页页（深链）。

### P1 · 收藏 / 固定是 localStorage 半成品

**现象**：阅读栏能 pin 一篇页面，"已固定"出现在 `/me` 工作台。**但是**：你换个浏览器、换个设备，所有 pin 都没了；最多 20 条；Sidebar 主动删掉了固定列表；DB 没建 favorites 表。

**问题**：favorites 是高频快捷导航，跟个人空间、@提到我、最近访问是同一组「跨空间个人入口」。现在它只在 localStorage，等于没有真正意义上的"我的收藏"。

**证据**：`usePinnedPages.ts:1-23,49-68,92-166`（localStorage）；`migration 0019` 删了 `pages.starred` 历史字段；`SidebarTopSection.vue:2-20` 主动没列。

**建议**：

1. 新建 `user_pinned_pages (userId, pageId, sortOrder, createdAt)` 表（按硬约束无 FK）。
2. `POST/DELETE /api/users/me/pinned/:pageId`。
3. Sidebar 重新加入"固定"区（不超过 8 条，多了进 `/me`）。
4. 迁移：一次性把 localStorage 的数据写进 DB。

### P2 · 部分详情 / 聚合页没占满 2560×1440

**现象**：打开 SpaceEdit、UserEdit、Activity、Watched 这些详情 / 聚合页面，发现内容集中在左中，右边一大片空。在 24" 2K 显示器上（设计基线视口）非常扎眼。

**证据**（视宽 cap）：`SpaceEditView.vue:1431-1438` 1680px、`UserEditView.vue:527` 1000px、`ActivityView.vue:287-312` 960px、`WatchedView.vue:185-186` 880px。Tokens 已经提供 `wide-content 2400px`（`tokens.css:112-120`），但这些页没用到。

**建议**：把聚合面（Activity / Watched）拉到 `wide-content`；详情面（SpaceEdit / UserEdit）从 1680 / 1000 提到 1800 / 1200，留出余量即可。Read / Edit 已经是 2400px 范围内，无须动。

### P2 · 面包屑不一致

**现象**：阅读 / 编辑页用 `useBreadcrumb` 共享实现，OK。但 Home / Activity / Watched 用的是 subheader 简化版；ManagerLayout 又有自己的"后台面包屑"；而 Space / User / Group 的详情页又在内容区再画一次独立面包屑；History 干脆是"返回页面 + 页面名 · 版本历史"。

**问题**：用户在不同页之间切换，"我现在在哪一层"这件事有 4 种不同的视觉表达。

**证据**：`ReadView.vue:364-367`、`EditView.vue:165-174` 用共享 hook；`ManagerLayout.vue:33-45`、`SpaceEditView.vue:725-750`、`HistoryView.vue:165-191` 各自独立。

**建议**：把面包屑抽象成单一组件 + 单一来源（用 route meta 描述），所有视图统一渲染；History 改成"空间名 / 页面名 / 版本历史"。

---

## 模块 3 · 页面组织与页面树

### P0 · "在任意位置创建新页面"的统一入口缺失

**现象**：你只能在 sidebar 当前选中节点右键"新建子页面"，或在当前页点"在此之下新建"。如果你想"在根下、与 X 平级、在 Y 之下"——必须先切换选中、再点新建。

**问题**：`PathPicker.vue` 已经是成熟的"选目标页"组件（MovePageDialog、ImportMarkdownModal 都在用），但**没有任何「新建页面」路径调用它**。`router/index.ts:95-100` 留了 `/new?parent=<id>` 路由，**零调用方**。

**证据**：`apps/web/src/components/editor/PathPicker.vue`（现有但仅被 move / import 用）；`router/index.ts:95-100`（孤儿路由）；`PageTree.vue` 高频 / 低频菜单都没"选目标位置新建"。

**建议**：

1. TopBar 加 "+ 新建页面"按钮 → 弹出 PathPicker → 选好位置后跳到 `/new?parent=<id>`。
2. PathPicker 接受 `mode: 'create' | 'move' | 'import'`。
3. 创建后高亮跳到新页面。

### P1 · 页面树没有多选 / 批量操作

**现象**：你想把 10 个页面同时移到另一个空间，或者批量加同一个标签，现在只能一个一个点右键。

**问题**：Confluence 的 page tree 支持 `Cmd/Ctrl + 点击` 多选 + 批量操作（移动 / 加标签 / 删除 / 导出）。

**证据**：`PageTree.vue` 单选模型；`usePageTreeDrag` 只处理单节点拖拽。

**建议**：先支持多选 + 批量 move（这是高频），批量加标签、批量删除次之。无需一次性做齐。

### P1 · 没有"同级重排"的轻量手势

**现象**：调整同级顺序目前**只能靠拖拽到前 / 后两区**（3-zone drop），没有"上移 / 下移"按钮、没有键盘方向键移动。

**问题**：拖拽在页面很长时定位不准；键盘用户没有任何同级排序通道。

**证据**：`PageTree.vue:709-744` 高频区只有 hover 操作；`usePageTreeDrag` 的 keyboard placeholder 还是 dead code（line 497-504）。

**建议**：hover 行加 ↑↓ 图标按钮，单步移动；同时键盘 ←→ 也能重排同级。

---

## 模块 4 · 编辑器与内容

### P0 · 并发编辑静默丢内容（边界数据丢失风险）

**现象**：A 和 B 同时打开一个页面，各自编辑 5 分钟，各自每 500ms 自动保存。**A 最后保存的覆盖 B 的内容，B 的整段编辑消失，没有任何提示。**

**问题**：不是协同功能（项目当前明确不做），但**「最后写赢」的语义在双客户端边界下是数据丢失**。A 收到 `200 OK` 也不代表 A 是唯一作者。

**证据**：`apps/api/src/routes/pages.ts:490-574` 的 PATCH 路由不接 `If-Match` / `updatedAt`；`apps/web/src/stores/pages.ts:514-539` 也是乐观更新 + snapshot 回滚，无"其他人在我之后写过"检测。

**建议**（非协同前提下最轻量）：

- 后端在 PATCH 时校验 `updatedAt` 与当前行一致；若不一致，返回 409 `conflict` + 当前行 `updatedAt`。
- 前端 store 在 409 时：保留本地 dirty diff，提示"页面已被 X 在 Y 时刻修改，请刷新或合并"，让用户决定保留哪一边。
- 成本低，与 Yjs 互不冲突，未来上协同时再升级。

### P1 · 没有布局 columns（并排区块）节点

**现象**：你想做"左图右文"或"三栏对比"，发现 slash menu 没有；只能嵌一个表格来模拟，体验差。

**问题**：Confluence 的"Section / Column"是最常用的版式之一。power-wiki 当前只能靠表格 hack。

**证据**：`extensions.ts` 无 `columns` / `columnLayout` 节点；`useBlockTypeSwitcher.ts:24` 也只识 p / h1 / h2 / h3 / quote / code。

**建议**：上 Tiptap 官方 extension 或自写轻量 columns 节点（2 / 3 / 4 列均可）；slash menu 加"分栏"。

### P1 · 没有状态徽章（status badge）节点

**现象**：你想表达"已完成 / 进行中 / 阻塞 / 已废弃"这种状态，目前只能在文本里写"[完成]"这种 ASCII，渲染端不会高亮。

**问题**：Confluence 的 status macro 是页面顶部强信号，power-wiki 缺这一类轻量元数据承载。

**证据**：slash menu 无 status；`extensions.ts` 无对应节点。

**建议**：上 4 色 status badge（grey / blue / yellow / green / red），inline 节点；toolbar 加一个快速切换。

### P1 · 没有"嵌入子页面 / 最近更新"宏

**现象**：ReadView 底部已经自动列出当前页的子页面（`ReadView.vue:922-937`）和最近活动，但**作者不能在文中插入**——比如"我希望在页面中段插一份某页的摘要"、"在父页里嵌入某子页摘要"。

**问题**：Confluence 的 `{children}`、`{recently-updated}`、`{content-by-label}` 宏是文档编织的核心工具。power-wiki 现在只能靠目录树或外链。

**证据**：slash menu 无对应项；无 macro 节点。

**建议**：先做最常用的两个：`{include:PageRef}` 嵌入某页摘要（前 200 字 + 链接）、`{children}` 在文中插入子页卡片列表。

### P2 · 阅读时长估算缺失

**现象**：ReadView 已经在 byline 显示字符数，但没有"约 X 分钟阅读"。Confluence / 公众号都标配这个。

**证据**：`apps/web/src/lib/textMetrics.ts` 只导出 `charCount` / `excerpt`；ReadView `865-876` 没接 reading-time。

**建议**：加 `readingTime = charCount / 350`（中文）+ 国际化文案。

### P2 · 复制页面按钮被注释掉（半成品 UI）

**现象**：ReadView subheader 整块"复制页面"按钮被注释（`ReadView.vue:676-685`），但 handler `onDuplicate()` 和 store / API 都齐全。

**问题**：用户看见一个不存在的按钮位（注释残留），或者根本找不到复制入口。这是用户可见的「半成品」信号。

**证据**：同上。

**建议**：要么解注释（最简单）；要么删掉注释块。半成品是产品体验的反向信号。

---

## 模块 5 · 标签

### P1 · 没有标签落地页（label landing page）

**现象**：你在 TopSearch 选了某个 label，或者在 LabelPills 点一个 label chip，它**只是把 TopSearch 框的筛选条件设上**，并不跳到一个"展示这个标签下所有页面的专属页面"。

**问题**：Confluence 的 `/{label}` 是团队共享同一标签资源的入口（"所有标 #oncall 的页面"）。当前体验是"在搜索框里看到这个标签"，用户没法收藏、没法分享、没法建立「标签页 = 工作流入口」的心智。

**证据**：

- `apps/web/src/components/page/LabelPills.vue:94-121` 无 click handler 跳路由。
- `apps/web/src/components/layout/TopSearch.vue:137,231` 只设筛选条件。
- `apps/web/src/router/index.ts` 无 `/labels/:label`。
- 后端仅有 `/api/search?label=`，无 `/api/labels/:label/pages` 这种聚合端点。

**建议**：

1. 后端加 `GET /api/labels/:label/pages?spaceId=&cursor=` —— 返回该标签下页面列表（沿用 search 内部 SQL）。
2. 前端新增 `LabelBrowseView.vue`（与 SearchView 相似但无 query 框、固定 label chip 在顶部）。
3. LabelPills + TopSearch 的 label chip 都跳到这个路由。
4. SpaceHomeView 可以加"本空间热门标签"卡片，链过去。

---

## 模块 6 · 附件

### P1 · 附件区只显示「上传 + 时间」，没有搜索 / 筛选 / 替换 / 重命名 / 批量

**现象**：一个页面挂了几十个附件（PDF / Excel / 截图），当前附件区只给你看一列文件名 + 时间 + 下载。

**问题**：你想"找其中那张图"、"把某个 PDF 换成新版"、"批量删除"——都没有。要么肉眼滚，要么靠全局搜索。Confluence 的 attachments macro 提供筛选（type / 时间 / uploader）和替换 / 重命名 / 批量删除。

**证据**：`apps/web/src/components/page/AttachmentsSection.vue:173-185` 只渲染 uploader + time；`apps/api/src/routes/attachments.ts` 后端也没批量端点。

**建议**（按价值排序）：

1. 筛选（type / uploader / 时间段）。
2. 替换（同名上传 → 弹窗"替换还是另存"）。
3. 重命名（inline 改 displayName）。
4. 多选 + 批量删除。
5. 全局拖入文件夹自动建子页附件（高阶，可后置）。

---

## 模块 7 · 跨切面与断点

### P2 · 永久占位 + 文案污染

**现象**：

- `AuditView.vue:359-397,406-411`：搜索框固定 disabled，文案直写"暂未启用 — 留作 v2"。**用户能看到的 dead control**。
- `ReadView.vue:675-685`：注释掉的复制按钮（见 P2-复制）。
- `ActivityView.vue:180-186`：描述混用 "Workspace-wide" / "page"。
- `AuditView`：使用 "append-only" / "targetId" / "Phase C" 这种工程语义。
- `SpaceEditView.vue:797-800,885-891,1045-1048`：出现 "space-admin" / "global admin" / "user-level admin" / "user"。

**问题**：用户能看到的英文术语、半成品按钮、disabled input，都是"产品还在路上"的信号；中文产品里尤其违和。

**建议**：

1. 删掉所有 `<!-- 已废止 -->` 之类注释残留和注释掉的可点击元素。
2. 用户可见的英文术语（Phase C / append-only / targetId）翻译并删掉或挪到 dev-only 后台。
3. role label 统一为「管理员 / 编辑者 / 查看者」三档（与 SpaceMembersTab 一致）。

---

## 优先级总览

| 优先级 | 项 | 一句话 |
|---|---|---|
| **P0** | 团队空间首页不可编辑 | Confluence 标配 onboarding 入口，现在系统仪表盘顶替 |
| **P0** | 并发编辑静默丢内容 | 双客户端边界下的真实数据丢失 |
| **P0** | 统一"在任意位置新建"入口缺失 | PathPicker 已有但无人调用，路由空挂 |
| **P1** | 用户无「我的空间 + 角色」视图 | 只能从 SpaceSwitcher 看空间名，角色不可见 |
| **P1** | 团队→团队移动页面 | 强行走个人空间或复制粘贴 |
| **P1** | 没有标签落地页 | 点 label 只设筛选条件，不跳专属页 |
| **P1** | 页面树无多选 / 批量 | 只能单点右键 |
| **P1** | 附件区无筛选 / 替换 / 重命名 / 批量 | 文件一多就不可用 |
| **P1** | 收藏是 localStorage 半成品 | 换设备即丢失，Sidebar 已主动删除 |
| **P1** | 缺少 layout columns 节点 | 「左图右文」只能用表格 hack |
| **P1** | 缺少 status badge 节点 | 状态只能 ASCII |
| **P1** | 缺少 inline 子页 / 最近更新宏 | 文档编织能力空缺 |
| **P1** | 没有同级轻量重排 | 只能拖拽；键盘用户无通道 |
| **P2** | MAX-rank 合并对外不可见 | 来源 pill 缺少 winning 标记 |
| **P2** | 受限页无"为什么看不到"引导 | 一律 404，无诊断 |
| **P2** | 归档空间无页面内横幅 | 仅 Sidebar 表达 |
| **P2** | 部分详情页未占满 2560×1440 | SpaceEdit / UserEdit / Activity / Watched |
| **P2** | 面包屑有 4 种实现 | 不统一 |
| **P2** | 复制按钮注释残留 | 半成品 UI |
| **P2** | 阅读时长缺失 | 只显示字符数 |
| **P2** | 永久占位 + 英文文案污染 | Audit / Activity / Space 详情 |

---

## 建议推进节奏

- **第 1 步（核心产品逻辑）**：P0 三项 + P1 「我的空间 + 角色」、「标签落地页」、「统一新建入口」—— 这五项是相对 Confluence 最显眼的缺失；产品对外观感直接影响最大。
- **第 2 步（协作与编织）**：P0 并发冲突 + P1 columns / status / 嵌入宏 / 附件增强 —— 让编辑器和文档组织能力再上一个台阶。
- **第 3 步（清理与一致）**：所有 P2 收口，包括宽屏一致性、面包屑统一、断点文案清理。
- **同步可做**：收藏升级为 DB 表（属于「跨空间个人入口」成熟度，单独迭代也合理）。