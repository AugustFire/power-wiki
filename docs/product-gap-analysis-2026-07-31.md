# power-wiki 产品差距审查报告(2026-07-31)

> 审计视角:以现有代码为证据,对照 Confluence 的内部团队使用基线(典型用户空间数 ≤5,无社交属性,个人空间只对 owner + global admin 开放)。所有发现都不含安全 / 生产部署相关项。
>
> 文档面向产品迭代决策,代码证据以 `apps/web/src/...` / `apps/api/src/...` 的相对路径给出。所有"已经做到位"的项目不再列入 P0/P1/P2,避免重复投入。

---

## 0. 审查背景

**审查时间**:2026-07-31
**审计范围**:空间 / 权限、页面 / 视图、编辑器、导航 chrome、个人视图 / 管理后台
**审查依据**:代码现状 vs Confluence 内部团队 wiki 基线
**审查方式**:4 个并行 product audit agent 分别扫描独立模块,合并去重后形成本报告

**显式排除(本次不评估)**:
- 全文检索 / 搜索框
- 评论功能完善
- 历史 / 最近活动优化(Activity 列表本身存在,但其内容生成 / 排序 / 过滤的深度算法不评估)
- 辅助屏幕 / a11y / 键盘可达性
- 安全 / 鉴权(开发打磨期不考虑)
- 模板功能(已废止,不做)
- 移动端适配
- 暗色主题
- HelpButton / CheatSheet 类 discoverability(内部 R&D 工具,明示不做)

---

## 1. 已经做到位的(不在本文档再提)

为避免重复,先列出本次审计确认完成、无需再投入的模块:

- **空间生命周期**:归档 / 解归档 / 删除限制(仅 admin;非空不能删;个人空间不能删)端到端完整;归档后整空间自动只读;非 admin 用户在 `/api/spaces` 看不到归档空间,但管理员 SpacesView 仍可见,Sidebar 也能 ribbon 出来。
- **空间成员视图**:`SpaceMembersTab` 把"成员 + 有效角色 + 来源"全部画在一行,并能从来源 pill 跳转到对应 grant 行 + 高亮(`SpaceEditView.vue:135-184`)。Confluence-grade 的统一视图。
- **个人空间写保护**:`personalSpaceGuard.ts` 是单一 choke point,pages / attachments / labels / versions / comments(后者走更进一步的 `commentGuards.ts` 组合)所有写路径都过这个守卫。已审计确认没有漏点。
- **页面级限制**:view 类限制沿页面树 BFS 向下继承;edit 类限制不继承(与 Confluence 一致);author + global admin 短路。`PageRestrictionsDialog` 顶栏白话解释了这个语义。
- **AppShell 与 Manager 复用同一 TopBar**:登录后的所有路由都进 `AppShell`,Manager 不另起壳。Home 双轨(`/me` 个人工作台 / `/` 当前空间首页)分工清晰,符合项目硬约束"团队空间首页 ≠ 个人工作台"。
- **空间切换器**:≤5 个空间场景下足够快,个人空间置顶并标"仅自己可见",归档空间只对管理员可见。切换器 0.5s 内的回退兜底(防误触)已修。
- **管理 IA 作用域拆分**:TopBar 管理菜单明确区分"当前空间管理"与"全局管理";global admin 才能看到全局入口;space-admin 直接进入当前空间页。
- **编辑器基线**:12 种可插入块类型齐全(H1/H2/H3、列表、任务列表、3×3 表格、代码块、引用、分割线、Callout 4 色、Toggle、Page link、@mention + date、附件)。表格尤其强:插入 / 移动行列 / 合并拆分 / header toggle / cell color / 对齐 / resize / colwidth round-trip。
- **阅读视图渲染**:所有 slash menu 块都有对应渲染路径;任务列表在阅读态可交互;Page link 500ms hover 预览;代码块走 highlight.js;空页面 placeholder 区分了"刚创建"和"被清空"两种状态。
- **自动保存**:debounce 500ms + 30s idle snapshot + route-leave flush + dirty check + 状态指示 pending/saving/saved/error 五件套齐全。
- **导出与导入**:PDF 已老老实实写"通过打印对话框保存"(不是欺骗性"PDF 生成");Markdown 单页导入走 PathPicker 选目标。
- **详情 / 聚合页 2K 视口占满**:ActivityView / WatchedView 已拉 wide-content,SpaceEditView / UserEditView 适度放宽(1680→1800 / 1000→1200),详情聚合面在 2560 视口下不再留空。
- **空态视觉收敛**:`SidebarSectionHeader` 支持 `collapsible=false` 渲染分支(div + 无 chevron + 无 hover),WatchedSidebar 0 条关注时切到非折叠态,SpaceHomeView 空空间隐藏 subheader 新建按钮。
- **面包屑 + page-actions 全站统一组件**:从 breadcrumbSegments / page-actions 单一组件分发到所有视图,不再每视图写一套。

---

## 2. 总览(Executive Summary)

整个产品已经从早期 MVP 收敛到"接近 Confluence 中段水平":主流程(空间、页面、权限、编辑、附件、Manager)完整,Confluence-grade 角色语义和个人空间保护到位。

**真正卡用户的 P0 共 8 条**,集中在三块:

1. **页面顶部 page-actions 缺核心元操作**(复制 / 移动 / 删除只能在 sidebar kebab 找)
2. **后端已经在发数据,前端却在丢数据**(`PersonalHomeView` 整个吞掉 `personalSpace` / `watched` 两个 section;`TrashView` 注释宣称批量恢复但根本没实现)
3. **edit / read 双视图行为不一致**(dirty 关闭无确认、byline 时间语义冲突、Read 视图附件渲染与 Edit 不同源、Sidebar 当前空间 chip 不可点、NotFoundView 视觉脱节)

**P1 约 18 条**,集中在"产品成熟度的明显短板":粘贴纯 Markdown 不识别、个人空间与团队空间产品差异化弱、Manager 后台 active filter 不显示、跨空间面包屑无空间名、2K 视口下 chrome 漂移、PageActions 按钮超载无降级、PageActions / Sidebar 仍有 `#fff` 硬编码等。

**P2 约 13 条**,主要是观感细节(emoji 替换、loading skeleton、tooltip 简化、死代码清理)。

---

## 3. 模块一 · 空间 / 权限 / 个人空间

**模块判断**:基础骨架已具备(个人空间进入切换器、团队空间首页、归档、成员权限来源、Manager 列表均存在)。阻塞核心使用的 P0 没有,但 P1 的"可解释性"和"管理效率"集中欠缺 —— 用户能跑通,但每次操作都得多想一步。

### P1

#### 1.1 团队空间 vs 个人空间首页产品差异过弱

**现象**:打开个人空间,看到的还是「stat-grid(全部页面/今日活跃/本周更新/我的页面)+ 根页面列表 + 最近编辑」,跟团队空间首页几乎一样。但个人空间就你一人,「今日活跃」「本周更新」永远是 0 或 1,4 个 stat 卡是噪音;且没有任何「这是私域,别人看不到」的视觉锚点。

**问题**:Confluence 个人空间首页是「草稿/收藏/邀请待办」三栏,跟团队空间首页侧重完全不同。普通用户分不清自己点的「空间」到底是团队的还是私人的。

**证据**:
- `apps/web/src/views/SpaceHomeView.vue:27` 只用 `activeSpace.kind` 切文案
- `apps/web/src/views/PersonalHomeView.vue:23-114` 跟 `SpaceHomeView.vue` 共享 `.home-shell` + stat-grid

