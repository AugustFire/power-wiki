# 产品差距分析 · 2026-08-07

> **目的**:把 power-wiki 当前「打磨期间」跟 Confluence 标准的产品差距盘点一遍,作为后续打磨批次的输入。每个 gap 都从「现状是什么 → 用户感觉哪里别扭 → 在哪个文件哪个位置」一路写到代码层,方便排期时直接认领。
>
> **不做**:不评估「生产部署 / 安全 / 性能 / 移动端 / 暗色主题 / 全文检索 / 评论优化 / 表情 reaction / 辅助屏幕用户」——这些要么是项目硬约束禁区,要么是本次范围外。

---

## 0. 总览

整体看,**power-wiki 已经达到 Confluence 70%~80% 的「骨干能力」** —— 权限矩阵 / 页面限制 / 公开链接 / 协同锁 / Yjs CRDT / 审计 / 回收站 / Manager 后台 / 软删除 / 个人空间写矩阵都已经落地,这是「值得打磨」的前提。

剩下 20%~30% 的差距集中在**三处**:

1. **「上下文感」的丢失** —— 切换空间、打开页面、归档、邀请这些「场景切换」上没有清晰反馈,用户不知道「我现在在哪个空间 / 我刚才做了什么 / 我下次该怎么进来」。
2. **闭环缺口** —— 注册 / 邀请 / 忘记密码 / 自助加入空间这些本应是基础 SaaS 标配的流程完全没有,只能由 admin 人肉传密码。
3. **组件库的「最后一公里」** —— 视觉令牌跟 Atlas 对得很准,但 Menu / Undo / EmptyState variants / Token 字面量这几个组件库的「细节收口」没做完,导致每个视图都在自己造一遍轮子。

---

## 1. 范围与排除

**包含**:空间 / 页面 / 编辑器 / 阅读视图 / 协同 / 通知 / 评论 / 管理后台 / 登录注册 / 用户设置 / UI 组件库 / 设计系统落地。

**排除**(本次不动):
- 全文检索(`docs/loading-ux.md` 已规划但未开工)
- 评论系统的细节打磨(嵌套深度、reaction、@ 通知合并等)
- 辅助屏幕用户(WAI-ARIA、键盘导航)
- 移动端适配 / 暗色主题(CLAUDE.md 硬约束)
- 生产部署 / 安全 / 性能

---

## 2. 优先级定义

| 级别 | 含义 | 例子 |
|---|---|---|
| **P0**(必须打磨) | 用户日常使用的「主路径」上有明显堵点;不做,Confluence 级别的「骨干能力」撑不起来 | 空间上下文面包屑、邀请闭环、undo 机制 |
| **P1**(重要打磨) | 主路径上能凑合,但跟 Confluence 比明显粗糙;打磨后用户能直接感受到 | 通知实时性、管理后台的「用户/组活跃度」、Audit 筛选 |
| **P2**(可选打磨) | 不影响主路径,但补完能让「细节体验」显著加分 | 快捷键一致性、StatCard 复用、活动流热门排序 |
| **P3**(暂搁) | 现状能用,影响小或需要先有别的依赖 | 旧路由 dead code、preset 头像 fallback |

---

## 3. 模块清单

按用户旅程组织:

