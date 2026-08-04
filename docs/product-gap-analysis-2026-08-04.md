# power-wiki 产品差距分析与优化建议(2026-08-04)

- 视角:资深产品经理,对标 Confluence,基于 `apps/web` + `apps/api` + `packages/shared` 现有代码逐处审视。
- 不在范围内:全文检索 / 评论优化 / 表情表态 / 通知 / 历史 / 最近页面活动 / 辅助屏幕用户。
- 优先级:**P0** = 任何用户都会撞到的核心闭环缺口;**P1** = 重度用户 / 管理员高频但有 workaround;**P2** = 体验加分项。

---

## 1. 总览判断

代码层面,power-wiki 已经走到了"产品可用"的临界点:路由 / 权限 / 编辑器 / 空间管理 / 回收站 / 管理后台 6 大块都从骨架长成了肌肉;视觉令牌统一从 `apps/web/src/styles/tokens.css` 派生,没有自造十六进制(抽查 8 个组件 CSS 全部走变量);编辑器自研 Tiptap 节点视图做得很细(`CalloutView` / `CodeBlockView` / `ToggleView` / `ImageAttachmentView` / `HeadingView` / `EditorBubbleMenu`)。

剩下与"对标 Confluence"的差距不在"缺一个按钮",而在 5 类结构性不足:

1. **首页 / 工作台类页面的信息密度过低**:`SpaceHomeView` 的 stat-card 是只读数字,`PersonalHomeView` 的 6 个 section 没视觉权重,缺 drill-down。
2. **批量 / 顺序类操作缺失**:删页 / 移页 / 改限制全是逐个语义,管理员在批量场景下效率断崖。
3. **富文本"结构性块类型"偏少**:14 个 slash 命令 + 12 个工具栏按钮,但 `<status>`、`<decision>`、`<citation quote>`、`<toc>`、`<group mention>` 这些团队文档高频块还没建。
4. **跨页关系的导航入口弱**:页面反向链接、关注页、空间成员贡献 — 散落多页,缺一个常驻 CTA。
5. **首次进入 / 邀请 / 登录跳转的引导链残缺**:新用户进 `/me` 看到 6 个空 section,没有"接下来做什么"。

下面分模块展开(每节对应一个用户视角下的"页面 / 操作",引用代码路径便于定位)。

---

## 2. 团队空间首页(团队成员进入空间后看到的第一个页面)

**对应代码**:`apps/web/src/views/SpaceHomeView.vue`

### 现状
`h1 / p / 4 张 stat-card / 公告区域 / 页面树` 五段式。`stats` 拉 `/api/spaces/:id/stats`,展示"全部页面 / 今日活跃 / 本周更新 / 我的页面"。`homepagePageId` 配了之后,空间首页被替换为该页。公告区是单一字段的 `?` 标 + 标题 + 内容。

### 差距
- **stat-card 是死数字,不是入口**:点不动。Confluence 在这里是"快捷透视 + 直接跳转"双功能。
- **"今日活跃 / 本周更新"** 12 个更新,不能点开看到"哪些页面 + 谁改的"。
- **公告区**是单一字段,空间管理员没法把多个页面"锁在首页"作为公告集合。
- **中部页面树**与 `Sidebar.vue` 的"此空间的页面 tree"是两套,空间内容多了要扫两遍。
- **空白空间**(刚建没人写)没"建第一页"的高亮 CTA,只有常规按钮。

### 建议
- **P1 / 2.1** stat-card 全部 `<RouterLink>` 包裹,跳 `/spaces/:id?filter=today|recent|mine` 之类,显示前 20 条相关页面。`SpacesView` 已有 `?filter=empty|unauthorized` 的现成模式可参考。
- **P1 / 2.2** 公告区支持多行(`pinned_page_ids: string[]`),管理员在空间设置里勾选要置顶的页面;同时允许每行折叠。
- **P2 / 2.3** 空白空间:`pages.length === 0` 时中央换成"三步上手"大卡(建页 / 导入 / 邀请)。
- **P2 / 2.4** 移除中部页面树,只留侧栏版;中部换成"近期编辑活动"流(5 行 timeline)。

---

## 3. 个人工作台(每个用户登录后的主页)

**对应代码**:`apps/web/src/views/PersonalHomeView.vue`、`apps/web/src/components/page/DashboardCard.vue`

### 现状
6 个 section 同时呈现:`共享空间与角色 / @提到我 / 我创建的 / 最近访问 / 我在个人空间起草的 / 我关注的页面`。每个 section 用 `DashboardCard`(`variant: 'page' | 'mention'`)渲染,间距统一 12px + 1px border-bottom。个人空间(`/me`)是用户私有,只有所有者 + admin 能进。