**建议**:PersonalHomeView 走独立 layout(草稿/收藏/最近编辑三栏),cover 加 lock icon + 「仅自己可见」标识;stat-grid 在个人空间隐藏。

---

#### 1.2 个人空间分享边界控制缺失

**现象**:在个人空间写一篇页面后,用户不知道这篇能不能分享、有没有公开链接、谁能看;分享按钮直接弹窗给链接,不区分「个人空间里的页面」和「团队空间里的页面」。

**问题**:私密空间的核心是「让用户持续获得确定感」,光靠后端权限正确不够。Confluence 在个人空间页面顶部会显式标注「仅自己可见」,分享入口在个人空间里直接禁用并解释原因。

**证据**:
- `apps/web/src/views/PersonalHomeView.vue:261-307` 无「仅自己可见」状态说明
- `apps/web/src/components/page/ShareDialog.vue` 无个人空间 / 公开链接差异化提示

**建议**:个人空间页面 ReadView 顶部加 lock icon chip 「仅自己可见 · 不能分享给其他人」;`ShareDialog` 在 `page.spaceKind === 'personal'` 时直接 disable 链接生成 + 解释。

---

#### 1.3 团队空间空态只有「创建页面」,不教用户下一步怎么组织

**现象**:新建团队空间后,空态只一个「创建第一个页面」CTA。建完后,系统不会告诉你「这是落地页吗?要不要设置成员?要不要邀请协作?」

**问题**:Confluence 空态会绑三个动作:创建首个页面 → 打开设置配置成员/权限 → 把现有页面设为落地页。当前只解决"产出一页",不帮用户把空间变成可用工作区。

**证据**:`apps/web/src/views/SpaceHomeView.vue:167-195` 空态只有 `createRoot`。

**建议**:空态拆 3 个动作:「创建首个页面」「配置成员/权限」「设置落地页」,以 secondary 链接形式陈列,主 CTA 仍是创建。

---

#### 1.4 团队空间首页缺列表 / 卡片密度切换

**现象**:空间里页面多了以后,只能用固定布局看,信息密度由系统决定。

**问题**:Confluence / Notion 都给用户切换列表 vs 网格视图的能力,且记住每个空间的选择。

**证据**:`apps/web/src/views/SpaceHomeView.vue:263`「浏览页面」动作只滚到 `.page-grid`,无视图模式 state。

**建议**:加 segmented control「列表 / 卡片」切换,持久化在 `localStorage` 或 `space_meta` 上。

---

#### 1.5 团队空间首页缺空间级信息架构引导

**现象**:空间首页=根页面目录。管理员没主动整理成根页面的话,首页变成一堆并列页面,新人不知道从哪看起。

**问题**:Confluence 空间首页能承载欢迎说明、关键入口、团队规则、常用链接。当前只有根页面列表,落地页能力已存在但首页不凸显。

**证据**:`apps/web/src/views/SpaceHomeView.vue:215-314` 主要由描述 + 根页面 + 最近构成,无空间级内容引导。

**建议**:落地页内容(已支持任意页设为 `/`)在首页顶部明确标注「当前落地页 = XXX」+「查看空间目录」入口,让落地页和目录共存。

---

#### 1.6 归档空间对普通用户完全隐形,无法确认自己曾用的空间是否被归档

**现象**:普通用户的空间切换器只显示未归档空间。原来用的空间突然消失,用户以为被删了 / 权限丢了 / 系统崩了。

**问题**:Confluence 会保留「已归档但你曾经访问过」分组,显示归档标记。当前实现把归档空间彻底从普通用户主列表隐藏,无任何反馈。

**证据**:`apps/web/src/components/layout/SpaceSwitcher.vue:59-63` 过滤掉 `archivedAt`。

**建议**:曾经访问过但已归档的空间,在切换器里保留「已归档」只读分组;若当前空间被归档,主页顶部出现归档横幅 + 「返回其他空间」动作。

---

#### 1.7 管理员视角下,归档空间没有"恢复 / 永久删除"的便捷入口

**现象**:管理员想恢复一个归档空间,只能走 TopBar ManagementMenu → 空间管理 → 在列表里找,中间多 2 跳。

**问题**:归档状态在 sidebar 顶部 active chip 上有 badge,但没有 action affordance —— 视觉信号 ≠ 操作入口。

**证据**:
- `apps/web/src/components/layout/Sidebar.vue:316-320` archived badge 无 action
- `apps/web/src/components/layout/SpaceSwitcher.vue:217-239` 归档空间只在 admin dropdown 出现

**建议**:archived 状态下,sidebar 顶部 active chip 旁加 inline 「恢复归档」按钮;`/manager/spaces` 加状态 filter「全部 / 正常 / 已归档」。

---

#### 1.8 空间设置单页超长(2595 行),缺内部分页 / 锚点

**现象**:管理员进入空间设置,基本信息 / 成员 / 权限 / 归档 / 删除全在一个长视图里,容易滚过头、误碰危险操作。

**问题**:Confluence 空间设置按"详情 / 权限 / 成员 / 内容工具 / 危险区域"分 tab,危险操作固定末尾独立卡片。

**证据**:
- `apps/web/src/views/manager/SpaceEditView.vue` 约 2595 行
- `apps/web/src/views/manager/ManagerLayout.vue:39-68` 没有空间设置内导航

**建议**:把 SpaceEditView 拆 4 tab(基本信息 / 成员 / 权限 / 危险操作),危险操作 tab 视觉降级 + 二次确认 dialog 必填。

---

#### 1.9 空间成员管理偏"查看权限计算",缺邀请和批量工作流

**现象**:管理员能看到成员行 + 来源 pill,但要加多人 / 删多人 / 批量调角色,只能逐行处理。

**问题**:团队空间的核心管理是"快速建立 / 维护成员集合",当前是诊断工具视图。

**证据**:`apps/web/src/views/manager/SpaceMembersTab.vue:34-119, 203-281` 渲染成员 + 来源,无批量;邀请表单位置需在 `manager/SpaceEditView.vue` 确认。

**建议**:表头加「邀请成员」入口、行选 checkbox、批量「移除 / 调整角色」按钮;来源信息降级为辅助解释,首要显示最终角色。

---

#### 1.10 权限矩阵 read / edit / admin 缺一眼可懂的能力说明

**现象**:管理员看到 read / edit / admin 三角,还得自己推"这能不能编辑页面""这能不能邀请人"。

**问题**:用户关心"这人最终能做什么",不是权限计算过程。Confluence 在角色名旁直接列能力白话。

**证据**:
- `apps/web/src/views/manager/SpaceMembersTab.vue:248-276` 重点呈现来源
- 项目范围中未定位到独立 `AccessControlMatrix.vue` 组件

**建议**:权限矩阵改成"角色 × 能力"简表:查看页面 / 创建页面 / 编辑页面 / 管理成员 / 修改空间设置,角色标题旁一句话白话定义。

---

#### 1.11 归档 / 解归档 / 删除缺统一生命周期说明

**现象**:操作完成后只 toast "操作成功",管理员不理解归档后谁还能看、能不能编辑、如何恢复。

**问题**:Confluence 在归档前后都给白话说明。

**证据**:`apps/web/src/views/manager/SpacesView.vue:216-264` 操作只确认 + toast。