- **[5.1 空间与切换](#51-空间与切换)**
- **[5.2 主页与仪表盘](#52-主页与仪表盘)**
- **[5.3 页面交互(阅读/编辑/历史/活动)](#53-页面交互阅读编辑历史活动)**
- **[5.4 协同 / 通知 / 评论](#54-协同--通知--评论)**
- **[5.5 管理后台](#55-管理后台)**
- **[5.6 用户 / 登录 / 设置](#56-用户--登录--设置)**
- **[5.7 UI 组件库 / 设计系统落地](#57-ui-组件库--设计系统落地)**

---

# 4. 现状快照(给排期的人看的)

下面是「按用户旅程走一遍时,每个环节的现状打分」,1-5 分(5 = Confluence 同级)。

| 环节 | 分数 | 一句话评语 |
|---|:---:|---|
| 登录 / 强制重置 | 4/5 | 流程能跑,但缺「忘记密码」和「邀请链接」两个闭环 |
| 新用户首次进入 | 2/5 | 重置完直接落空白页,无 onboarding |
| 空间切换 | 3/5 | SpaceSwitcher 有,但顶栏没有空间面包屑,深链进页面就丢了空间感 |
| 空间主页(团队) | 4/5 | 仪表盘 + stats + recent + 配置空间主页都已做,「归档人」写死 null |
| 空间主页(个人) | 3/5 | 跟团队共用模板,1 个 root 页时显得空 |
| 页面阅读 | 4/5 | Skeleton / EmptyState / TOC / breadcrumb / 折叠块都齐,顶栏 ⋯ 菜单塞 11 项 |
| 页面编辑 | 4/5 | 14 组工具栏 + 9 个自定义扩展,但保存状态文案干、没有「X 分钟前」 |
| 页面历史 / 活动 | 4/5 | Confluence 风格 timeline 已做,缺按 author/日期筛选 |
| 协同(锁 + presence) | 4/5 | 5min TTL + 5 种 stateless + takeover 都做齐 |
| 通知 | 3/5 | 30s 轮询,无 WS push;`comment_add` kind 没差异化 label |
| 评论 | 4/5 | 跟 Confluence 一致,scope 内不动 |
| 管理后台(人员) | 3/5 | 双 tab + 详情 + 匿名化都做了,看不到用户的「活跃度」 |
| 管理后台(空间) | 4/5 | Card 形态完整,密度有点高 |
| 管理后台(回收站) | 4/5 | 批量 / 保留期策略都做了,缺 progress 弹层 |
| 管理后台(审计) | 3/5 | 搜索框是 disabled 占位,无 actor / 时间筛选,无 CSV |
| 设计系统落地 | 3/5 | tokens.css 对齐 Atlas,hex 字面量 101 处漂移,Menu 组件缺失 |

---

# 5. Gap 详细清单

## 5.1 空间与切换

### 🔴 [P0] 顶栏没有「当前空间」面包屑,深链进页面就丢了空间感

**现状是什么**:顶栏(`apps/web/src/components/layout/TopBar.vue:54-92`)只渲染「品牌 + SpaceSwitcher + 全局搜索 + Help / Activity / Management / 通知 / 用户菜单」,中间没有任何「当前空间」的视觉提示。

**用户感觉哪里别扭**:用户从邮件拿到 `/p/abc123` 直链点进来 —— 看到的是一篇 Confluence 风格页面,左右侧栏是页面树,但页面顶部、主区上方、面包屑第一段,都没有「你现在在「产品研发」空间」的明显提示。SpaceSwitcher 上的 trigger 是空间名,但很多用户的视觉重心在主区,容易忽略。

**问题在哪 / 怎么改**:在顶栏 `SpaceSwitcher` 后面(或 `appLayout: 'workspace'` 的 AppShell subheader 上)加一条空间面包屑 —— 显示 `图标 · 空间名 · [团队/个人] · 描述(可截断)`,深链进入时也常驻。在 1280px 视口下要能跟 `global-search` 共存,可以参考 Confluence「space icon + space name + space key」。

**代码位置**:`apps/web/src/components/layout/TopBar.vue`、`apps/web/src/components/layout/SpaceSwitcher.vue`(trigger 部分)。

---

### 🔴 [P0] SpaceSwitcher 在「只有一个空间且 active 就是它」时 trigger 退化,无任何反馈

**现状是什么**:`apps/web/src/components/layout/SpaceSwitcher.vue:75-80` 算出 `canOpen = false`,`toggle()` 直接 return,trigger 不渲染 caret 也不响应点击。

**用户感觉哪里别扭**:用户点 trigger 没反应、没有 tooltip、没有「无可切换空间」的说明 —— 一秒就怀疑「这是不是 bug?」。Confluence 在同样场景下 trigger 是灰显的、tooltip 写「You are in the only space you have access to」。

**问题在哪 / 怎么改**:`toggle` 在 `!canOpen` 时弹一个 2s 的小提示(tooltip 或 popover);trigger 的 cursor 改成 `default`,hover 灰底不变亮;或者直接渲染一个「全空间(1)」的 disabled 视觉。

**代码位置**:`SpaceSwitcher.vue:75-87`(`canOpen` / `toggle`)。

---

### 🔴 [P0] 空间邀请闭环完全缺失,onboarding 卡点了只弹 toast

**现状是什么**:
1. `apps/web/src/views/SpaceHomeView.vue:226-228`,「邀请队友加入」CTA 点了只弹 toast「请联系空间管理员邀请成员加入」,**没有任何邀请链接 / 邮件 / 链接生成端点**。
2. `apps/web/src/views/manager/SpaceMembersTab.vue` 有「添加成员」按钮,但 candidates 端点返的是**系统中已有的 user/group**,不是通过邮箱邀请新用户。
3. `apps/web/src/views/manager/PeopleView.vue` 只有「创建新用户」(生成初始密码 + OTP 一次性显示),没有「发送邀请邮件」。
4. 全仓 grep `invite|join.*request|apply` 0 命中相关端点。

**用户感觉哪里别扭**:
- 非 admin 用户找不到「邀请队友」的入口 —— onboarding 卡里点了只看到一条 toast 不知道找谁。
- 想要邀请新成员加入的 admin 只能「创建用户 + 口头传 OTP」,新人拿到 OTP 改密码之前没法自主重置。

**问题在哪 / 怎么改**:
- **MVP**:在 admin 创建用户时同时生成一个 7 天过期的「自助激活链接」(URL: `/invite/:token`)?本地不接邮件,但可以把链接复制出来发给用户;用户点链接 → 设置密码 → 进入系统。
- **进阶**:接 SMTP(项目目前搁置,见 CLAUDE.md「暂搁置安全相关」;但「邀请闭环」是产品闭环,不是安全,可以单独评估)。

**代码位置**:`apps/web/src/views/SpaceHomeView.vue:226-228`、`SpaceMembersTab.vue`、`PeopleView.vue`、`apps/api/src/routes/auth.ts`(无 register 端点)。

---

### ✅ [P1·已修 2026-08-07] `pageReadableDirectFilter` 与详情端点语义不等价,受限页在侧栏 / 列表里错位

**原始判断(基于 `docs/permissions.md` 的过期段落)**:SQL `WHERE pageReadableDirectFilter(me)` 只看 page 自身有没有 view 限制,不沿父链 BFS —— 父页限制后子页仍在侧栏可见、点开 404。

**实测下来是什么**:父链 BFS 早在 2026-08-03 P1-3 就随 `pages.inherit_view_restrictions` 一起补上了(`docs/permissions.md` 那句「已知 v0 局限」没跟着改,是文档 drift)。但同一段 SQL 跟权威解析器 `effectivePageReadAccess` 仍然不等价,**偏差方向反了**:

- 旧 SQL 写的是 `NOT EXISTS (链上所有 view 行 AND NOT 命中我)`,语义等价于「链上每一条 view 限制行都必须指向我本人」。allow-list 一旦有 2 个 principal(给 A 和 B 都开),A 会被 B 那一行判出局。
- walker 用的是 `isInAllowList`(任一命中即可)+「最近一条有 allow-list 的祖先说了算」(命中就 return,不跟更上层取交集)。

结果不是「侧栏可见 → 点开 404」,而是**「打得开、侧栏 / 列表里却没有」**。用户感觉是「明明有人把页面分享给我了,我却在树里找不到」。单 principal 场景恰好不暴露,所以 2026-08-03 的验收脚本全绿。

**怎么改的**:`pageReadableDirectFilter` 的 CTE 改成先沿父链(每跳由当前节点的 `inherit_view_restrictions` 决定是否继续)定位**深度最小的受限节点**,再判「我是否命中它 allow-list 里的任意一条」,跟 walker 逐字对齐。denormalized JSONB 列 + trigger 的方案没做 —— 页深度一般 < 10,CTE 是 O(depth) 的 index seek,list 端点 P95 没退化,不值得引入去规范化带来的一致性负担。

**回归**:新增 `scripts/verify_p1_list_detail_parity.py` —— 5 个场景(多 user allow-list / user+group 混合 / 祖父+父双层限制 / 单 principal 继承 / `inherit=false` 跳出)对每个角色**同时**打详情端点和 list 端点,断言两者答案相同。修前 12 FAIL,修后 24/24 PASS;`verify_p1_3_inherit_view_restrictions.py`(25)、`verify_phase_b_page_restrictions.py`(43)、`verify_journey_b_space_admin_bypass.py`(18)全绿。

**代码位置**:`apps/api/src/lib/permissions.ts:pageReadableDirectFilter`、`docs/permissions.md`「view 沿父链 BFS 继承」节。

---

### 🟡 [P1] 跨空间移动 page 不支持,「发布到」只允许 personal → shared

**现状是什么**:`apps/web/src/components/layout/PageTree.vue` 注释里写死「发布到」只允许 personal → shared(走 `canPublish` 谓词);`movePageToSpace` 跨 space 路径直接没有。

**用户感觉哪里别扭**:用户在 A 团队空间写了一篇「Q4 招聘规划」,想搬到 B 团队空间 —— 只能复制 + 手动改 + 删除原页。原页面的评论 / 关注 / 历史 / 子树全部丢失。

**问题在哪 / 怎么改**:在 `⋯` 菜单「移动」里加「移动到其他空间」,弹 SpacePicker 选目标空间(只列自己有 editor+ 的)+ 「保留历史 / 不保留」两个开关。后端开新端点 `POST /api/pages/:id/move-to-space`,事务里 update `space_id` + `page_yjs_state` 迁移 + audit。

**代码位置**:`PageTree.vue`、`apps/api/src/routes/pages.ts`。

---

## 5.2 主页与仪表盘

### 🔴 [P0] 新用户首次登录空白,无 onboarding

**现状是什么**:
- 重置密码完成后 `router.replace('/')`(LoginView.vue:52-54),**没有 onboarding 引导**。
- `EmptySpaceOnboarding` 只在「空间为空时」触发,不是「用户首次进入」触发。
- `PersonalHomeView.vue` 的「快速操作条」3 个 tile + 待办卡也不区分「是否首次」。

**用户感觉哪里别扭**:新用户用 OTP 登入 → 强制重置密码 → 直接落 `/` —— 看到的可能是:
- 「产品研发」空间 + 一片空白页树(EmptySpaceOnboarding 出现,3 卡指引建第一页)。
- 也可能「产品研发」空间 + 一堆历史页(没有任何「欢迎,这是你的团队」之类的)。
- 个人空间则更空。

**问题在哪 / 怎么改**:
- **短期**:在 `EmptySpaceOnboarding` 增加「首次进入」识别 —— `localStorage.power-wiki:onboarded` 不存在时第一次落 `/` 显示「欢迎卡」(名字 + role chip + 3 步:建第一页 / 邀请队友 / 改个人资料),关掉后写入 flag。
- **中期**:把 onboarding 状态写进 DB(`users.onboarded_at`),跨设备同步。

**代码位置**:`LoginView.vue:52-54`、`EmptySpaceOnboarding.vue`、`PersonalHomeView.vue`。

---

### ✅ [P0·已修 2026-08-07] 个人空间没有自己的主页,跟 team 空间共用模板显得空

**怎么改的**:`SpaceHomeView.vue` 收口成 team-only —— 删了 `fallbackSpaceName` / `crumb-lock` / `EmptySpaceOnboarding` 的 `kind="personal"` 分支,首页的 `homepagePageId` watch 升级成统一 watch,把「`/` 在 personal 下重定向到 `/me`」和「`/` 在 team 且有 homepage 时重定向到 `/p/<id>`」收口到同一处。`EmptySpaceOnboarding` 同步收紧成 shared-only(personal 空态由 `PersonalHomeView` 的 todo card 兜底)。UserMenu 的「我的空间」和 `router.beforeEach` 的注释同步更新。

行为:`/` 在 active=personal 时 1 帧内重定向到 `/me`,让已经存在的 `PersonalHomeView`(1894 行,profile cover + 5 tile 快速操作 + mentions / created / personalSpace / watched / recent / shared 6 个 section + todo card 兜底)成为 personal 唯一入口。短期方案(改 stats 文字)被否决 —— 那是「一个组件根据 kind 分支」的延伸,跟 team/personal 是两个产品的强约束冲突。

**怎么验证**:
- `verify_p1_7_home.py`:UserMenu「我的空间」终点断言从 `/` 反转成 `/me`(断言 `.personal-home-shell` 挂载、`我的工作台` 面包屑);redirect_context 直接访问 `/#/` 的终点断言同样反转。新增 `redirected /me breadcrumb says 我的工作台` 断言。
- `verify_p3_personal_home.py`:`个人空间 tile` 导航终点从 `/` 改 `/me`。
- `pnpm typecheck` 绿。

**代码位置**:`apps/web/src/views/SpaceHomeView.vue`(统一 watch + 删 personal 分支)、`apps/web/src/components/space/EmptySpaceOnboarding.vue`(删 `kind` prop)、`apps/web/src/components/ui/UserMenu.vue`(注释同步)、`apps/web/src/router/index.ts`(`beforeEach` 注释同步)、`scripts/verify_p1_7_home.py`、`scripts/verify_p3_personal_home.py`。

---

### 🟡 [P1] 归档空间「归档人」永远显示 `?`

**现状是什么**:`apps/web/src/views/SpaceHomeView.vue:44` `archivedByName = computed(() => null)`,写死返回 null,UI 上归档 banner 渲染「归档于 X」但「归档人」位置恒为 `?`。

**用户感觉哪里别扭**:归档 banner 应该是「X 月 X 日由 张三 归档」,现在 `?` 显示得很丑。

**问题在哪 / 怎么改**:`spaces` 表加 `archivedBy: text | null`(CLAUDE.md 硬约束:不写 FK,但加 text 字段 OK)。后端 `archiveSpace` 时写 `archivedBy = me.id`。前端 `activeSpace.archivedByName` 走用户反查(store 已 attach users 缓存)。

**代码位置**:`SpaceHomeView.vue:42-44`、`apps/api/src/db/schema.ts:spaces`、`apps/api/src/routes/spaces.ts`。

---

### 🟢 [P2] 仪表盘无「热门 / 置顶 / 收藏」排序

**现状是什么**:`SpaceHomeView` 的「我最近访问」「推荐浏览」「最近编辑」都是按时间倒序;`ActivityView` 也只有时间排序。PageNode 数据模型没有 `pinnedAt` / `popularityScore` 字段。

**用户感觉哪里别扭**:Confluence 的 space home 有「Pinned」「Popular」「Recent」三栏,管理员可以置顶公告。power-wiki 团队空间入口完全靠「最近」,有重要公告页会沉底。

**问题在哪 / 怎么改**:`pages` 表加 `pinnedAt: bigint | null` + `pinnedBy: text | null`,`GET /api/spaces/:id/home` 返回时把 pinned 排在最前(space-admin 可置顶)。`popularityScore` 不建议做,推荐先支持「管理员置顶」。

**代码位置**:`SpaceHomeView.vue`、`apps/api/src/db/schema.ts:pages`。

---

## 5.3 页面交互(阅读/编辑/历史/活动)

### 🔴 [P0] EditView 顶栏 6 元素在 1280 视口下拥挤

**现状是什么**:`apps/web/src/views/EditView.vue:649-703`,顶栏顺序:`Breadcrumb + 编辑中 badge + 保存状态(5 选 1)+ 限制 + 分享 + 关闭` —— 6 个元素。在 1280px 视口下基本要换行(breadcrumb 长标题时挤掉保存状态指示器)。

**用户感觉哪里别扭**:用户保存一篇长标题的页面,breadcrumb 占用大量宽度,「已自动保存」指示器被挤到边缘看不见。

**问题在哪 / 怎么改**:
- 「限制」和「分享」是低频操作,移到 ⋯ 菜单(已经有 `PageMoreActionsMenu` 的范本),跟 ReadView 对齐。
- 保存状态从独立 div 改成紧凑的「小圆点 + tooltip」(hover 显「1 分钟前已自动保存」),省空间。
- 关闭按钮改 icon-only(`close` material icon)。

**代码位置**:`EditView.vue:649-703`。

---

### 🔴 [P0] auto-save 状态文案「已自动保存」太干,没有「X 分钟前已保存」

**现状是什么**:`EditView.vue:655-674`,5 个互斥 div:`saving / saved / error / pending / idle`,文案是「正在保存… / 已自动保存 / 保存失败 / 有未保存的修改 / 已同步」。**没有「X 分钟前」相对时间**,也没有 hover 提示「上次保存时间」。

**用户感觉哪里别扭**:用户写完一段,看「已自动保存」不知道是 5 秒前还是 5 分钟前,无法判断「我现在的内容是否安全」。

**问题在哪 / 怎么改**:`saveState` 加 `lastSavedAt: number | null`,idle 状态显示「已同步 · X 分钟前」(实时刷新:每 30s tick 一下),saved 显示「已自动保存 · X 秒前」。相对时间用现成的 `formatRelativeTime`。

**代码位置**:`EditView.vue:655-674`、`usePageAutoSave`(composable,文件未亲自读但 agent 标记「5 态机 + 30s idle snapshot」)。

---

### 🔴 [P0] ReadView 顶栏 ⋯ 菜单 11 项堆叠,功能寻找成本高

**现状是什么**:`apps/web/src/components/page/PageMoreActionsMenu.vue:215-368`(`page/` 目录下唯一一个 kebab 菜单),菜单内容(无权限可见的子集):
1. 导出 HTML / MD / PDF(3 项,各带 spinner)
2. 页面历史
3. 限制
4. 分享
5. 移动
6. 复制页面
7. 复制整棵子树(仅 hasChildren 时)
8. 复制链接
9. 删除(底部 danger 色)

菜单高度 ≈ 600px,1280 视口下要滚动。

**用户感觉哪里别扭**:用户想分享,看到 ⋯ 进去要往下扫一眼 —— 找了 1-2 秒才发现「分享」。导出 PDF / 复制整棵子树这种不常用功能占据视觉重心。

**问题在哪 / 怎么改**:
- 重组菜单结构(按使用频率降序):
  - **顶部高频区**(无分隔):复制链接、关注状态、页面历史
  - **内容导出**(分隔):导出 HTML / MD / PDF
  - **组织管理**(分隔,按权限):限制、分享、移动、复制页面 / 子树
  - **危险**(分隔,danger 色):删除
- 复制链接(占比 80%)提升到顶栏直接做成快捷按钮(跟关注按钮并列)。
- 导出 PDF 走 `window.print()` 的事下面单独提。

**代码位置**:`PageMoreActionsMenu.vue`、`ReadView.vue:783-794`。

---

### 🟡 [P1] 导出 PDF 走浏览器 `window.print()`,依赖用户「另存为 PDF」

**现状是什么**:`PageMoreActionsMenu.vue:252`,导出 PDF 描述「通过打印对话框保存」,点开就是 `window.print()` 弹浏览器打印面板。

**用户感觉哪里别扭**:
- 用户期望「点导出 → 拿到一个 PDF 文件」,而不是「弹一个打印对话框让我手动选打印机」。
- 打印样式(`print.css`)虽然存在,但 PDF 渲染依赖浏览器,PDF 不能定制页眉页脚 / 页面大小 / 是否含评论。

**问题在哪 / 怎么改**:
- **短期**:在「导出 PDF」按钮旁边加 ⓘ tooltip 说明「将在新窗口打印预览,可另存为 PDF」,避免用户困惑。
- **中期**:服务端 headless 渲染(Puppeteer / Playwright)生成 PDF,文件名取页面标题,默认 A4 + 1cm 边距,带 cover 页(标题 / 作者 / 时间 / 空间名)。

**代码位置**:`PageMoreActionsMenu.vue:243-256`、`apps/web/src/styles/print.css`。

---

### 🟡 [P1] 附件上传进度面板只在编辑器内可见,ReadView 上传附件时不在视野内

**现状是什么**:`apps/web/src/stores/uploads.ts` + `UploadStatus.vue` 顶部面板(从 agent 报告可知),但仅在编辑器内可见。ReadView 上传附件(虽然 CLAUDE.md 写明「编辑器内仍不接头像」,但 ReadView 的附件视图 / 编辑器附件是分开的)的进度不在用户视野内。

**用户感觉哪里别扭**:用户在 ReadView 点击附件卡片做「下载」是 OK 的,但如果要换附件 / 重新上传,**进度反馈在哪?** —— 这条能力目前未实现,CLAUDE.md 也没规划,见下面 P3 备注。

**问题在哪 / 怎么改**:
- 上传面板升级为全局 `ToastContainer` 同级,挂 `App.vue` 顶层,所有页面共享。
- 失败时 toast 自动带「重试」按钮(`ui.notify` 已支持 `action` 字段,目前只有 UploadStatus 在用)。

**代码位置**:`apps/web/src/stores/uploads.ts`、`UploadStatus.vue`、`App.vue`。

---

### 🟢 [P2] PageHeader / PageMeta / MoveCopyDialog 三个设计意图组件未落地,inline 模板散在 ReadView

**现状是什么**:agent 验证 `components/page/` 目录下,**没有 PageHeader.vue / PageMeta.vue / MoveCopyDialog.vue**。byline / tags / 标题 / 操作区都是 inline 模板在 ReadView.vue 920-1030 行。移动走 `uiStore.openMoveDialog({ pageId })` 触发,但 modal 不在 `components/page/` 下。

**用户感觉哪里别扭**:开发者视角的问题,不影响用户。但下次有人想改 byline 的样式,要在 1133 行的 ReadView 里改,容易碰到别的逻辑。

**问题在哪 / 怎么怎么改**:把 ReadView 的头部 / meta / 移动三块拆成 `PageHeader.vue` / `PageMeta.vue` / `MoveCopyDialog.vue`,接收 props(events),让 ReadView 模板变薄。

**代码位置**:`ReadView.vue:920-1030`、`uiStore.openMoveDialog`。

---

### 🟢 [P2] HistoryView 没有按「自动 / 手动 / author / date」筛选

**现状是什么**:`apps/web/src/views/HistoryView.vue` Confluence 风格 timeline + diff 双列已做(280-285),但 agent 验证:**没有按「自动 / 手动」过滤版本 / 没有 search by author / date**。

**用户感觉哪里别扭**:用户想知道「上周张三个人改了什么」 —— 现在只能翻 timeline,要么看 diff 时来回切,体验比 Confluence 弱。

**问题在哪 / 怎么改**:顶部加 filter bar(3 段):kind(自动 / 手动 / 全部)、author(单选下拉)、日期范围(最近 7 天 / 30 天 / 全部)。复用现有 `usePaginatedList`。

**代码位置**:`HistoryView.vue`、`apps/api/src/routes/pageVersions.ts`。

---

### 🟢 [P2] breadcrumb 第一段恒为「我的知识库」,团队空间用户用不到

**现状是什么**:agent 验证「所有视图统一用 `<Breadcrumb :segments=...>`,根段恒为 `{ label: '我的知识库', to: '/' }`」。

**用户感觉哪里别扭**:在「产品研发」空间里,breadcrumb 永远是「我的知识库 / 产品研发 / Q4 OKR」。第一段「我的知识库」没有任何信息价值 —— 它其实就是 `/`,跟 SpaceSwitcher 重复。

**问题在哪 / 怎么改**:把第一段改成当前空间图标 + 空间名(`{ label: '产品研发', icon: 'engineering', to: '/' }`),个人空间时显示 `{ label: '我的个人空间', icon: 'lock_person', to: '/' }`。这样 breadcrumb 自带空间上下文,跟前面 P0「顶栏空间面包屑」互补。

**代码位置**:`usePageBreadcrumbSegments`(composable)、`Breadcrumb.vue`。

---

## 5.4 协同 / 通知 / 评论

### 🔴 [P0] 通知 30s 轮询,无 WS push,「别人 @ 我」要等最多 30 秒

**现状是什么**:
- `apps/web/src/composables/useNotifications.ts`:模块级单例,30s 自适 `refreshUnread`,visibilitychange 时 hidden skip / visible 主动 tick。
- `apps/web/src/stores/notifications.ts`:不订阅 push,只能 30s 轮询触发刷新角标数字。
- 后端协同有 Hocuspocus(8788 端口)在做页面级 push,但**通知中心没有走 WS**。

**用户感觉哪里别扭**:用户在团队空间发评论 @ 张三,张三正在写另一篇页面 —— 30 秒后铃铛角标才 +1。如果是「等别人回复」的场景,体感是「我留言了,过了半分钟他才看到」。

**问题在哪 / 怎么改**:
- 复用 Hocuspocus 通道:`onStateless` 多加一种 `notification_new` event,后端 `enqueueNotifications` 同事务后通过 `lib/pageLockEvents.ts` 风格的 channel 推 `userId -> notification`。
- 客户端 `notificationsStore` 订阅 push event,即时 +1 + 抽屉里 prepend。
- 短期可接受先在 store 层加一个 `user-visibility + WebSocket readyState` 的 fallback,visible 时主动 tick 一次。

**代码位置**:`useNotifications.ts`、`notifications.ts`、`apps/api/src/collab/stateless.ts`、`apps/api/src/lib/notify.ts`。

---

### 🟡 [P1] 通知 kind 覆盖缺口,`comment_add` 落到 fallback label

**现状是什么**:`apps/web/src/components/layout/NotificationBell.vue` 有 `HUMAN_KIND` 映射,**仅覆盖 4 种**:`mention` / `reply` / `comment_on_my_page` / `page_like`。但 `enqueueWatchFanout` 还会发 `comment_add`,UI 上落到 fallback label(`HUMAN_KIND[n.kind] ?? '通知'`),没有差异化展示。

**用户感觉哪里别扭**:用户关注了某页 A,A 页有新评论时收到两条通知 —— 一条是「comment_on_my_page」(因为我写过这条线?不对),一条是「comment_add」(来自 watch fanout),两条长得几乎一样,用户不知道「哪条是什么」。

**问题在哪 / 怎么改**:
- `HUMAN_KIND` 补全 `comment_add`(「X 收到新评论」)、`page_share_create` / `page_share_revoke`、`space_grant_*`(「你在 X 空间被授予 Y 角色」)。
- 视觉上把 watch fanout(他人操作)跟 @ / 回复(我的操作)分两个分组,用 subtle divider。

**代码位置**:`NotificationBell.vue`、`HUMAN_KIND` 常量。

---

### 🟢 [P2] 评论提交成功无 toast,失败走 inline error

**现状是什么**:agent 验证「评论提交成功没 toast,失败走 inline `.cs-error`」,删除错误走 `.ci-error`,编辑错误走 `.ci-edit-error` —— **评论错误全 inline**。

**用户感觉哪里别扭**:用户写完一段评论 + Cmd+Enter,期待看到「已发送」反馈(Toast 或者 inline pill),现在只在列表里 prepend 一行 —— 用户可能盯着光标没看到 prepend 就开始写下一条了。

**问题在哪 / 怎么改**:跟 ShareDialog 的取舍对齐 —— 「成功不弹 toast,用 pill 状态变化代替」可以,但当前 CommentsComposer 的 pill 缺失。composer 提交成功后 1.5s 显示一个 ✓「已发送」pill,贴 composer 右上角。

**代码位置**:`CommentsComposer.vue`、`CommentsSection.vue`。

---

## 5.5 管理后台

### 🔴 [P0] 管理后台没有「邀请 / 自助注册」闭环,新用户只能 admin 创建 + 口头传 OTP

**现状是什么**:
- `apps/web/src/views/manager/PeopleView.vue` 有「创建新用户」+ 生成 OTP,**没有「发送邀请邮件」**。
- OTP banner「仅显示一次」(PeopleView.vue:451-475)无撤回 / 重发机制 —— admin 误关了 banner 就得「重置密码」重新生成。

**用户感觉哪里别扭**:
- 团队招新人,admin 创建账号后只能口头 / IM 发 OTP,新人收到一串字符一脸懵。
- admin 不小心关了 banner,新人问「密码多少?」—— admin 没法告诉他,只能再点「重置密码」(生成新 OTP 但新人原来的 OTP 失效)。

**问题在哪 / 怎么改**:见 5.1 「空间邀请闭环缺失」,这个是同一个根问题的两个表现 —— 没有 invite 端点。在 admin 创建用户时多给一个选项:**「生成 7 天有效的自助激活链接(可复制)→ 链接式邀请」**,而不是默认显示 OTP。

**代码位置**:`PeopleView.vue:451-475`、`apps/api/src/routes/adminUsers.ts`。

---

### 🟡 [P1] UserEditView 看「该用户的活跃度」信息缺失

**现状是什么**:`apps/web/src/views/manager/UserEditView.vue` 1091 行,提供:
- 基本信息(name / color / status / role)
- 头像 / 密码
- `/admin/users/:id/spaces`(他加入的空间 + role + sources)
- 匿名化 / 禁用

**看不到**:
- 该用户**创建的页面列表**
- 该用户**关注的页面**
- 该用户**点赞过的页**
- 该用户**通知历史**
- 该用户**评论历史**
- 该用户**登录历史 / IP**

**用户感觉哪里别扭**:admin 想知道「这个用户最近在干嘛」 —— 现在只能切到「审计」按 actor 过滤,但 audit 不覆盖「页面编辑 / 创建 / 移动」(eyebrow 写明,跟「最近页面活动」职责分离)。

**问题在哪 / 怎么改**:UserEditView 加 4 个 tab(基本信息 / 空间 / 活动 / 安全),「活动」tab 复用 `ActivityView` 但限定 actor = 此 user;「安全」tab 列登录时间 / IP(简单几条审计行)。

**代码位置**:`UserEditView.vue`、`apps/api/src/routes/adminUsers.ts`。

---

### 🟡 [P1] GroupEditView 看不到「该组实际生效于哪些页面」

**现状是什么**:`apps/web/src/views/manager/GroupEditView.vue` 676 行,提供:
- 基本信息(name / desc)
- 两栏 transfer list(已添加成员 / 可添加用户)
- 删除预拉 `impact` 端点

**看不到**:
- 该组在所有 space 的授权(只在 SpaceGrantsTab 里能看到,且是「以 row 形式」混在所有空间授权里)
- 该组在所有 page 的限制(view / edit)
- 该组在 audit 中的历史
- 组成员加入时间

**问题在哪 / 怎么改**:GroupEditView 加 3 个 tab(基本信息 / 成员 / 授权),「授权」tab 列「在哪些空间有授权 + 在哪些 page 受 view/edit 限制」,可点击跳详情。

**代码位置**:`GroupEditView.vue`、`apps/api/src/routes/adminGroups.ts`。

---

### 🟡 [P1] AuditView 搜索框是 disabled 占位,无 actor / 时间筛选,无 CSV 导出

**现状是什么**:`apps/web/src/views/manager/AuditView.vue` 980 行:
- 11 种 `AuditKind` 硬编码 + 5 种 `targetKind`,tools 是软联动(选 kind 自动收窄 targetKind)。
- **搜索 input 是 disabled**(模板注明「留作 v2」,实际 UI 上是个被禁用的空 input 占位)。
- 无 actor / 时间范围筛选。
- 无 CSV 导出。
- 不覆盖页面编辑 / 创建 / 移动(eyebrow 写明)。

**用户感觉哪里别扭**:admin 想找「上周张三个人授了什么权限」 —— 现在只能翻 timeline + 用 kind 过滤,体验很差。Confluence 的 audit 有 actor + 时间 + target 三轴 filter + CSV 导出。

**问题在哪 / 怎么改**:
- 启用搜索(允许按 `payload JSON 文本搜索`)
- 加 actor 多选 + 时间范围 picker
- 加「导出 CSV」按钮,服务端 `GET /api/admin/audit/export` 返回 stream
- 思考清楚后扩展 audit 覆盖到 page 编辑/创建/移动(本期可选)

**代码位置**:`AuditView.vue`、`apps/api/src/routes/adminAudit.ts`。

---

### 🟡 [P1] TrashView 「批量 purge」无 progress 弹层,串行 for await

**现状是什么**:`apps/web/src/views/manager/TrashView.vue` 1296 行,批量 purge 用 `for await` 串行调用,无 progress 弹层,只有 toast 文本。

**用户感觉哪里别扭**:admin 选 50 个 trash page 批量永久删除,中途网络断一条都不知道 —— 只有最后一条 toast 报「已删除 49 / 50」。这是不可逆操作,容错性很差。

**问题在哪 / 怎么改**:
- 批量操作走 `Modal.vue` 做一个 progress dialog(带 X / 50 进度条 + 每条成功 / 失败标记)。
- 失败条带「重试」按钮(只针对这 N 条)。
- 串行换并行(Promise.all 但带并发上限 5)。

**代码位置**:`TrashView.vue`。

---

### 🟢 [P2] SpacesView 卡片密度高,呼吸感不足

**现状是什么**:`apps/web/src/views/manager/SpacesView.vue` 1216 行,每张卡片展示:avatar(背景色 + icon)+ name + kind badge + 个人显示 owner / 团队隐藏 owner + description + 5 个 stat(页面 / 子页 / 授权组 / 授权用户 + 最近更新 + 创建日期)+ access row + actions。

**用户感觉哪里别扭**:卡片信息密度高,在 1280px 视口下 3 列布局每张卡内容要 scroll 才能看完。

**问题在哪 / 怎么改**:把 stat 收敛到「核心 3 项」(页面数 / 最近更新 / 成员数),其他折叠到「详情」链接。

**代码位置**:`SpacesView.vue`。

---

### 🟢 [P2] SpaceEditView 对 personal space 直接 `router.replace('/')`

**现状是什么**:`apps/web/src/views/manager/SpaceEditView.vue:181-184`,personal space 自动跳走,但 `SpaceInfoTab` 实际支持 metadata 写入。

**用户感觉哪里别扭**:admin 想看某个用户的个人空间元信息,点进去后被弹回 `/` —— 没有 admin-only 的只读 info 页。

**问题在哪 / 怎么改**:personal space 在 admin 视角下走只读 info 页(不能编辑,因为 personal 写矩阵 owner-only),空间名 / 描述 / owner / 创建时间只读展示 + 「进入空间」按钮。

**代码位置**:`SpaceEditView.vue:181-184`、`SpaceInfoTab.vue`。

---

## 5.6 用户 / 登录 / 设置

### 🔴 [P0] 忘记密码 / 自助重置流程完全缺失,用户被锁外

**现状是什么**:
- `apps/api/src/routes/auth.ts` 仅有 `POST /api/auth/reset-password`(需已登录 session),无邮箱验证 token、无 forgot-password 端点、无重置链接。
- `LoginView.vue` 没有「忘记密码」按钮或链接。
- 全仓 grep `register|signup|signUp` 0 命中。

**用户感觉哪里别扭**:用户忘记密码 → 没有自助恢复路径 → 只能联系 admin 重置。如果 admin 不在线 / 离职,用户永久锁外。

**问题在哪 / 怎么改**:
- **MVP**:admin 可以在 UserEditView 生成「临时登录链接」(7 天有效,跟邀请链接同套机制),用户点链接直接登录 + 强制改密码。
- **中期**:接邮件 + 验证 token + 自助 `POST /api/auth/forgot-password` → 邮件发链接 → 链接点开走 ResetPasswordView 流程。

**代码位置**:`LoginView.vue`、`auth.ts`、`UserEditView.vue`。

---

### 🟡 [P1] SettingsDrawer 4 区 + 内嵌上传/裁剪,认知密度偏高

**现状是什么**:`apps/web/src/components/layout/SettingsDrawer.vue` 1701 行(注:**真实路径不是 ui/,agent 验证过**),4 区:预览 / 姓名 / 颜色 / 头像 / 密码折叠。

**用户感觉哪里别扭**:新用户首次打开设置抽屉,面对 4 类操作,认知密度偏高 —— 「改个颜色」要先改预览卡再看头像裁剪。

**问题在哪 / 怎么改**:拆成两个 drawer,或者顶部加 tab「资料 / 安全」分开。

**代码位置**:`SettingsDrawer.vue`。

---

### 🟡 [P1] AvatarCropper 不支持缩放,只能拖动

**现状是什么**:`apps/web/src/components/AvatarCropper.vue` 384 行,固定 256×256 圆,拖动(无缩放)。

**用户感觉哪里别扭**:用户上传一张全身照当头像,只能拖动裁剪框取脸 —— 没法缩放把整张脸拉大。

**问题在哪 / 怎么改**:加滚轮 / 双指缩放 + 缩放比例提示。

**代码位置**:`AvatarCropper.vue`。

---

### 🟢 [P2] CheatSheet 与 EditorToolbar 快捷键条目不一致,CheatSheet 不全

**现状是什么**:
- CheatSheet 列了 17 条,EditorToolbar 只挂了 B/I 的快捷键 tag。
- CheatSheet 与 EditorToolbar 在 mac vs 非 mac 的视觉符号可能不一致(`⌘B` vs `Ctrl+B`)。
- CheatSheet 没列 ⌘K 之外的常用快捷键。

**用户感觉哪里别扭**:用户看 CheatSheet 知道有 `⌘B`,但工具栏上的 icon 只有鼠标 hover tooltip 显示,新手不知道。

**问题在哪 / 怎么改**:
- EditorToolbar 所有按钮都加 `title` 快捷键提示。
- CheatSheet 加 ⌘P(个人空间)、⌘⇧A(活动流)、⌘⇧L(关注列表)。
- 统一 mac / 非 mac 显示(MOD_KEY 常量已存在)。

**代码位置**:`CheatSheetModal.vue`、`EditorToolbar.vue:43-44`、`lib/platform.ts`。

---

### 🟢 [P2] OTP banner 「仅显示一次」无撤回 / 重发机制

**现状是什么**:`PeopleView.vue:451-475`,创建用户后弹一次性 OTP banner,关闭即失。

**问题在哪 / 怎么改**:admin 关闭 banner 后允许在用户列表行 hover 显「再次发送 OTP」(短时冷却 30s 防止刷)。

**代码位置**:`PeopleView.vue`。

---

## 5.7 UI 组件库 / 设计系统落地

### 🔴 [P0] Menu 组件不存在,7 个组件各持 menuOpen ref + 自装 click-outside/escape

**现状是什么**:agent 验证全仓 `components/ui/Menu.vue` 不存在。菜单能力分散为 5 个各自实现:
- `PageMoreActionsMenu`(495 行)
- `ManagementMenu`
- `PublishToSpaceMenu`
- `ExportMenu`
- `UserMenu`(走 tippy)
- `PageTree.vue` 的行级菜单(`components.css:569` `.menu` / `.menu-backdrop`,`position:fixed` + 光标坐标,只有 PageTree 一个消费者)

7 个组件各持 `menuOpen` ref,14 个组件各自装 click-outside / escape 监听。

**用户感觉哪里别扭**:用户视角感觉不出来,但开发者视角:每个新菜单都要拷一份 boilerplate,容易写错(漏掉 escape 监听、漏掉 portal 等)。

**问题在哪 / 怎么改**:做 `<Menu :anchor="ref" :open="bool" @close="...">` 通用组件,接管:
- click-outside
- escape
- portal 到 body
- 定位策略(absolute 锚父 / fixed 光标坐标 / tippy)
- 子项自动 focus trap(可选)

所有菜单迁移过去,7 个 menuOpen ref / 14 个 click-outside 监听全部删除。

**代码位置**:`PageMoreActionsMenu.vue`、`ManagementMenu.vue`、`PublishToSpaceMenu.vue`、`ExportMenu.vue`、`UserMenu.vue`、`PageTree.vue`、`components.css:569`。

---

### 🔴 [P0] 无撤销机制,删除类操作全靠 ConfirmDialog 前置拦截

**现状是什么**:agent 验证全仓无 undo toast。`ui.notify()` 支持 `action` 按钮(带 action 时 `durationMs=0` 常驻),但目前仅用于「上传失败→重试」。删除类操作都走 `ConfirmDialog` 前置拦截,ShareDialog 撤销走 append-only 无 undo。

**用户感觉哪里别扭**:用户误删了一篇 page → 弹 confirm → 「好的」 → 没了。不可逆操作前,5 秒内反悔的窗口是 Confluence / Notion / Gmail 都有的基础能力。

**问题在哪 / 怎么改**:
- 所有「删除」「归档」「移入回收站」操作成功后,toast 带「撤销」按钮(`action` 字段),5s 自动消失。
- 后端加 `POST /api/pages/:id/restore-recent`(5 分钟内可用,从临时 tombstone 表拉回),undo 时调用。
- 永久删除(purge)不可撤销,保留 ConfirmDialog + typed-text 二次确认。

**代码位置**:`stores/ui.ts`(`notify` 已支持 action)、`pages.ts`、`apps/api/src/routes/adminPages.ts`。

---

### 🟡 [P1] EmptyState variant 全是 no-data fallback,17 个文件用没人传 variant

**现状是什么**:`apps/web/src/components/ui/EmptyState.vue` 定义了 3 个 variant:`no-data` / `no-results` / `no-permission`,17 个文件用 EmptyState,几乎无绕过,但**所有调用点都没传 variant** —— 三个语义槽实际全部落在默认 `no-data`。

**用户感觉哪里别扭**:`no-permission` variant 应该是红色 lock icon + warning 配色,实际显示是默认蓝色 + data icon —— 跟「没数据」长得一样,用户分不清「页面被限制」vs「页面不存在」vs「搜索无结果」。

**问题在哪 / 怎么改**:所有 not-found / restricted / error 状态显式传 `variant="no-permission"`;所有 search-empty 状态显式传 `variant="no-results"`。这是 1 小时工作量,但能把体验拉一个档次。

**代码位置**:`EmptyState.vue`、`components.css:1332`(独立 "Empty state" 全局样式)、所有 17 个调用点。

---

### 🟡 [P1] ConfirmDialog / CheatSheetModal / MovePageDialog / PickPageDialog / SpaceCapabilityDialog 绕过 Modal.vue 自建 backdrop

**现状是什么**:agent 验证 5 个弹窗绕过 `Modal.vue` 自己重写 backdrop / focus trap / esc 处理。

**用户感觉哪里别扭**:开发者视角的 chrome 不统一 —— 不同弹窗的关闭行为、focus trap、body scroll lock 可能不一致。

**问题在哪 / 怎么改**:5 个弹窗迁移到 `Modal.vue` chrome,只保留自身内容;`Modal.vue` 已经做好 useFocusTrap / useBodyLock / useEscape 3 个 composable,可以直接复用。

**代码位置**:`ConfirmDialog.vue:249`、`CheatSheetModal.vue:397`、`MovePageDialog.vue`、`PickPageDialog.vue`、`SpaceCapabilityDialog.vue`。

---

### 🟡 [P1] tokens.css 跟组件落地不彻底,hex 字面量 101 处漂移

**现状是什么**:
- `tokens.css` 跟 Atlassian Atlas 对齐度高(色板 / 阴影 / radius 准确)。
- 后期补入 `--text-*` / `--space-*` / `--z-*` 尺度,但注释自认「现有组件可继续用旧字面量」。
- 实测漂移:`.vue` 内硬编码 hex **101 处**(`SettingsDrawer.vue` 17 处最多)。
- 96 个文件仍写字面量 font-size。
- `var(--radius)`(已标 @deprecated)仍有 **78 处**调用。
- `z-index` 字面量 **58 处**(`.menu` 自己就写死 `z-index:200/199` 而非 `--z-dropdown`)。

**用户感觉哪里别扭**:用户视角看不出来,但后期调色板时 101 处 hex 要手动改。

**问题在哪 / 怎么改**:
- 禁止新写 hex / z-index 字面量 / `var(--radius)` —— PR review 拦。
- 后续打磨批次专项替换:`SettingsDrawer.vue` 17 处 hex → token;`.menu` z-index → `--z-dropdown` / `--z-popover`。

**代码位置**:`tokens.css`(已标 @deprecated)、所有 `.vue`。

---

### 🟡 [P1] Toast 与 inline 反馈并行,无统一规则

**现状是什么**:
- 仅 10 个文件用 `useToast`,`toast.success` 全仓 16 处。
- 同时存在 7 处 inline 局部旗标(`copied` / `justSaved` / `justCreated` ref)。
- `ShareDialog.vue:232` 显式选择「成功不弹 toast,用 pill 状态变化代替」,但该决策未沉淀成组件库约定。

**用户感觉哪里别扭**:不同操作的反馈形式不一致 —— 创建页面是 toast「已创建」,复制链接是 inline pill「已复制 ✓」,分享成功是 toast,标记已读是纯 DOM 更新无反馈。

**问题在哪 / 怎么改**:在 `docs/` 加一份「操作反馈约定」决策文档,把 4 种反馈形式(Toast / Pill / Inline state / 无)的选择规则写清楚:
- 影响范围 > 当前组件 → Toast
- 当前组件状态变化 → Pill
- 错误且仅影响当前组件 → Inline error
- 纯查询类操作(列表 markRead) → 无

**代码位置**:`docs/`(新文档)、`uiStore.notify`、`ToastContainer.vue`。

---

### 🟢 [P2] StatCard(space)与 StatBlock(manager)是两套并行 stat 组件

**现状是什么**:`apps/web/src/components/space/StatCard.vue` 151 行 vs `apps/web/src/views/manager/StatBlock.vue`,注释承认「视觉刻意不同」。

**用户感觉哪里别扭**:用户视角看不出来(两套都好看),但开发者视角:改一次 stat 卡片要在两个文件改。

**问题在哪 / 怎么改**:统一为 `<StatCard>`,加 `variant="space|manager"` 控制视觉差异。

**代码位置**:`StatCard.vue`、`StatBlock.vue`。

---

### 🟢 [P2] mention picker 双实现,编辑器走 Tiptap Suggestion / 评论走 useCommentMention

**现状是什么**:agent 验证 `useCommentMention.ts`(437 行)对 `<textarea>` 手写 `@` 检测 + tippy + 自建 keymap,跟编辑器 mention 独立,但共享 `useMentionCandidates` 与 `mention.css`。文件头注释承认是刻意分叉。

**用户感觉哪里别扭**:用户视角无感,但维护成本高。

**问题在哪 / 怎么改**:短期不动(刻意分叉是有理由的:Tiptap Suggestion 跟 ProseMirror 状态强耦合,不能直接迁移);中长期统一建议在 ProseMirror 之外做一层 textarea abstraction。

**代码位置**:`mentionExtension.ts`、`useCommentMention.ts`、`MentionList.vue`。

---

### 🔵 [P3] 暂搁(影响小 / 需别的依赖)

- `SpacePicker` 实际未封装复用,TrashView 用裸 `<select>`,SpacesView 用卡片网格 —— 等下次有人需要复用再做。
- `UsersView.vue` / `GroupsView.vue` 在 router 中无注册,旧路径仅 redirect,文件本身未删 —— dead code,删即可。
- Preset 头像清单未 ready 时 fallback 猜 `.svg` 扩展名 → 必 404 → 多一跳 —— 修 fallback 链即可。
- `IconBtn` 仅 13 行近乎空壳 —— 不动,留作 wrapper。

---

# 6. 总结建议清单(按 P0 → P3)

## P0 — 必须立即打磨

| # | 模块 | Gap | 工作量估 |
|---|---|---|---|
| 1 | 空间切换 | 顶栏加当前空间面包屑 | 1 天 |
| 2 | 空间切换 | SpaceSwitcher 单一空间 trigger 退化加 tooltip | 半天 |
| 3 | 空间切换 + 管理后台 | 空间邀请闭环(自助激活链接) | 3 天 |
| 4 | 主页 / Onboarding | 新用户首次进入引导 | 1 天 |
| 5 | 主页 / 个人空间 | personal 独立主页(跟 team 解耦) | 2 天 |
| 6 | 页面交互 | EditView 顶栏 6 元素拥挤(低频入 ⋯ + 紧凑化) | 半天 |
| 7 | 页面交互 | auto-save 加「X 分钟前」相对时间 | 半天 |
| 8 | 页面交互 | ReadView ⋯ 菜单重组(11 项 → 4 段) | 1 天 |
| 9 | 协同 / 通知 | 通知 WS push(reuse Hocuspocus) | 3 天 |
| 10 | UI 组件库 | `<Menu>` 通用组件,7 处收敛 | 3 天 |
| 11 | UI 组件库 | 全操作 undo toast | 2 天 |
| 12 | 用户 / 登录 | 忘记密码 / 自助重置(临时链接 MVP) | 2 天 |

**P0 合计 ≈ 3 周**

## P1 — 重要打磨

| # | 模块 | Gap |
|---|---|---|
| 13 | 权限 | view 限制 BFS 走 SQL(denormalized 父链 JSONB) |
| 14 | 页面交互 | 跨空间移动 page |
| 15 | 页面交互 | 导出 PDF 改 server-side 渲染(短期先加 tooltip) |
| 16 | 页面交互 | 附件上传全局进度面板 |
| 17 | 主页 | 归档人显示 |
| 18 | 通知 | HUMAN_KIND 补全 + 分组 |
| 19 | 管理后台 | UserEditView 加「活动 / 安全」tab |
| 20 | 管理后台 | GroupEditView 加「授权」tab |
| 21 | 管理后台 | AuditView 启用搜索 + actor / 时间 + CSV |
| 22 | 管理后台 | TrashView 批量 purge progress 弹层 |
| 23 | 用户 / 设置 | SettingsDrawer 拆 2 个抽屉 |
| 24 | 用户 / 设置 | AvatarCropper 加缩放 |
| 25 | UI | EmptyState variant 全量补传 |
| 26 | UI | 5 个弹窗迁 Modal.vue chrome |
| 27 | UI | tokens.css 漂移清理(hex / z-index / radius) |
| 28 | UI | 操作反馈约定文档 + 全量对齐 |

**P1 合计 ≈ 4-5 周**

## P2 / P3 — 后续批次,见各章节末段。

---

# 7. 一些跨章节的设计决策建议(顺手记)

1. **统一「操作反馈」** —— Toast / Pill / Inline / 无 四种形式在文档里写清楚规则(见 5.7)。
2. **统一「菜单」** —— 5.7 第 1 条 `<Menu>` 组件做完后,所有 menu 收敛。
3. **统一「删除」语义** —— `softDelete`(进回收站,可恢复)+ `archive`(空间归档,可恢复)+ `purge`(硬删除,不可恢复),三档的 UI 反馈要明显区分(进度条 / 时间窗口 / 不可逆提示)。
4. **新功能自检** —— 每次加新功能前过一遍本清单的 P0 / P1,确认不要引入新的「主路径堵点」。

---

**结语**:power-wiki 离 Confluence 级别的「团队知识库」还有约 8 周打磨工作量(P0 + P1),大头在「闭环」(邀请 / 撤销 / 反馈 / 上下文章)和「组件库收口」。完成 P0 后,产品就能达到「可向团队演示」的状态;完成 P1 后,可向「正式推荐给其他团队使用」的状态推进。