### 差距
- **6 个 section 无视觉权重**,用户不知道先看哪个。Confluence my-work 用"主卡片 + 二级分组"。
- **"我创建的"** 没有按空间分组,5 个空间的页面混在一个列表,扫起来费力。`DashboardCard` 的 space-chip 已存在但**没按空间分组的视觉断点**。
- **"最近访问"** 没有去重 + 没有按频次权重的"我的常读页面"。Confluence 用 `pinned + frequently visited` 两个分组。
- **"我在个人空间起草的"** 标题语义模糊,用户会问"为什么显示这个"。
- **空状态**每个 section 各有"暂无 X"占位文案,缺统一的"接下来该做什么"。
- **`@提到我` 入口在 `/me`** 但缺通知数提示(通知主体在排除范围,但 UI 提示不冲突)。

### 建议
- **P1 / 3.1** 6 section 重排为 2 级:**主区**(默认选第一个非空的)+ **次区**(横向 grid 2 列)。`DashboardCard` 加 `variant: 'compact'` 给次区。
- **P1 / 3.2** 顶部加"快速新建 / 快速导入 / 个人空间"三个圆形大按钮 + "今日待办"。
- **P1 / 3.3** "我创建的" 按 space 分组,每组带空间色 chip + 折叠/展开,组内 `updatedAt desc`。
- **P2 / 3.4** "最近访问" 加频次权重:右上角一个小星标 + tooltip "最近 7 天访问 ≥ N 次"。
- **P2 / 3.5** 全部空状态合并为"待办卡",展示"建第一页 / 邀请队友 / 浏览空间"。

---

## 4. 页面阅读页(ReadView — 任何用户读页面的主路径)

**对应代码**:`apps/web/src/views/ReadView.vue`、`apps/web/src/components/page/PageRestrictionsDialog.vue`、`apps/web/src/components/page/PageWatchButton.vue`、`apps/web/src/components/page/ShareDialog.vue`、`apps/web/src/components/page/PageMoreActionsMenu.vue`、`apps/web/src/components/editor/ExportMenu.vue`

### 现状
顶栏 9 个动作:关注 / 点赞 / 分享 / 导出 / 编辑 / 限制 / 移页 / 删除 / 复制,外加 byline + 限制 chip + 归档 banner。`ReadView.vue` 用 `canEdit/canShare/canManageRestrictions/canMove/canDelete` 5 个 boolean 决定显隐,统一从 `canManagePageWrite` 派生。

### 差距
- **顶栏 9 项拥挤**:Confluence 把"低频"操作收到 kebab,只外露编辑 / 分享 / 关注 / 导出。
- **`ShareDialog` 复制成功** 只弹 toast,容易错过。Confluence 用 inline banner。
- **`ExportMenu` 只 3 项**(HTML / Markdown / PDF),**PDF 走 `window.print()`**,浏览器打印对话框的 UX 因 OS 浏览器差异很大。
- **历史按钮**只在 `PageMoreActionsMenu` 里,顶栏不直出。byline 的"上次编辑时间"也是只读不可点。
- **byline 缺编辑摘要**:只有"X 在 Y 改了",没有"这次改了什么"的提示。Excluded:历史。但**当前版本的事件摘要小卡** 是 UI 增强不冲突。
- **评论区入口**锚点 OK,但**没有"未读评论"标记**,用户每次都从头看。
- **TOC 右侧栏**缺"是否始终显示 / 是否随滚动高亮"开关。
- **ReadView 直接打印时**(`Ctrl+P`),顶栏 / 侧栏 / 评论区没隐藏 — 打印样式 `@media print` 未确认有。

### 建议
- **P0 / 4.1** 顶栏 9 按钮分两段:**主操作**(关注 / 分享 / 导出 / 编辑)始终可见;**次操作**(限制 / 移页 / 复制 / 归档 / 删除)收进 `⋯`。`canMove/canDelete/canManageRestrictions` 全部移到 `⋯`,主顶栏只留 `canEdit`。
- **P0 / 4.2** PDF 导出改成"服务端生成":`POST /api/pages/:id/export?format=pdf` 由服务端 puppeteer / playwright 渲染 — 比 `window.print()` 更可控。短期缓解:补全 `@media print` 样式 + 打印对话框预填文件名 + 隐藏 toolbar。
- **P1 / 4.3** byline 右侧加"近期变更"小卡:显示最近 3 条 page_event 摘要(评论 / 限制变更 / 标题变更),点开弹完整 activity。
- **P1 / 4.4** 评论区入口加"未读"小圆点 + "上次看到这里"分割线。
- **P1 / 4.5** TOC 加"固定"开关 + scroll-spy 高亮 + 折叠/展开所有 H2 的按钮。
- **P2 / 4.6** `ShareDialog` 复制成功改 inline banner(不是 toast),3 秒自动消失,有"复制链接 / 撤销分享"按钮。
- **P2 / 4.7** 全局 `@media print` 隐藏 sidebar / topbar / comments-section / ia-toolbar。

---

## 5. 页面编辑页(EditView — 用户建/改页面的主路径)