**建议**:归档操作前 confirm dialog 加白话三段:归档后 → 谁还能看 / 谁不能编辑 / 如何恢复;归档空间首页和设置页都用同一套状态横幅。

---

#### 1.12 Manager 空间列表个人空间 vs 团队空间管理语义区分弱

**现象**:admin 进入「个人空间」tab,管理方式跟团队空间一样(成员、协作配置),但个人空间压根不支持成员协作。

**问题**:个人空间管理重点应是所有者和异常处理,不是成员 / 权限。共用 tab 结构容易让 admin 误操作。

**证据**:
- `apps/web/src/views/manager/SpacesView.vue:61-84` shared / personal 切换
- `apps/web/src/views/manager/SpacesView.vue:454-476` personal 行显示 owner

**建议**:personal tab 顶部加 "个人空间不支持成员协作" 提示;personal 行优先显示所有者 + 状态,隐藏团队空间成员 / 协作按钮。

---

#### 1.13 空间切换器切空间后总是跳首页,打断跨空间对照工作

**现象**:跨空间对照看两个页面时,切换空间瞬间跳回新空间首页,需要再次找原页。

**问题**:Confluence 在切换器下拉里给"最近页面"快速入口,可继续到对应页。

**证据**:`apps/web/src/components/layout/SpaceSwitcher.vue:27-33` 切换后 `router.push('/')`。

**建议**:切换器下拉每个空间行加「最近 3 个页面」inline 链接;保留当前安全兜底(切换后默认跳首页)。

---

#### 1.14 Sidebar 顶部 active 空间 chip 视觉像状态指示器,但实际可点击

**现象**:Sidebar 顶部那行"头像 + 空间名 + count"看着跟下面 row 视觉同款,但 hover 只有极弱的反馈,普通用户不知道它能点跳到空间首页。

**问题**:同 sidebar 上其他 row 全部 hover 高亮,只有 quick-nav 是例外,affordance 跟实际能力反着。

**证据**:`apps/web/src/components/layout/Sidebar.vue:469-475` `.quick-nav-active` hover 只升 text-1,无背景色。

**建议**:要么彻底拆掉 hover 反馈(label-only 状态量),要么复用 `.sh-item` 的 hover:bg-subtle 主动高亮。

---

#### 1.15 Sidebar 空间边界提示薄弱,深翻页面树时容易忘记当前在哪个空间

**现象**:页面树层级深,或 sidebar 滚动到底,顶部 active chip 视觉权重被压低,容易忘记「我现在在哪个空间」。

**问题**:Confluence 在 sidebar 持续提供空间名 + 空间图标 + 空间级入口,空间上下文不靠 TopBar 单点。

**证据**:`apps/web/src/components/layout/Sidebar.vue` 页面树区无独立空间标题。

**建议**:页面树 section 顶部 sticky 一个小型空间标题行(头像 + 名 + 类型 chip),跟页面树一起滚动时始终可见。

---

### P2

- **1.P2.a** 空间列表缺稳定排序(收藏 / 最近使用),5 个空间以内当前够用,但跨空间工作场景会反复找。
- **1.P2.b** 团队空间首页最近页面 + 根页面 + 我的页面三区同时出现,主任务不够聚焦。
- **1.P2.c** 空间设置变更成功后,缺"查看空间"的明确闭环入口。

---

## 4. 模块二 · 页面 / 视图(Read / Edit / History)

**模块判断**:Read / Edit 主流程完整,面包屑 / metadata / byline / 限制 / 归档 banner 到位。最大缺口是 Read 视图顶部 page-actions 缺复制 / 移动 / 删除(已有函数被注释),以及 edit / read 双视图的行为不一致。

### P0

#### 2.1 Read 视图顶栏缺复制 / 移动 / 删除入口

**现象**:用户打开一篇页面,顶栏只有「导出 / 历史 / 关注 / 限制 / 分享 / 编辑」6 个按钮,**没有任何「复制 / 移动 / 删除」入口**。要复制只能去 sidebar 找该页面行,点 kebab。

**问题**:Confluence / Notion 把 page tools 全部放顶栏,因为操作对象就是当前页,赶用户回 sidebar 找反直觉。`onDuplicate()` 函数在 ReadView 已写好,但按钮整段被注释。

**证据**:
- `apps/web/src/views/ReadView.vue:434-438`(`onDuplicate` 函数存在)→ `:661-671`(按钮整段被注释)
- `apps/web/src/views/ReadView.vue:672-713` 顶栏完全没有 move / delete 按钮
- `apps/web/src/components/layout/PageTree.vue:520-548`(delete 实现)、`:493-518`(duplicate 实现)都在

**建议**:解开注释恢复「复制」按钮;顶栏加「更多操作」下拉(Move / Delete / Duplicate / Copy link),跟限制 / 分享同档;store 方法共用同一套。

---

#### 2.2 Edit 视图脏数据状态下关闭无二次确认

**现象**:编辑过程中点顶部「关闭」按钮或路由跳转,**直接跳走,无 confirm dialog**。浏览器原生 beforeunload 只在 hard reload 时弹。

**问题**:auto-save 500ms 防抖兜底大部分,但 idle snapshot(30s)之前的窗口期用户可能误关;关闭是不可逆动作(相对"加撤回栈"),必须 confirm。

**证据**:
- `apps/web/src/views/EditView.vue:426-433` `closeEditor()` 直接 push 路由
- `apps/web/src/views/EditView.vue:559-562` `onBeforeRouteLeave` 不返回 false

**建议**:`closeEditor` / `onBeforeRouteLeave` 在 `isDirty.value` 为 true 时先弹 `useConfirm`,文案「离开后自动保存最后 N 秒的修改,确认?」+「强制离开(丢弃)」二选一。

---

#### 2.3 EditView byline 显示「创建时间」,Read 视图显示「最后编辑」,语义冲突

**现象**:同一页面,EditView 顶部显示「**X** · 创建于 2026-07-10」,ReadView 显示「**X** · 最后编辑于 [relative]」。

**问题**:用户在两个视图看到的时间语义不一样,普通用户会怀疑"我现在看的是哪个版本";Confluence / Notion 编辑器顶部显示最后修改对齐 reader。

**证据**:
- `apps/web/src/views/EditView.vue:689-694`(用 `page.createdAt`,注释明确说"创建于 X")
- `apps/web/src/views/ReadView.vue:871-880`(用 `page.updatedAt`)

**建议**:EditView byline 改为「**X** · 创建 · 最后编辑于 [relative]」两段时间都显示,或只保留最后编辑对齐 ReadView;「创建者」信息移到侧边 metadata 抽屉。

---

#### 2.4 Sidebar 顶部 active 空间 chip 不可点击

(同 1.14)

---

#### 2.5 NotFoundView 视觉跟全站 chrome 脱节

**现象**:404 页面只有居中的 SVG + 「返回首页」,没用 `.content-inner` 容器,没有 breadcrumb,没有 Sidebar 上下文,2K 视口下孤零零贴在中间。

**问题**:用户感觉「页面崩了」而不是「这页不存在」。Confluence 404 是带完整 chrome 的「该页不存在」面板,会给最近访问 / 搜索建议。

**证据**:`apps/web/src/views/NotFoundView.vue:14-49` 模板 + 样式。

**建议**:NotFoundView 加 `<Breadcrumb>` + `.content-inner` 容器,空态内给「最近访问」「按标题搜索」两个 CTA,跟 SpaceHomeView hero 节奏对齐;至少把当前 pathname 显示出来(`你访问了 /xxx,可能链接已失效`)。