**对应代码**:`apps/web/src/views/EditView.vue`、`apps/web/src/components/editor/RichEditor.vue`、`apps/web/src/components/editor/EditorToolbar.vue`、`apps/web/src/components/editor/EditorBubbleMenu.vue`、`apps/web/src/components/editor/SlashMenu.vue`

### 现状
Tiptap 编辑器,顶部固定 `EditorToolbar`(format/list/insert/align/indent)+ 底部 slash 触发 `SlashMenu`(14 命令:基本块 6 + 媒体 3 + 高级 5)。保存状态机 `idle/pending/saving/saved/error`,**`EditView` 用 500ms 防抖 + 30s idle 自动 snapshot**,**`RichEditor` 用 800ms 防抖** —— 两处不一致。`BubbleMenu` 在文本选区上方弹出加粗/斜体/删除线/行内代码 + 段落格式下拉 + 链接。附件上传走 `openAttachmentPicker` → `uploadAndInsert` → 编辑器内插入 `ImageAttachmentView` node-view。

### 差距
- **防抖时间不一致**:`EditView` 500ms vs `RichEditor` 800ms。两个视图保存行为走两套计时器,有可能 EditView 显示 "Saved" 后回到 ReadView 再触发一次更新。
- **14 个 slash 命令不够**:对比 Confluence,**结构性 / 状态 / 引用类** 缺 `status` 徽章、`decision` 决策记录、`quote with citation`(引用带来源 URL)、`toc` 块。
- **`EmojiPicker.vue`** 已实现,但**没有进入 slash 菜单** — 用户只能在 bubble menu 找到。
- **mention list 搜索框**做得不错(debounce + kbd hint),但**没有"当前空间成员 / 我关注的人"快捷 filter**。
- **slash `/` 插入 page-ref** 支持,但**没有"@ 一组"** 入口 — 团队文档"通知全体开发组"场景缺。
- **表格** slash 里有 `table`,但**没有 cell merge / 表头行冻结**。
- **`HeadingView` slug + position 兜底**(`h-引言-12`),URL 锚点不直观。
- **编辑器内无字数 / 阅读时长统计**。
- **`PageLinkPreview.vue` 只在 ReadView 显示**,编辑器内粘 page 链接时无预览。
- **标题 input** 没字数限制 + 没"未保存"标记。

### 建议
- **P0 / 5.1** 抽 `usePageAutoSave` composable,EditView / RichEditor 都消费;默认 500ms,环境配置可调。
- **P1 / 5.2** slash 新增 `status`(4 色徽章)+ `decision`(决策记录卡)+ `quote with citation`(引用 + 来源)+ `toc`(显式 TOC 块)+ `emoji`(从 `EmojiPicker` 拉)。
- **P1 / 5.3** mention 搜索顶部加 3 个 chip 快捷 filter:`当前空间成员 / 我关注的人 / 全员`。
- **P1 / 5.4** slash 触发 `@` 时默认弹"组选择"辅助(团队空间):管理员可一键 @"前端组"。
- **P1 / 5.5** 编辑器底栏加字数 + 阅读时长 + 标题修改状态(`● 未保存的标题` / `✓ 标题已保存`)。
- **P1 / 5.6** 编辑器内识别内部 page 链接(粘贴 `@...` / `p/xxx`),实时渲染小卡片预览。
- **P2 / 5.7** heading slug 去掉 position 后缀(纯 slug),多段同标题时 anchor 走持久化 id。
- **P2 / 5.8** 表格增加合并单元格 / 表头行冻结快捷键(右键菜单)。

---

## 6. 富文本节点细节

**对应代码**:`apps/web/src/components/editor/CodeBlockView.vue`、`ImageAttachmentView.vue`、`HeadingView.vue`、`MentionList.vue`、`UploadStatus.vue`

### 6.1 CodeBlockView
**现状**:语言下拉(14 种)+ 复制按钮 + 行号 gutter + 删除按钮。

**差距**:
- 复制走 `navigator.clipboard.writeText`,**HTTP 非安全上下文会 fail**(`localhost` 之外的 127.0.0.1 某些浏览器也算),目前 `catch` 只 `console.warn`,**无 fallback**。
- 行号 gutter 整 NodeView 重渲染,代码 > 1000 行影响滚动性能。
- 缺"折行切换 / 自动换行"开关 — 长行被截断只能横向滚。

**建议**:
- **P1 / 6.1.1** 复制 `catch` 里 fallback `document.execCommand('copy')` + 失败 toast。
- **P2 / 6.1.2** 行号 gutter 走 CSS counter,不在 NodeView 渲染。
- **P2 / 6.1.3** 代码块右上角加"折行切换"按钮(`white-space: pre-wrap`)。

### 6.2 ImageAttachmentView / AttachmentsSection
**现状**:图片显示 + caption + alt + align + replace + delete;文件卡 icon + 名字 + 大小 + 下载按钮(hover 才显示)。

**差距**:
- **附件 replace 失败时**目前 inline 替换,旧 attachment 字节已经清了,失败 → 用户失去内容。Confluence 在 replace 失败时保留旧 attachment 不变。
- **`AttachmentLightbox.vue`** 支持图片 / 文件,但**没有 zoom / 旋转 / 翻页**。
- **`AttachmentsSection`(阅读页底部附件列表)** 没"按类型筛选 / 排序"。

**建议**:
- **P1 / 6.2.1** replace 失败保留旧 node + toast 解释 + 重试入口。
- **P1 / 6.2.2** Lightbox 加 zoom(滚轮 + 双击)+ 旋转 + 键盘 ← → 翻页。
- **P2 / 6.2.3** AttachmentsSection 顶部加"类型筛选 chips"(图片 / 文档 / 其他)+ "排序"下拉。

### 6.3 HeadingView / TOC
**现状**:`HeadingView` 走 `slugify(text) - position` 双兜底 id;右侧复制锚点链接的 `#` 按钮。

**差距**:URL `#h-引言-12` 不直观;TOC 缺"折叠/展开"按钮 + scroll-spy。

**建议**:
- **P2 / 6.3.1** URL hash 走纯 slug(`#引言`),内部 data-id 仍可携带 position 防重复。
- **P2 / 6.3.2** TOC 顶部加"折叠/展开"按钮 + scroll-spy 高亮当前 H2/H3。

### 6.4 MentionList
**现状**:`apps/web/src/components/editor/MentionList.vue` 用 tippy + debounce + kbd hint,做得比较细致。

**差距**:
- **搜索 0 字符时**没显示"最近 @ 过的人"。
- **mention 不支持组**。
- **avatar 显示**目前是字母,没异步加载 `user.avatar_ref` 图片头像(`UserAvatar` 在别处已经支持)。

**建议**:
- **P1 / 6.4.1** 0 字符时 endpoint `?recent=1`,返回用户最近 @ 过的 8 人。
- **P2 / 6.4.2** mention chip 异步加载头像(`/api/user-avatars/:id/raw`)。
- **P2 / 6.4.3** mention chip hover tooltip 显示"上次联系" + "在本空间角色"。

---

## 7. 导入 / 导出(阅读页 → 导出 / 侧栏 → 导入 Markdown 弹窗)

**对应代码**:`apps/web/src/components/editor/ExportMenu.vue`、`ImportMarkdownModal.vue`

### 现状
- **Export**:HTML / MD / PDF(走 `window.print()`);busy 状态 + 错误回显。
- **Import**:粘贴 / 选择文件 / 拖文件;PathPicker 选目标位置;标题自动从 H1 / 文件名解析;**2MB 硬限**。

### 差距
- **MD 导入 2MB 限制**(代码硬编码 `pasteMaxBytes = 2_000_000`)— 普通 wiki 页 OK,但"批量导入 100 页 Markdown"明显不够。Confluence 单次 25MB。
- **MD 导入只支持单个文件**,没有多文件 / 文件夹 / 拖多文件。
- **MD 导入的图片 / 附件**不上传 MinIO — 导入的 `[](image.png)` 链接指向 `localhost`,打开 404。
- **HTML 导出**走 `exportPageAsHtml`(自包含 .html),**没嵌入附件**(代码 serialize 的是 contentJSON → HTML,attachment 不嵌入)。
- **MD 导出**同上,attachment → `![alt](attachment-url)` 而不是 embed base64。

### 建议
- **P0 / 7.1** MD 导入 2MB 限制可配置(空间设置 → "导入设置");默认 25MB。
- **P1 / 7.2** MD 导入多文件:`选多个 .md → 每个生成独立页`,目标位置 picker 一次性确认。
- **P1 / 7.3** MD 导入的图片:扫描 `![](image.png)` / `<img src=...>`,自动上传到 MinIO 并替换链接(后端 attachments 表已支持,加 `bulkImportAttachment` endpoint)。
- **P1 / 7.4** HTML 导出嵌入附件(小文件 base64,大文件给下载链接);MD 导出插入 `![](attachment-id)` 而不是绝对 URL。
- **P2 / 7.5** ExportMenu 加 "导出 zip" 选项(页 HTML + 所有附件打包)。

---

## 8. 页面限制弹窗(阅读页 → 限制 按钮 触发的弹窗)

**对应代码**:`apps/web/src/components/page/PageRestrictionsDialog.vue`、`apps/api/src/routes/pageRestrictions.ts`

### 现状
双 tab:查看权限 / 编辑权限;`inheritViewRestrictions` 开关;`protectedSources`(被限制的来源页)展示;`impact preview`(本页打开会增/减多少人)。后端 `pageRestrictions.ts` 用全量替换 PUT + 单行 POST/DELETE;**视图受限时返回 404**(不是 403)— 安全细节做对了。