---

#### 2.6 编辑器插入附件后,Read 视图某些情况下渲染缺失

**现象**:编辑态文件卡显示正常,切到 Read 视图**正文里只剩段落空白**,文件看不到。

**问题**:编辑态和阅读态是同一内容的两个视图,必须忠实复现;附件看不到会让用户怀疑上传丢失。需要核对 renderHTML 是否走同源,以及 sanitize 白名单是否漏。

**证据**:
- `apps/web/src/editor/imageAttachmentExtension.ts`(待核对)
- `apps/web/src/lib/sanitize.ts:50-55` `data-attachment-*` 看起来齐全
- `apps/web/src/components/editor/ImageAttachmentView.vue:55-63` 用了 fileIconFor

**建议**:让 ReadView 的 attachment 渲染跟 EditView 共用同一份 CSS class / 同一组件;若 read 端另起 `renderHTML` 路径,需收敛到 NodeView。

---

#### 2.7 TrashView 注释宣称的「批量恢复 / 永久删除」根本没实现

**现象**:TrashView 表格只有 checkbox 列、行级恢复 + 永久删除两个按钮,**没有表头 checkbox,没有批量底部浮起 footer**。代码注释明确写了「Checkbox column with select-all; selection drives a floating bottom action bar」—— 注释撒谎。

**问题**:Confluence 回收站的核心场景就是"上周 30 个老页面全删错了批量还原",行级一一点 30 次痛苦不堪;用户看到代码注释说有,实际点了没反应,以为是 bug。

**证据**:
- `apps/web/src/views/manager/TrashView.vue:6-9` 注释明确声明了「Checkbox column with select-all; selection drives a floating bottom action bar」
- `apps/web/src/views/manager/TrashView.vue:474-518` 实际只有 4 列(标题 / 删除者 / 删除时间 / 操作),无 th checkbox、无 td checkbox、无批量 footer

**建议**:补 th / td checkbox + 底部 fixed bar(选中 N 项时出「批量恢复」「批量永久删除」按钮),后端加 `POST /api/pages/trash/restore-batch` + `purge-batch`(事务清理)。

---

### P1

#### 2.8 Read 视图 metadata 块顺序混乱(Labels / Attachments / 点赞 / 子页 / 评论)

**现象**:Read 视图正文下方依次:AttachmentsSection → LabelPills → page-reactions → subpages → CommentsSection,每个 section 自己写 margin(24px / 32px 不统一)。

**问题**:Confluence metadata 块清晰层级:正文 → Labels(一级 metadata)→ Attachments → Children pages → Comments;「点赞」是 hover 浮动小表情,不是页面底部独立 section。

**证据**:
- `apps/web/src/views/ReadView.vue:898-945` 顺序
- `apps/web/src/components/page/LabelPills.vue:144` 强制 32px
- `apps/web/src/components/page/AttachmentsSection.vue:242` 24px

**建议**:统一顺序为 Labels → Attachments → Children pages → Comments,所有 section 间距统一 24px;reactions 改成 hover floating 或直接去掉。

---

#### 2.9 EditView byline hint「输入 / 唤起斜杠菜单」对鼠标用户是 noise

**现象**:byline 末尾「输入 / 唤起斜杠菜单」用 `<code>` 包了 `/`,鼠标用户点 toolbar 也能完成所有操作,这条 hint 是「键盘党暗号」。

**问题**:Confluence 的 byline hint 是动作提示,不是快捷键暗号。编辑器 placeholder 已经说了类似的话(`extensions.ts:188-190`),byline 上再写一次重复。

**证据**:`apps/web/src/views/EditView.vue:693`。

**建议**:改为「点工具栏选块 · 拖入文件上传附件」或直接删掉。

---

#### 2.10 EditView 关闭按钮无 hover 提示「会自动保存」

**现象**:顶栏「关闭」按钮裸的,没图标没 title,用户点之前不知道「关掉会不会丢东西」。

**问题**:Confluence 的 close 按钮 hover 会显示「关闭编辑器 · 已自动保存」。

**证据**:`apps/web/src/views/EditView.vue:660`。

**建议**:加 `:title="'关闭编辑器 · 离开前自动保存最后 ' + IDLE_SNAPSHOT_MS/1000 + ' 秒内的修改'"`,或加 cloud_done icon 暗示已同步。

---

#### 2.11 Read 视图「点赞」按钮只有图标 + 数字,首次使用 friction 大

**现象**:用户第一次看到 thumb-up 按钮,没 label 没说明,hover 才出 title;新用户不知道这是赞还是浏览数。

**问题**:Confluence / Notion 都有文字 label 或 hover bubble 说明;power-wiki 是内部工具,新人摩擦偏大。

**证据**:`apps/web/src/views/ReadView.vue:906-924` like-button 只有图标 + 数字。

**建议**:加 inline 小文字「赞」,或 hover 气泡「N 人觉得有用」;首次点击加 toast 反馈。

---

### P2

- **2.P2.a** 表格 resize hover + 按钮的视觉提示不全(需核实 `TableRowColumnActions` 是否覆盖所有 hover 位置)。
- **2.P2.b** 面包屑在父链 ≥5 段时折叠成「… / 父 / 当前」三段(可能已做,需核实)。
- **2.P2.c** 历史版本 restore 成功后无 toast / banner,用户不知道 restore 完了。

---

## 5. 模块三 · 编辑器 / 内容创作

**模块判断**:Tiptap 集成度高,SlashMenu 三段分组 + aliases 模糊匹配 + 最近使用都齐全,代码块语言选择、Callout 4 色、限制 dialog 白话都到位。最大缺口是粘贴纯 Markdown 不识别(`tiptap-markdown@0.8.10` 已装但没启用)和 @ 提及不发通知。

### P1

#### 3.1 粘贴纯 Markdown 文本(从 ChatGPT / Notion / Typora 复制)不被识别

**现象**:复制一段带 `**bold**`、`# heading`、`- list` 的 Markdown 粘进来,**按纯文本逐字落地**,`#` 和 `**` 直接显示成符号。StarterKit inputRules 只覆盖键入(`**bold**` → bold),粘贴整段走 PM 默认 pasteRule 不触发。

**问题**:Notion / Confluence / 飞书文档都把粘贴 Markdown 自动识别作为基础 UX;当前需要切到 ImportMarkdownModal 走"创建新页"流程(不能在现有页追加),或手工逐行格式化。

**证据**:
- `apps/web/src/components/editor/RichEditor.vue:219-240` `handlePaste` 只处理 files + 外部图片拦截,无 text/plain Markdown 检测
- `apps/web/src/editor/extensions.ts:120-134` 注释提到「Markdown 输入规则开启」仅指键入 input rules
- `tiptap-markdown@0.8.10` 已装(`CLAUDE.md` 标注:0.8.10 是 Tiptap 2.x 兼容的最后一个版本,0.9.0+ 需 Tiptap 3)

**建议**:加 `transformPastedText` PM plugin,检测 `text/plain` 是否含 Markdown 特征(`# `、`**`、`- `、`1. ` 开头行)走 prosemirror-markdown 解析;或直接在 paste 路径启用 tiptap-markdown。

---

#### 3.2 @ 提及成员后没有任何「通知该成员」的反馈

**现象**:@ 输入「张三」插入 mention 节点,无提示告诉用户「@ 之后会发通知」。Read 端 mention 节点高亮但编辑器里就是蓝色 chip。

**问题**:如果 mention 不真触发通知,那它只是「文字链接」语义;用户没有「为什么我要 @ 他」的反馈。Confluence / Notion 的 @ 是真通知 + 浮通知列表跳到该成员。

**证据**:
- `apps/web/src/editor/mentionExtension.ts`(待查)
- `apps/web/src/components/editor/SlashMenu.vue:722-736` `onPickUser` 只 `insertContent`,无通知触发

**建议**:@ 插入后浮 toast「已通知 张三」;若后端暂不通知,mention 节点视觉降级,避免误导。

---

#### 3.3 Read 视图附件渲染跟 Edit 视图不同源

(同 2.6)

---

### P2

- **3.P2.a** 表格 resize UI 不全(同 2.P2.a)。
- **3.P2.b** 工具栏按钮无文字 label,只有 icon,新用户发现成本偏高。

---

## 6. 模块四 · 导航 / chrome

**模块判断**:AppShell / TopBar / Sidebar / Breadcrumb / Subheader 单一组件生态已形成。P0 在用户高频路径(进入页面 / 404 / 归档空间)。P1 集中在 2K 视口下的 chrome 漂移和按钮超载。

### P0

#### 4.1 Sidebar 当前空间 chip 不可点击

(同 1.14)

#### 4.2 NotFoundView 视觉脱节

(同 2.5)

#### 4.3 Sidebar 归档空间无恢复 / 删除入口

(同 1.7)

---

### P1

#### 4.4 跨空间面包屑子页 crumb 链首段不带空间名,用户不知道自己越界

**现象**:跨空间访问页面(从 Sidebar 跨空间链接或「最近访问」中别的空间页),面包屑第一段直接显示「空间A / 父页 / 子页」,不带空间 B 名。用户复制深链给同事,同事打开会以为在同一空间。

**问题**:Confluence 跨空间深链面包屑首段固定空间名 + 切换。

**证据**:
- `apps/web/src/components/ui/Breadcrumb.vue:94-127` 模板
- `apps/web/src/composables/useBreadcrumb.ts` 中 `usePageBreadcrumbSegments` 取首段是当前 active 空间名而非页面所属空间

**建议**:跨空间时(`activeSpace.id !== page.spaceId`)首段加灰色 chip「在 X 空间」,点击跳该空间 home;或主动 setActiveSpace 切回主页。

---

#### 4.5 TOC 折叠手柄视觉权重太轻,2K 视口下消失在右缘

**现象**:点 toolbar「−」折叠 TOC 后,只剩右缘 24×48px 细条 + box-shadow 灰白;2560 视口下离内容列远,鼠标不贴边完全看不到。

**问题**:Confluence 的 TOC 折叠是 hover right-edge 高亮一条浮出图标,易触发。

**证据**:`apps/web/src/styles/components.css:1129-1149` `.toc-expand-handle`。

**建议**:折叠态 handle 改 32×64,左侧 1px accent 边框 + accent 文字色,affordance 视觉权重大于图标 + 投影。

---

#### 4.6 TopBar 在 2K 视口下右槽 ~150px 占 2000px 空白,严重右漂

**现象**:TopBar `1fr 600px 1fr` 网格,右侧 4 个 32px 按钮 + user avatar 总宽 ~150px,停在中间槽右端,跟左侧 brand + space switcher 之间留 ~2000px 空白,整个顶栏右半空旷。

**问题**:2560 视口下 chrome 漂移经典症状;Confluence 顶栏右侧塞"页面 likes / 关注 / 协作"上下文 chip 提高利用率。

**证据**:
- `apps/web/src/styles/components.css:24-40` topbar 网格
- `apps/web/src/components/layout/TopBar.vue:71-91` 右 rail 只有 4 个图标按钮

**建议**:management 跟 bell 之间加「当前页面 likes / 关注 / 协作」上下文 chip 区(只在 read / edit 视图显示),或顶栏加「最近协作页」ticker。

---

#### 4.7 PersonalHomeView cover「进入个人空间」链接跟 SpaceSwitcher 重复

**现象**:cover 有「进入个人空间 →」按钮,SidebarHomeItem「我的工作台」、UserMenu「我的空间」、SpaceSwitcher 选 personal 都跳 `/`。4 个入口同一种解读,新手点 cover 链接却看不到新内容,以为是链接坏了。

**问题**:多入口同一动作无差异化语义。

**证据**:
- `apps/web/src/views/PersonalHomeView.vue:295-303` `goPersonalSpace` 跳 `/`
- `apps/web/src/components/layout/SidebarHomeItem.vue`、`apps/web/src/components/ui/UserMenu.vue`、`apps/web/src/components/layout/SpaceSwitcher.vue:174-194` 同样跳 `/`

**建议**:保留 cover 链接但加差异化语义(如「我的草稿 / 收藏」section 锚点),或降级为 secondary link(当前视觉权重偏高)。

---

#### 4.8 SidebarSectionHeader 在 0 条时空态跟 row 视觉停顿

**现象**:「此空间的页面」section 0 条时,EmptyState 内有「创建第一个」CTA,28px + 8px padding 跟下面 row 视觉不连贯,中间 margin-top 4px 隔开,看起来"这下面是空 block"。

**说明**:WatchedSidebar 的 0 条处理最近刚收敛掉了 placeholder 行,但 Sidebar 「此空间的页面」 section 没同步收敛。

**证据**:
- `apps/web/src/components/layout/Sidebar.vue:338-376`
- `apps/web/src/components/layout/WatchedSidebar.vue:159-164` 刚收敛过(对比基准)

**建议**:EmptyState 紧贴 section header(0 margin),跟其他 row 节奏对齐;或跟 WatchedSidebar 一样在 0 条时切到非折叠态。

---

#### 4.9 NotificationBell / PageWatchButton 等组件还在用 `#fff` 硬编码

**现象**:**9 处组件**用 `#fff` 硬编码白色而非 `var(--text-invert)` / `var(--bg)`,违反 `tokens.css` 「禁止自造十六进制色值」硬约束。

**问题**:跟将来任何"白底按钮 — 颜色对比"调整脱钩。

**证据**:
- `apps/web/src/components/layout/NotificationBell.vue:254, 316, 360`
- `apps/web/src/components/comments/CommentsComposer.vue:191`
- `apps/web/src/components/ui/ToastContainer.vue:192`
- `apps/web/src/components/editor/SlashMenu.vue:1120`
- `apps/web/src/components/editor/LinkPopover.vue:164`
- `apps/web/src/components/editor/UploadStatus.vue:237`
- `apps/web/src/components/page/ShareDialog.vue:452`
- `apps/web/src/components/page/AttachmentLightbox.vue:119`
- `apps/web/src/components/comments/CommentItem.vue:591`

**建议**:统一替换为 `var(--text-invert)` 或 `var(--bg)`,跑 pnpm typecheck 兜底。

---

#### 4.10 PageActions 按钮超载时(6 个)无降级,1280 视口下挤爆 subheader

**现象**:ReadView `<PageActions>` 同时承载 ExportMenu + 历史 + 关注 + 限制 + 分享 + 编辑 6 个按钮,subheader 高 48px 单行;1280 视口下左侧 breadcrumb 占 ~400px,page-actions 总宽撑出 subheader 边界。