### 差距
- **`impact preview`** 显示 `viewGained: 5 / viewLost: 2`,但**不能展开看到底是谁**。
- **`protectedSources` 列表**是只读的;想"那我去父页改"得自己跳过去。
- **`inheritViewRestrictions` 关闭**是 destructive 动作(脱离父页继承),目前只是 toggle,缺前置 warning。
- **"编辑权限"** 子页不继承,但 UI 没解释清楚。

### 建议
- **P1 / 8.1** impact preview 数字可点击 → 展开成员列表(头像 + 姓名 + 来源空间/组)。
- **P1 / 8.2** protectedSources 每行加"跳到该页"链接按钮,带 route 跳转 + 后续 dialog 自动定位。
- **P1 / 8.3** 关闭 `inheritViewRestrictions` 时弹二级确认:"你将失去从父页继承的 X 个保护来源(Y 个用户无法访问本页),确定?"
- **P2 / 8.4** dialog 顶部加 info tooltip "编辑权限不继承;每个子页都要单独设"。

---

## 9. 回收站(管理人员 → 回收站 页)

**对应代码**:`apps/web/src/views/manager/TrashView.vue`

### 现状
表格 + kind tab(共享 / 个人)+ 搜索 + 删除者过滤 + 排序 + 批量操作(多选 + 恢复 / 永久删除)+ retention 政策卡 + "父页被删时的顺序提示"(行内)。

### 差距
- **"父页被删时的顺序提示"只在单行有**,批量恢复 N 个被删页时(其中父页也被删了),**没有整体的"先恢复父再恢复子"提示**。
- **批量永久删除**只有一次 `ConfirmDialog`;Confluence 要求输入 `DELETE` 短语。
- **retention 政策卡**倒计时精度不够(只显示"X 天后清空"),缺"清空前会通知谁"。
- **空回收站**只有"暂无已删除页面",缺教学。
- **过滤栏**缺"清空全部过滤"一键。

### 建议
- **P0 / 9.1** 批量恢复加"恢复顺序预览":选中 N 项时顶部条 `即将恢复 X 个页面(其中 Y 个有父页被删,请先恢复父)` + 一键"按拓扑顺序恢复"(`order=topo-then-time`)。
- **P0 / 9.2** 批量永久删除加二级确认:输入 `永久删除` 才放行;或 checkbox "我已了解,不再提示"。
- **P1 / 9.3** retention 卡加"清空前通知"开关(空间设置里配)+ "下次清空:YYYY-MM-DD HH:mm"精确时间。
- **P1 / 9.4** 过滤栏右上角加"清空过滤"按钮(任何 filter 非默认时出现)。
- **P2 / 9.5** 空状态加 3 段教学卡:① 删页去哪了 → ② 30 天后清空 → ③ 如何恢复。

---

## 10. 空间设置页(管理人员 → 空间 → 某个空间 → 设置页)

**对应代码**:`apps/web/src/views/manager/SpaceEditView.vue`、`apps/web/src/views/manager/SpaceMembersTab.vue`、`apps/web/src/components/manager/space/SpaceGrantsTab.vue`

### 现状
三 tab(信息 / 成员 / 授权),URL `?tab=` 同步;`?highlight=` 跨 tab 高亮某行。`SpaceMembersTab` 展示成员列表,**每个成员有 "来源"数组**(`group: x` / `direct` / `space_admin`),"winning source" 高亮。`SpaceGrantsTab` 走两栏(组 / 用户)+ popover 编辑角色;`effective role` 实时预览。

### 差距
- **`SpaceMembersTab` 的 "winning source" 标签**是好设计,但**没有"为什么会赢"的解释 tooltip**。
- **`SpaceGrantsTab` 的 effective role 预览**是 1 行轻量预览,缺**"实际能做什么"的下钻**(`permissions.ts` 已经有能力矩阵,UI 没暴露)。
- **空间信息 tab**只有 description / color / icon / homepagePageId,**缺公开性 / 模板 / 快捷键提示**等元数据。
- **成员邀请流程**管理员可加单个用户,**没有"按组批量加"** 入口。
- **页面限制 UI 的"继承自谁"** 在父页管理入口不直观,得打开 dialog 才看得到。

### 建议
- **P1 / 10.1** `SpaceMembersTab` 每行加 "?" 图标 → tooltip 显示角色推导链。
- **P1 / 10.2** `SpaceGrantsTab` 每个角色选项旁加"权限预览"小卡,展开后展示 6-8 项"能做什么 / 不能做什么"。
- **P1 / 10.3** 空间信息 tab 加"空间快捷键提示"开关。
- **P1 / 10.4** 空间成员 tab 加"按组添加"按钮。
- **P2 / 10.5** 页面树里被限制的页(锁 chip),点击 chip 直接打开 `PageRestrictionsDialog`,并默认 tab 切到"继承来源"。

---

## 11. 管理后台(管理人员列表 / 组 / 空间 / 审计)