**问题**:Confluence 早期踩过同样坑,处理是「3 个高频直接显示 + 低频入 kebab」。

**证据**:
- `apps/web/src/views/ReadView.vue:660-714` 6 个按钮
- `apps/web/src/styles/components.css:115-125` subheader padding 24px / height 48px

**建议**:1280 视口下「历史 / 限制 / 分享」3 个低频按钮移入 ⋯ display_menu,主按钮留「关注 + 编辑」。

---

#### 4.11 AppShell 错误 / 离线 banner 跟 subheader / sidebar 视觉冲突

**现象**:`AppShell.vue` 把 offline-banner + error-banner 放 TopBar 之后、main 之前,占 40px + 24px;subheader 挤到下面,sidebar 顶部 sticky 锚点 `top: calc(var(--topbar-h) + var(--sub-h))` 不含 banner 高度 → sticky 头部突然多 64px 空白。

**问题**:Confluence 全局 banner 通常 overlay 在 topbar 之上,不动主体布局。

**证据**:
- `apps/web/src/components/layout/AppShell.vue:67-79`
- `apps/web/src/styles/components.css:283-285` sidebar sticky top

**建议**:banner 改 absolute overlay 在 topbar 下方,sticky 元素不变;或 banner 浮在 viewport 顶部(below topbar)且 own-position,加进 sidebar sticky top 计算。

---

### P2

- **4.P2.a** 团队空间首页无「展开全部目录」直链,长 tree 100+ 节点时 sidebar 滚动找很慢。
- **4.P2.b** 归档空间内 ReadView 缺状态 chip(只隐藏编辑按钮,用户以为可点)。
- **4.P2.c** 归档空间内面包屑首段「跳到空间主页」灰掉 + tooltip「空间已归档」。
- **4.P2.d** PageActions tooltip 太过技术化(「配置 X 的查看 / 编辑限制」→ 简化为「查看 / 编辑权限」)。
- **4.P2.e** SettingsDrawer 内部仍有 `#fff` 等硬编码(同 4.9)。
- **4.P2.f** AppShell loadError + error banner + offline banner 三段错误状态可能共存,需互斥。

---

## 7. 模块五 · 个人视图 / 管理后台

**模块判断**:Manager 后台覆盖 Confluence 约 65-70%(CRUD / 危险操作 / 权限来源可视化到位),但有 2 个显眼 P0:`PersonalHomeView` 丢后端数据 + `TrashView` 注释撒谎。ActivityView / WatchedView / PersonalHomeView 是「有但浅」,filter / 分组 / 草稿 UI 全缺。

### P0

#### 5.1 PersonalHomeView 完全不渲染后端给的 2 个 section(`personalSpace` / `watched`)

**现象**:后端 `GET /api/users/me/dashboard` 给 5 个 section(`mentions / personalSpace / created / watched / recent`),5 个 Promise.all 子查询全在跑,**前端只渲染 `mentions` / `created` / `recent` 三块,`personalSpace` 和 `watched` 两个字段前端 100% 忽略**。

**问题**:
1. Confluence "Your Work" 高频依赖「我 watch 列表的近况」,power-wiki `/me/watched` 路由存在但入口深藏在 sidebar「查看全部」—— 普通用户根本不知道;
2. 后端做了「个人空间草稿本」语义,前端丢掉 → 「跨空间移页前在个人空间起草」承诺落空;
3. 接口拉了 N+1 字段只用 3 个,流量浪费 + 不可见的语义缺位。

**证据**:
- `packages/shared/src/schemas.ts:1061-1071` `DashboardPayloadSchema` 5 字段
- `apps/api/src/routes/users.ts:619-796` 5 个 Promise.all 子查询
- `apps/web/src/views/PersonalHomeView.vue:130-490` 只取 `payload.mentions` / `payload.created`,`personalSpace` / `watched` ref **零读取**

**建议**:加两个 section —— 「我在个人空间起草的」(渲染 `payload.personalSpace`,按 updatedAt 排,头部 lock_person icon + 「进入个人空间 →」);「我关注的页面更新」(渲染 `payload.watched`,按 updatedAt desc,复用 ActivityView row 视觉)。

---

#### 5.2 TrashView 批量恢复 / 永久删除未实现

(同 2.7)

---

#### 5.3 SpacesView「个人空间」tab 空态文案误导

**现象**:admin 切到「个人空间」tab,永远看到「还没有个人空间 / 每个用户在第一次登录时会自动创建一个个人空间 / 当前还没有任何用户」。**只要系统里有用户,这条文案就在骗人**(个人空间是用户首次登录触发的)。

**问题**:admin 把团队招进来后才意识到「原来用户有个人空间」;要核实某用户有没有草稿目前只能进 TrashView 切 personal tab 查,不通。

**证据**:
- `apps/web/src/views/manager/SpacesView.vue:424-426` shared / personal 同一句文案
- `apps/web/src/views/manager/TrashView.vue:461-465` 同样

**建议**:SpacesView personal tab 空态改「还没有个人空间 — 用户首次登录时会自动创建」;personal 卡片可点击进 SpaceEditView(目前 onClick 已接 `manager-space-edit` 但没禁,owner 视角缺跳转)。

---

#### 5.4 PeopleView 搜索 0 命中时无 active filter chips,filter 集合不可见

**现象**:admin 在「人员」tab 选了「已禁用」+ 搜「张三」,表格清空,但页面上只有右上角那行「找到 X 个用户,系统共 N 个用户」(仅 `hasActiveFilter()` 时出现);筛选命中为空时,用户清空搜索词再次输入时,看不见自己当前生效的 filter 集合。

**问题**:Confluence 的「用户目录」在表格上方有动态文字「已应用 2 个筛选」+ chip 列表可直接删除;当前 filter 跟数据之间的因果链不可见。

**证据**:`apps/web/src/views/manager/PeopleView.vue:492-544` toolbar + 表格两段 `.users-shell` 包裹,filters 不以 chip 形式呈现在表格上方。

**建议**:toolbar 右侧加 active filter chips(「状态=已禁用 ×」「角色=管理员 ×」「张三 ×」),点 X 取消单个;clear-filters 按钮保留做 total reset。

---

### P1

#### 5.5 ActivityView 缺事件类型 / 时间 / 操作人三档 filter

**现象**:ActivityView 只有「空间」一个 dropdown + 「刷新」按钮,**没有事件类型筛选**(8 种 chip)、**没有时间维度**(今天 / 本周 / 本月 / 自定义)、**没有「只看我 + 我关注的」按人筛选**。

**问题**:百人 wiki 默认 feed 一次拉 50 条全是「张三编辑 / 李四创建 / 王五移动」混排,admin 找「上周谁移动过 page」只能手动 scroll + 肉眼 chip 颜色。

**证据**:`apps/web/src/views/ActivityView.vue:155-177` PageActions 区只有「空间」+「刷新」。

**建议**:PageActions 区加三档 select(事件类型 / 时间段 / 按操作人);事件类型用 chip 多选(因为 chip 颜色跟 row chip 同款天然一致)。

---

#### 5.6 WatchedView 跟 Sidebar「此空间的关注」子集 / 全集关系未暗示,且无分组

**现象**:Sidebar「此空间的关注」scope 锁 active space,5 条上限;`/me/watched` 是无 scope 锁的全空间分页视图。首次进 `/me/watched` 的用户对「这条 row 来自哪个空间」只能从 chip 颜色推断;WatchedView 平铺所有空间,2K 屏一眼看下来色块纷杂。

**问题**:Confluence 「Saved」视图通常按空间分组(让人扫到「工程那边我 watch 了 8 个、产品那边 3 个」)。

**证据**:
- `apps/web/src/views/WatchedView.vue:147-167` 不分组
- `apps/web/src/components/layout/WatchedSidebar.vue:131-149` 有分组概念但 scope 锁空间

**建议**:WatchedView 按 `p.spaceId` 分组,每组一段 header(空间头像 + 名 + 计数),组内 row;空组折叠。

---

#### 5.7 ActivityView 把个人空间事件泄漏到 workspace-wide feed

**现象**:选「所有空间」会看到自己 personal 空间的 created / edited 事件 —— 标题可能涉及敏感字眼,对其他空间成员不可见但你能在 feed 看到。

**问题**:Confluence 把 personal space 事件**排除**出 workspace feed;当前 `ALL_SPACES` 时不传 spaceId,前端让用户预期「所有空间 = workspace 共享」但语义含 personal。

**证据**:
- `apps/web/src/views/ActivityView.vue:43-87` ALL_SPACES 时不传 spaceId
- `apps/web/src/composables/useRecentActivity.ts:43-60` 透传 `api.pages.activity(null)`

**建议**:1) 核实后端 `pages.activity` 是否已过滤 personal;2) 即便过滤,UI dropdown 文案改「共享空间(全部)」,跟 personal 区分。

---

#### 5.8 PeopleContextPanel「最近登录」不可点但「最近活动」可点,不对称

**现象**:右栏 mini-list 两段 ——「最近登录」(用户 5 名,只展示不可点)、「最近活动」(5 个页面,可点跳 `/p/:id`)。两段外观一摸一样(都 `.mini-row`),hover 后只有第二段有反应,第一段完全静态。

**问题**:Confluence 的 recent users / recent activity 通常**整段 actionable**;当前不对称让人怀疑 bug。

**证据**:`apps/web/src/views/manager/panels/PeopleContextPanel.vue:198-208`(只展示)vs `:213-232`(可点跳)。

**建议**:两个 mini-row 都做成可点(user 行 → `/manager/people/users/:id`,加 hover 箭头);或都不可点 + 「查看全部活动 →」链到 `/activity`。

---

#### 5.9 TrashView 切 shared → personal tab 时不过滤 searchText / deletedByFilter

**现象**:admin 在 shared tab 选空间「工程」+ 输入搜索词 + 选删除者后,切到 personal tab,`selectedSpaceId` 重置但其他 3 个 filter 不清 → 新 tab 下"正在过滤"但无数据。

**证据**:`apps/web/src/views/manager/TrashView.vue:202-208` 只重置 `selectedSpaceId`。

**建议**:watch `kindTab` 时同步重置 searchText / deletedByFilter / sortKey;或加 active filter chips,跨 tab 给「清除筛选」按钮。

---

#### 5.10 AuditView 缺明确标题与 admin 域分离提示

**现象**:`/manager/audit` 顶 subnav 第 4 项,但进入后只看到「审计日志」标题,**没说覆盖哪几类事件**(实际是权限 / 共享 / 空间删除 / 归档 / 用户组删除 / 用户注销,**不涵盖 page 编辑**),用户会误以为是 Activity 别名。

**证据**:
- `apps/web/src/views/manager/ManagerLayout.vue:68-71` nav 第 4 项 `history` icon
- `apps/web/src/views/manager/AuditView.vue:1-20` JSDoc 提到 11 种 AuditKind 但无 one-line summary

**建议**:AuditView 顶部加 hero card(或 sub-header eyebrow)说明「本页面记录权限 / 共享 / 空间归档 / 用户注销等管理操作变更,**不记录页面编辑**(编辑请到「最近页面活动」)」;nav icon 改 `fact_check` 类避免跟 `/activity` 冲突。

---

#### 5.11 UserEditView「所在空间列表」section 缺失

**现象**:UserEditView 三段(基本信息 / 账号操作 / 危险操作)**没有「所在空间」section**;admin 想看「张三在哪些空间、什么角色」必须挨个空间进 SpaceEditView → MembersTab(4 hop 路径)。

**问题**:Confluence 给的是 User 详情页里直接「Memberships」段(空间 + 角色列表 + clickable 跳 SpaceEditView)。

**证据**:
- `apps/web/src/views/manager/UserEditView.vue:362-532` 三大段无空间列表
- `getEffectiveSpaceRolesForUser` 后端已存在,PersonalHomeView「共享空间与角色」section 已在用,UserEditView 复用即可

**建议**:加「所在空间」段,复用 PersonalHomeView `.ms-list .ms-row` 视觉(同一套 role pill)。

---

#### 5.12 SpacesView 删除空间对归档空间歧路

**现象**:已归档空间同时给 unarchive 和 delete 按钮,admin 容易选「既然能删何必先 unarchive」的歧路。

**证据**:`apps/web/src/views/manager/SpacesView.vue:216-264` `onDelete` 直接 confirm,没区分 archived / active。

**建议**:归档空间直接灰掉 delete 按钮,只保留 unarchive。

---

#### 5.13 PeopleView 邀请后无「再生成一次初始密码」

**现象**:admin 创建用户后弹一次性初始密码 banner,误关 banner 没复制就再也拿不到;后端没暴露「resend initial password」端点。

**证据**:`apps/web/src/views/manager/PeopleView.vue:428-452` `otp-banner`。

**建议**:banner 上加「再生成一次」(标记旧密码失效)。

---

#### 5.14 SpacesContextPanel「需要关注」区只列数字,无 drilldown

**现象**:右栏「空空间」「未授权」两个 StatBlock **纯数字,无 drilldown**;「未授权: 3 个」admin 要点回 SpacesView 主区挨个查。

**证据**:`apps/web/src/views/manager/panels/SpacesContextPanel.vue:65-80`。

**建议**:StatBlock 改 `<RouterLink>` 跳 SpacesView 加 query filter。

---

#### 5.15 PersonalHomeView cover 缺「设置 / 偏好」入口

**现象**:PersonalHomeView cover PageActions 只有「新建个人页面」「编辑资料」,**没有「通知偏好 / 时区 / 语言」** 横切设置入口。

**证据**:`apps/web/src/views/PersonalHomeView.vue:264-278` PageActions 区。

**说明**:CLAUDE.md 明确不做暗色 / 移动端 / 模板,但「通知偏好」「语言」横切设置是常态需求。

**建议**:加 secondary「通知偏好」link 进 PageActions 区。

---

### P2

- **5.P2.a** GroupEditView 删除按钮藏在 card 左下角,应提到 header 或独立 sticky danger zone。
- **5.P2.b** NotFoundView 太干净(已登记 2.5)。
- **5.P2.c** WatchedView empty state hint 用了 `👁` emoji,跟 material symbols 系统不一致 → 换 `visibility`。
- **5.P2.d** PeopleView / SpacesView loading 闪烁(文字 "加载中…" → skeleton)。
- **5.P2.e** ActivityView row 不展示 page ancestry(后端 `ActivityEvent` 加 `parentTitle` 一段)。
- **5.P2.f** 死代码:`apps/web/src/views/manager/UsersView.vue` / `GroupsView.vue` 已被 `PeopleView` 合并但未删;`SpaceMembersTab.vue` 单文件残留。

---

## 8. 综合下一步建议