**对应代码**:`apps/web/src/views/manager/PeopleView.vue`、`apps/web/src/views/manager/panels/PeopleContextPanel.vue`、`apps/web/src/views/manager/GroupsView.vue`、`apps/web/src/views/manager/SpacesView.vue`、`apps/web/src/views/manager/AuditView.vue`、`apps/web/src/views/manager/UserEditView.vue`

### 现状
- **人员列表**:`PeopleView` 是 users + groups 共用 tabs;`M17` 工具栏 + 活动筛选 chips;users 分页。
- **人员详情**:`UserEditView` 支持改名 / 匿名化(typed-name 二次确认);展示该用户在所有空间的成员关系。
- **组列表**:`GroupsView` 分页 + 搜索 + 排序,精简。
- **空间列表**:`SpacesView` 分页 + `?kind=shared|personal` + `?filter=empty|unauthorized` drill-down。
- **审计**:`AuditView` 按 kind / targetKind 过滤,行可展开,显示 before / after diff。

### 差距
- **PeopleView**激活 tab 缺 breadcrumb — 管理员常问"我现在看的是哪个 scope"。
- **`PeopleContextPanel` 的 "system stats" 卡片**没解释数据来源 / 时段。
- **`UserEditView` 的匿名化**没有"匿名化前导出"链接;合规场景下管理员需要在操作前先下载该用户的内容。
- **`SpacesView`** 没有 `?filter=personal` 一键只看"个人空间"。
- **`AuditView` 的 before/after diff** JSON 太深时折叠得太狠;labels / 限制嵌套字段不友好。
- **批量操作缺**:用户 / 组 / 空间列表都是单选操作。
- **`UserEditView` 的"该用户所在的所有空间"列表**缺搜索 + 角色过滤。

### 建议
- **P1 / 11.1** PeopleView 顶部加 breadcrumb:管理员后台 / 人员(scope: 全部 / 组 X)。
- **P1 / 11.2** PeopleContextPanel stats 卡右上角加"?" tooltip,说明数据时间窗口。
- **P1 / 11.3** UserEditView 加"匿名化前导出"按钮:`POST /api/admin/users/:id/export` → 管理员邮箱收到 zip(用户所有页面 + 评论 + 附件 metadata)。
- **P1 / 11.4** SpacesView 的 `?filter=` 加 `personal` 枚举。
- **P1 / 11.5** AuditView diff 渲染改进:JSON 嵌套层级 ≤ 3 全展开,> 3 折叠但显示摘要行;labels 数组特殊处理(直接展示 chip)。
- **P2 / 11.6** 用户列表加批量操作:`批量加空间 / 批量改全局角色 / 批量匿名化(需 typed-name)`。
- **P2 / 11.7** UserEditView 的"所在空间"列表加搜索 + 角色 chip 过滤。

---

## 12. 全局导航 / 侧栏 / 顶栏 / 状态

**对应代码**:`apps/web/src/components/layout/AppShell.vue`、`Sidebar.vue`、`TopBar.vue`

### 现状
`AppShell` 区分 workspace 与 manager 两套布局;banner 协调(offline > error 互斥)。`Sidebar` 含工作台切换 / 空间列表 / 页面树 / 关注列表 / 搜索入口。`TopBar` 含全局 search / 通知 / 用户菜单 / 主题(只有 light)/ 切换空间。

### 差距
- **侧栏的"工作台切换" chip** 没有"个人 ↔ 团队"动效。
- **侧栏"页面树"和"关注列表"是两个独立 section**,展开后互相挤压;长空间 + 长关注列表并存时滚动不友好。
- **顶栏 search box**(排除范围) idle 没 placeholder / 快捷键提示。
- **`AppShell` banner** 缺"新版本可用"提示。
- **404 页**是简单文案 + 返回按钮,**没有"也许你搜的是"建议**。

### 建议
- **P2 / 12.1** 侧栏的"页面树"和"关注列表"做成可折叠 tab,二选一展开。
- **P2 / 12.2** 顶栏 search box idle 显示 `按 / 聚焦 · 输入标题或人名` placeholder + kbd hint `/`。
- **P2 / 12.3** AppShell 加"新版本"banner,后端返回 `X-App-Version` 头时与本地比较。
- **P2 / 12.4** 404 页加"页面 ID 前缀相似"建议。

---

## 13. 注册 / 登录 / 邀请

**对应代码**:`apps/web/src/views/LoginView.vue`、`ResetPasswordView.vue`(推测在 `apps/web/src/views/`)

### 现状(基于路由推测)
路由有 `/login`、`/reset-password`、`/me`;**没有 `/signup`** — 看起来是邀请制 / 管理员后台创建。

### 差距
- **首次进入 `/me`** 空白状态:用户看到 6 个 section 全空,无任何引导。
- **登录后跳转**:确认是否跳回登录前页面(用户期望)。
- **邀请流程**:管理员加成员后,新用户怎么登录?**没看到"邀请邮件 / 临时链接"的明确设计**。

### 建议
- **P0 / 13.1** 个人工作台空状态:大卡"快速开始" + 3 步:"建第一页 / 浏览空间 / 等别人邀请你"(按角色动态)。
- **P0 / 13.2** 登录后跳回原页面:登录前记录 referrer,登录后 redirect。
- **P1 / 13.3** 邀请链接:admin 后台创建用户后生成一次性链接,有效期 7 天,带"设置密码"流程(复用 `/reset-password`)。

---

## 14. 移动端(明确不优化,但确认现状)

**CLAUDE.md 硬约束**:无移动端适配,viewport 锁死 1280。

**现状确认**:路由 + 主要 View 都是桌面布局;没写 `@media` 断点(随机抽查 8 个组件 CSS 确认)。

**建议**:无,在 P0 路由项目里加个"移动端访问请用桌面"的友好提示页(纯 static HTML)。

---

## 15. 视觉 / 品牌 / 排版

**对应代码**:`apps/web/src/styles/tokens.css`、`apps/web/src/components/ui/BrandLogo.vue`、`UserAvatar.vue`

### 现状
设计令牌统一(已确认抽查),Plus Jakarta Sans + PingFang SC + JetBrains Mono;品牌用 `<BrandLogo>`。

### 差距
- **品牌色 `var(--accent)`** 是单一蓝色(#4C9AFF),空间 color picker **没看到预设色板** — 用户大概率会用默认色,视觉同质化。
- **UserAvatar 的字母头像**已有 `avatar_kind = google-style` 预设 SVG(`/avatars/{slug}.svg`),**但没看到 fallback 机制**——如果用户上传的图片头像 `404`,应该 fallback 到字母头像。
- **空状态插画**完全没有:回收站空 / 工作台空 / 搜索无结果都是纯文案 + icon。Confluence / Notion 都用简约线稿插画。
- **`@media print` 样式**未确认有。

### 建议
- **P1 / 15.1** 空间 color picker 加预设 8 色板(灰/蓝/绿/紫/红/橙/粉/青),写入常量。
- **P1 / 15.2** UserAvatar 的图片头像加载失败时 fallback 到字母,过渡 200ms 渐隐。
- **P2 / 15.3** 主要空状态加 1-2 张极简 SVG 插画(团队版 / 文件版 / 时钟版)。
- **P2 / 15.4** 全局 `@media print`:`.app-shell-sidebar / .app-top-bar / .comments-section / .ia-toolbar { display: none; }` + 正文容器最大宽 720px 居中。

---

## 16. 优先级汇总

| 编号 | 模块 | 优先级 | 一句话描述 |
|---|---|---|---|
| 4.1 | 页面阅读页 | P0 | 顶栏 9 按钮分两段,次操作收进 ⋯ |
| 4.2 | 页面阅读页 | P0 | PDF 改服务端生成,或至少打印样式完整 |
| 5.1 | 编辑器 | P0 | 统一 auto-save debounce(500ms) |
| 7.1 | 导入导出 | P0 | MD 导入 2MB 限制可配置,默认 25MB |
| 9.1 | 回收站 | P0 | 批量恢复按拓扑顺序提示 + 一键排序 |
| 9.2 | 回收站 | P0 | 批量永久删除加二级确认 |
| 13.1 | 首次进入 | P0 | 个人工作台空状态大引导 |
| 13.2 | 登录 | P0 | 登录后跳回原页面 |
| 2.1 | 空间首页 | P1 | stat-card 可点击 drill-down |
| 2.2 | 空间首页 | P1 | 公告区支持多页置顶 |
| 3.1 | 个人工作台 | P1 | 6 section 重排,主区 + 次区 2 列 |
| 3.2 | 个人工作台 | P1 | 顶部加快速新建 + 今日待办 |
| 3.3 | 个人工作台 | P1 | "我创建的" 按空间分组 |
| 4.3 | 页面阅读页 | P1 | byline 右侧加近期变更小卡 |
| 4.4 | 页面阅读页 | P1 | 评论区未读标记 + 上次看到这里 |
| 4.5 | 页面阅读页 | P1 | TOC 固定开关 + scroll-spy |
| 5.2 | 编辑器 | P1 | slash 新增 status / decision / citation / toc / emoji |
| 5.3 | 编辑器 | P1 | mention 快捷 filter(当前空间 / 我关注 / 全员) |
| 5.4 | 编辑器 | P1 | slash 触发 @ 默认弹"组选择"辅助 |
| 5.5 | 编辑器 | P1 | 编辑器底栏加字数 + 阅读时长 + 标题修改状态 |
| 5.6 | 编辑器 | P1 | 编辑器内识别内部 page 链接并预览 |
| 6.1.1 | 编辑器 | P1 | 代码块复制 fallback |
| 6.2.1 | 编辑器 | P1 | 附件替换失败保留旧 node |
| 6.2.2 | 附件 | P1 | Lightbox 加 zoom/旋转/翻页 |
| 6.4.1 | 编辑器 | P1 | mention 0 字符显示最近 @ 过的人 |
| 7.2 | 导入导出 | P1 | MD 导入多文件 |
| 7.3 | 导入导出 | P1 | MD 导入图片自动上传 MinIO |
| 7.4 | 导入导出 | P1 | HTML/MD 导出嵌入附件 |
| 8.1 | 限制对话框 | P1 | impact preview 数字可点击展开成员 |
| 8.2 | 限制对话框 | P1 | protectedSources 加"跳到该页"链接 |
| 8.3 | 限制对话框 | P1 | 关闭 inherit 时二级确认 |
| 9.3 | 回收站 | P1 | retention 通知开关 + 精确清空时间 |
| 9.4 | 回收站 | P1 | 过滤栏右上角"清空过滤"按钮 |
| 10.1 | 空间设置 | P1 | 成员 tab 行加 "为什么是这个角色" tooltip |
| 10.2 | 空间设置 | P1 | 角色选项旁加"权限预览"小卡 |
| 10.3 | 空间设置 | P1 | 空间信息 tab 加"快捷键提示"开关 |
| 10.4 | 空间设置 | P1 | 成员 tab 加"按组添加"按钮 |
| 11.1 | 管理后台 | P1 | PeopleView 顶部加 breadcrumb |
| 11.2 | 管理后台 | P1 | PeopleContextPanel 加 tooltip 解释数据时段 |
| 11.3 | 管理后台 | P1 | UserEditView 加"匿名化前导出" |
| 11.4 | 管理后台 | P1 | SpacesView 的 filter 加 personal |
| 11.5 | 管理后台 | P1 | AuditView diff 渲染改进 |
| 13.3 | 邀请 | P1 | 一次性邀请链接流程 |
| 15.1 | 视觉 | P1 | 空间 color picker 加 8 色预设 |
| 15.2 | 视觉 | P1 | UserAvatar 图片头像 fallback |
| 2.3 | 空间首页 | P2 | 空白空间"三步上手" |
| 2.4 | 空间首页 | P2 | 移除中部页面树,改成近期编辑流 |
| 3.4 | 个人工作台 | P2 | 最近访问加频次权重 |
| 3.5 | 个人工作台 | P2 | 全部空状态重写 |
| 4.6 | 页面阅读页 | P2 | ShareDialog 复制成功改 inline banner |
| 4.7 | 页面阅读页 | P2 | 全局 `@media print` 隐藏 sidebar / topbar |
| 5.7 | 编辑器 | P2 | heading slug 去掉 position 后缀 |
| 5.8 | 编辑器 | P2 | 表格合并单元格 + 表头冻结 |
| 6.1.2 | 编辑器 | P2 | 代码块行号 gutter 用 CSS counter |
| 6.1.3 | 编辑器 | P2 | 代码块"折行切换"按钮 |
| 6.2.3 | 附件 | P2 | AttachmentsSection 类型筛选 + 排序 |
| 6.3.1 | 编辑器 | P2 | heading URL hash 走纯 slug |
| 6.3.2 | 编辑器 | P2 | TOC 折叠/展开 + scroll-spy |
| 6.4.2 | 编辑器 | P2 | mention chip 头像异步加载 |
| 6.4.3 | 编辑器 | P2 | mention chip hover tooltip |
| 7.5 | 导入导出 | P2 | 导出 zip(HTML + 附件) |
| 8.4 | 限制对话框 | P2 | 顶部 info tooltip 解释"编辑不继承" |
| 9.5 | 回收站 | P2 | 空状态 3 段教学卡 |
| 10.5 | 空间设置 | P2 | 锁 chip 点击直接打开 dialog + 切到继承 tab |
| 11.6 | 管理后台 | P2 | 用户批量操作 |
| 11.7 | 管理后台 | P2 | UserEditView 的"所在空间"搜索 + 过滤 |
| 12.1 | 导航 | P2 | 侧栏页面树 / 关注列表二选一展开 |
| 12.2 | 导航 | P2 | 顶栏 search box idle placeholder + kbd |
| 12.3 | 导航 | P2 | AppShell 加"新版本可用"banner |
| 12.4 | 导航 | P2 | 404 页加 ID 前缀相似建议 |
| 15.3 | 视觉 | P2 | 空状态插画(团队版 / 文件版) |
| 15.4 | 视觉 | P2 | `@media print` 全局样式 |

> 共 68 项;P0 = 8 项;P1 = 35 项;P2 = 25 项。

---

## 17. 推进建议

按 P0 → P1 → P2 顺序推进,每批 3-5 项,完成后跑 `pnpm typecheck` + `verify_*.py`(若有)。

第一批 P0 落地后立即做用户验收(找 1-2 个 team 内用户跑真实流程:登录 → 进空间 → 建页 → 编辑 → 分享 → 删 → 恢复),因为 P0 都是"任何用户都会遇到"的核心闭环。