按修复成本从低到高,建议下一波冲这 5 个 P0(全部是改现有文件,不引新依赖):

1. **Read 视图 page-actions 补复制 / 移动 / 删除入口**(解注释 + 加 kebab 下拉,共用现有 store)—— ~半天。
2. **PersonalHomeView 渲染后端 personalSpace / watched 两个 section**(零后端改动,纯前端加组件)—— ~半天。
3. **TrashView 补批量恢复 / 永久删除**(checkbox + footer + 后端两个新 batch 端点)—— ~1 天。
4. **Edit 视图 dirty 关闭 confirm + byline 时间语义对齐 ReadView**(单文件改)—— ~3 小时。
5. **NotFoundView 容器节奏对齐 + Sidebar active chip 视觉 / 能力对齐**(两文件改)—— ~3 小时。

这一波做完,产品可以从"主流程能用"升级到"内测给非开发同事用"的水位。

---

## 9. 附录 · P0 / P1 / P2 索引

### P0(8 条,卡用户核心使用)

| ID | 模块 | 一句话 |
|---|---|---|
| 2.1 | 页面 | Read 视图顶栏缺复制 / 移动 / 删除入口 |
| 2.2 | 页面 | Edit 视图脏数据关闭无二次确认 |
| 2.3 | 页面 | EditView byline 显示创建时间,Read 视图显示最后编辑 |
| 2.5 | 页面 | NotFoundView 视觉跟全站 chrome 脱节 |
| 2.6 | 页面 / 编辑器 | 编辑器插入附件后 Read 视图渲染缺失 |
| 2.7 | 管理 | TrashView 注释宣称的批量恢复未实现 |
| 5.1 | 个人 | PersonalHomeView 完全不渲染后端 2 个 section |
| 5.4 | 管理 | PeopleView 搜索 0 命中时无 active filter chips |

注:1.14 / 2.4 / 4.1(Sidebar active chip 不可点击)和 1.7 / 4.3(Sidebar 归档空间无恢复入口)各算一次,跨多视角。

### P1(18 条)

| ID | 模块 | 一句话 |
|---|---|---|
| 1.1 | 空间 | 团队空间 vs 个人空间首页产品差异过弱 |
| 1.2 | 空间 | 个人空间分享边界控制缺失 |
| 1.3 | 空间 | 团队空间空态只有「创建页面」 |
| 1.4 | 空间 | 团队空间首页缺列表 / 卡片密度切换 |
| 1.5 | 空间 | 团队空间首页缺空间级信息架构引导 |
| 1.6 | 空间 | 归档空间对普通用户完全隐形 |
| 1.7 | 空间 / 导航 | 归档空间缺便捷恢复 / 删除入口 |
| 1.8 | 空间 | 空间设置单页超长,缺内部分页 |
| 1.9 | 空间 | 空间成员管理缺邀请和批量工作流 |
| 1.10 | 空间 | 权限矩阵缺一眼可懂的能力说明 |
| 1.11 | 空间 | 归档 / 解归档 / 删除缺统一生命周期说明 |
| 1.12 | 空间 | Manager 个人 / 团队空间管理语义区分弱 |
| 1.13 | 空间 | 空间切换器切空间后总是跳首页 |
| 1.14 / 2.4 / 4.1 | 导航 | Sidebar 当前空间 chip 不可点击 |
| 1.15 | 空间 / 导航 | Sidebar 空间边界提示薄弱 |
| 2.8 | 页面 | Read 视图 metadata 块顺序混乱 |
| 2.9 | 页面 | EditView byline hint 对鼠标用户是 noise |
| 2.10 | 页面 | EditView 关闭按钮无 hover 提示 |
| 2.11 | 页面 | Read 视图「点赞」按钮首次使用 friction 大 |
| 3.1 | 编辑器 | 粘贴纯 Markdown 文本不被识别 |
| 3.2 | 编辑器 | @ 提及后无「通知该成员」反馈 |
| 4.4 | 导航 | 跨空间面包屑首段不带空间名 |
| 4.5 | 导航 | TOC 折叠手柄视觉权重太轻 |
| 4.6 | 导航 | TopBar 在 2K 视口下严重右漂 |
| 4.7 | 导航 | PersonalHomeView cover「进入个人空间」链接重复 |
| 4.8 | 导航 | SidebarSectionHeader 在 0 条时空态视觉停顿 |
| 4.9 | 导航 | 9 处组件用 `#fff` 硬编码 |
| 4.10 | 导航 | PageActions 按钮超载时无降级 |
| 4.11 | 导航 | AppShell 错误 / 离线 banner 视觉冲突 |
| 5.3 | 管理 | SpacesView「个人空间」tab 空态文案误导 |
| 5.5 | 个人 | ActivityView 缺三档 filter |
| 5.6 | 个人 | WatchedView 无分组 |
| 5.7 | 个人 | ActivityView 把个人空间事件泄漏到 workspace feed |
| 5.8 | 管理 | PeopleContextPanel mini-row 不对称 |
| 5.9 | 管理 | TrashView 切 tab 时不过滤其他 filter |
| 5.10 | 管理 | AuditView 缺明确标题与 admin 域分离提示 |
| 5.11 | 管理 | UserEditView 缺「所在空间列表」section |
| 5.12 | 管理 | SpacesView 删除空间对归档空间歧路 |
| 5.13 | 管理 | PeopleView 邀请后无「再生成一次初始密码」 |
| 5.14 | 管理 | SpacesContextPanel「需要关注」区无 drilldown |
| 5.15 | 个人 | PersonalHomeView cover 缺「设置 / 偏好」入口 |

### P2(13 条)

| ID | 模块 | 一句话 |
|---|---|---|
| 1.P2.a | 空间 | 空间列表缺稳定排序 |
| 1.P2.b | 空间 | 团队空间首页最近 / 根 / 我的页面三区优先级不稳 |
| 1.P2.c | 空间 | 空间设置变更成功后缺"查看空间"闭环 |
| 2.P2.a | 编辑器 | 表格 resize UI 不全 |
| 2.P2.b | 页面 | 面包屑在父链 ≥5 段时折叠(需核实) |
| 2.P2.c | 页面 | 历史版本 restore 成功后无 toast |
| 3.P2.a | 编辑器 | 表格 resize UI 不全(同 2.P2.a) |
| 3.P2.b | 编辑器 | 工具栏按钮无文字 label |
| 4.P2.a | 导航 | 团队空间首页无「展开全部目录」直链 |
| 4.P2.b | 导航 | 归档空间内 ReadView 缺状态 chip |
| 4.P2.c | 导航 | 归档空间内面包屑首段「跳到空间主页」误导 |
| 4.P2.d | 导航 | PageActions tooltip 太过技术化 |
| 4.P2.e | 导航 | SettingsDrawer 内部硬编码 hex |
| 4.P2.f | 导航 | AppShell 三段错误状态可能共存 |
| 5.P2.a | 管理 | GroupEditView 删除按钮位置 |
| 5.P2.b | 管理 | NotFoundView 太干净(已登记 2.5) |
| 5.P2.c | 个人 | WatchedView empty state 用 emoji |
| 5.P2.d | 管理 | PeopleView / SpacesView loading 闪烁 |
| 5.P2.e | 个人 | ActivityView row 不展示 page ancestry |
| 5.P2.f | 管理 | 死代码:UsersView / GroupsView / SpaceMembersTab 残留 |