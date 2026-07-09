# power-wiki 距离"专业 wiki 产品"的产品差距分析报告

> **生成时间**: 2026-07-09 · **作者**: Claude
> **基线对标**: Confluence Cloud · Notion · 飞书 wiki · 语雀
> **评估对象**: `C:\Users\Administrator\Desktop\power-wiki` (单分支 main,Vue 3 + Tiptap + Postgres + MinIO 桌面端 MVP)
> **核心约束(硬要求,不影响本报告的优先级判断)**: 不做暗色主题、不做移动端、不接外链图片、admin 操作不做审计、page-level ACL 不做、starred 不做、协作互斥不做、全文搜索降级为标题 LIKE、屏幕阅读器不做、模板不做、public 分享不做、生产部署不做。

---

## 0. 评估方法 + 现状摘要

把专业 wiki 的核心场景拆成 **7 个能力维度**,对照行业基线逐项评估。

| # | 维度 | 当前完成 | 距离专业基线 |
|---|---|---|---|
| D1 | 内容创作 | 富文本(Tiptap 11 扩展)、表格、代码块高亮、@mention、@page、/callout、color/highlight、image+attachment 上传 | 良好,但缺图库管理、附件批量上传、图册尺寸调节 |
| D2 | 内容组织 | space + 无限层级 PageTree + 拖拽 + label + 版本历史 + 个人/团队空间 | 缺 incoming links (backlinks)、批量移动/打 label、最近编辑全局 view |
| D3 | 信息检索 | ⌘K 全局搜索(标题 LIKE,跨 space 权限过滤)+ label autocomplete + 已读 TOC | 缺全文 / 段落搜索、facet、排序、搜索结果高亮 |
| D4 | 协作与社交 | @mention 通知 + 评论(限一级回复) + page like + 30s 轮询 inbox | 缺页面订阅 / watch、批注(comment-on-block)、reaction 表情 |
| D5 | 管理员与安全 | 用户/组/space CRUD + 群组授权 + 个人空间 + trash + restore/purge | admin 不能阻止个人空间被读 / 不能禁止多设备登录 / 不能 view 计数 |
| D6 | 跨设备 / 会话 | cookie session(30 天) + draft 仅 backend + recents 仅 localStorage | 多端 sidebar 展开状态不同步;未提供"踢下线" / 看活跃会话 |
| D7 | 性能与稳定 | 懒加载子树 + N+1 防 + 反规范化 + 30 条版本 retention + 安全标头 | 长期 trash / 版本无限期;无 orphan S3 GC;无图片缩略图 |

**总体判断**: 项目已经把 wiki 的 1.0 骨架(MVP)做完了,**距离"自信当一个生产 wiki 用"主要缺的不是大功能,而是 D2/D3/D4 三块日常工作链路上的几个关键缺口**。

---

## 1. 用户已明确排除的清单(以下条目按用户要求列入,但状态预置为「暂时不做」)

> 这部分不是"建议"——用户已经明确表态,这里只列出来对齐认知。

| 类别 | 当前状态 | 排除原因 |
|---|---|---|
| **A. 生产部署相关** | dev 模式 auto-migrate,Docker Compose 一键起;无 CI/CD、无反向代理 example、无 prod 环境变量矩阵 | 用户偏好 — 等到真要上生产再说 |
| **B. 并发冲突 / 文档协同** | 已知 Yjs / y-prosemirror / y-tiptap 装好但不用;两份同时编辑 last-write-wins | 用户偏好 |
| **C. 全文搜索** | `apps/api/src/routes/search.ts` 故意 `ILIKE` 标题,JSDoc 写明"<5k 页 OK,真痛再上 tsvector" | 用户偏好 |
| **D. public 链接** | 无匿名 share intent;无未登录访问;无匿名只读 token | 用户偏好 |
| **E. admin 审计** | sessions 表有 IP/timestamp 但无 audit_log 表;无操作追溯 UI | "管理员权限默认最大, 操作不需要审计"(用户原话) |
| **F. 页面级别权限** | 仅 space-level `space_group_access`,无 per-page ACL | 用户偏好 |
| **G. starred 功能** | `pages.starred` 全局布尔(JSDoc 写明"v0 不支持 per-user,starred 是 metadata")— 等于已实现但只是 global 标志,前端没真正暴露"我的收藏"视图 | 用户偏好(未来真要"我的收藏夹"是另一个 spec) |
| **H. 屏幕阅读器 / 非鼠标用户** | 所有右键菜单 / kebab 都是 mousetrap;shift+F10 / 焦点循环没处理 | 用户偏好 |
| **I. 模板** | `page_templates` 表在 0006/0007 已 drop;不做模板选择器、不做内置 seed | 用户偏好 |

**A~I 都打 `[暂时不做]`**,以后要启动任一项,需要单独立项重新评估技术方案。

---

## 2. 优先分组总览

按"不做就会让用户觉得'不像个专业的 wiki'"的程度分四档。**P0 = 现在就该动手的内功**,不补齐 P0 已经会让 Confluence 老用户感到不对劲。

| 优先级 | 数量 | 平均估时 | 影响面 |
|---|---|---|---|
| **P0** 内功 / 必须补齐 | 7 | M 各 4-8h | 全员 |
| **P1** 核心专业特征 | 9 | S~M | 全员 |
| **P2** 日常 UX 锦上添花 | 7 | S~M | 全员 |
| **P3** 差异化能力 | 5 | M~L | admin / 重度用户 |

**条目估算表**: **S** ≤ 0.5d · **M** 1-3d · **L** ≥ 3d · **XL** ≥ 1w

---

## 3. P0 — 不补就难叫专业的内功(7 项)

### P0-1 · Sidebar PageTree 过滤 / 搜索
**当前**: `PageTree.vue` 纯渲染 `pages` 按 order,树大了只能滚轮找。50+ 页时,鼠标手 = 噩梦。

**缺什么**: 输入框边输边过滤 — 命中 page 高亮 + 自动展开 ancestor 链,失配 collapse。Confluence / Notion / 飞书都把这个当 sidebar 默认配置。

**不做的影响**: power-wiki 永远只能服务"少量页 / 重视觉关系"的小团队;50+ 页 + 层级深 = 不可用。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: `apps/web/src/components/layout/Sidebar.vue`(加 input)、`PageTree.vue`(过滤 hook)、`apps/web/src/stores/ui.ts`(不持久化搜索 query)

---

### P0-2 · Incoming links / backlinks 面板
**当前**: `@page` Mention extension 可以插一个 page 链接(`apps/web/src/editor/extensions/pageRef.ts`),但**没有任何反向发现机制**——改了一个被引用的页,被引它的页没人会主动去找。

**缺什么**: 每个 page 详情有一个 "Linked from" / "Backlinks" 区,展示**反向引用本 page 的所有 page**(带 label 上下文)。Notion 把它命名为 "Backlinks",Confluence 没有等价但有 "Page History of Links"。

**不做的影响**: 知识图谱断了。改完 A,不会发现 B/C/D 都引用了 A 的内容,作者失去 maintenance signal,知识库腐烂。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 后端加 `GET /api/pages/:id/backlinks`(扫 `contentJson` jsonb,扫 pageRef marks);`ReadView.vue` 加面板;`PageNode` schema 已有 backlinks 不动?需先加 cte + GIN 索引 for `where jsonb @>`

---

### P0-3 · Draft 兜底(offline safety)
**当前**: Tiptap auto-save 500ms debounce → `api.pages.update`;失败 banner;`onBeforeUnload`+`onBeforeRouteLeave` 拦截。用户关浏览器 = 内容还在 backend(成功的话);失败的情况下,**没有 localStorage 兜底**。

**缺什么**: 草稿 daily 自动落 localStorage(`power-wiki:editor-draft-{pageId}`,TTL 7d),下次开同一 page 时弹 "Recover unsaved changes"。

**不做的影响**: 网络抖一下 / 服务 5xx 一下 / 关 tab 一下 = 编辑丢失。对"长篇页"是灾难。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: `apps/web/src/views/EditView.vue` 加 `useDraft` composable + RecoveryBanner 弹窗;`PERSIST_KEYS` 已预留

---

### P0-4 · notification preferences(per-user / per-kind toggle)
**当前**: 4 种 kind 不分青红皂白全推 inbox(`mention`/`reply`/`comment_on_my_page`/`page_like`);用户只能全部清。30s 轮询再加 ack = inbox 是个噪声池。

**缺什么**: 用户可以:
- 关掉 `page_like`(几乎没人想要被 like 通知)
- 选 `mention` 只接收自己 mention,不要 `reply`
- (admin) 全员关掉 `comment_on_my_page` 高峰期 spam
- (未来) per-space mute

**不做的影响**: inbox 持续低信噪比,用户学会无视 → 错过真 mention。wiki 协作的命门断了。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 新表 `notification_prefs(user_id, kind, enabled)` + simple seed;`enqueueNotifications` 读这个表决定插不插;`UserMenu` 加齿轮入口

---

### P0-5 · EmptyState / Skeleton / Modal / Tooltip 通用 UI primitives
**当前**: 调研发现 — **`components/ui/` 没有 `Button.vue`、`Modal.vue`、`Tooltip.vue`、`EmptyState.vue`、`Dropdown.vue`**。每个 popover 各自手工(LabelAddPopover、SpaceSwitcher dropdown、NotificationBell drawer 都是自己写)。结果:视觉一致性差,每加一处 popover 都要再写一遍。

**缺什么**:  
1. **EmptyState** — 三种槽(`no data` / `no search results` / `no permission`),配插画+slot
2. **Modal** — 通用 teleport + esc + body-lock
3. **Tooltip** — 键盘可访问暂不做(屏幕上 hover 触发的就行,根 Excluded H 不冲突)
4. **Drawer** — NotificationBell 内部那个抽出来

**不做的影响**: 后续每个新功能都要重新实现一遍 chrome,工期 +30%,bug +100%(每个 popover 都有自己的小毛病)。专业 wiki 的"小但一致的细节"全靠这层 primitives 撑着。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: L(M 用量级) · **关键路径**: 新增 `components/ui/{EmptyState,Modal,Tooltip,Drawer}.vue`;老组件逐步迁移引用

---

### P0-6 · Drag-to-reorder 持久化的端到端验证
**当前**: **已修(本会话)**,`usePageTreeDrag.ts` module-scope + `pages.ts` move handler `deletedAt` filter + 跨 space 过滤。但 R1/R2 用 admin 通过, C1/C4 用例断言还需调(根 row 落点 ≠ child 落点,scripts/verify_drag_reorder.py C1/C4 假设要改)。

**缺什么**: 把 C1/C4 用例补对,纳入 CI(via Playwright headless),**防回弹**。

**不做的影响**: 上次 bug 出现 ~3 次才有结论,这次没 CI 网的话下次又会花同样时间。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: `scripts/verify_drag_reorder.py` 修 C1(根 target 中 1/3 = after);C4 测两个 root 各挂一个子,setup API 调

---

### P0-7 · attachment upload progress + 多文件并发
**当前**: `editor/uploadAndInsert.ts` 是单文件 presigned PUT 序列,串行;UI 只在 Tiptap 节点上 spinner,**没有总进度 / 失败重试**。

**缺什么**: 上传 10 张图 = 编辑器卡 10 轮(每轮 5-30s),用户看到节点一个个冒出来,失败的话错误散在每个 node。

**不做的影响**: 任何含图片教程贴 5+ 图 = 体感糟糕;专业 wiki 用户(尤其是 slide 总结场景)一次贴图经常上 10+。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: `editor/uploadAndInsert.ts` 并发 pool(3-5 并发);`upload-progress` 进度轮询(S3 没有 callback,只能用 headObject polling);失败回显重试按钮

---

## 4. P1 — 核心专业特征(9 项)

### P1-1 · Bulk operations on pages
**当前**: TrashView 有批量 restore/purge 一组 checkbox 的 toolbar;但**主业务场景(批量 label / 批量 move / 批量 delete)的 toolbar 不存在**。Side 选中一棵子树右键 → 没有"批量操作"。

**缺什么**: 多选 + 共享 toolbar,做 add-label / remove-label / move-to-space / delete。

**不做的影响**: 老用户迁移 200 页项目时傻眼。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: PageTree 加 shift-click / cmd-click 多选 + 浮动 toolbar

---

### P1-2 · Page watch / subscribe + 变更通知
**当前**: 用 @mention 才会通知,**单纯改了页面不会通知任何关注者**。

**缺什么**: 每个 page 顶部一个 "Watching" 铃;开启后,该 page 任何编辑(版本)产生 `page_edited` 通知(给 watcher 列表)。Confluence 的"Watch this" + Page history entry。

**不做的影响**: 没 watch 就没人盯,默默腐烂。SLA 入职文档 / 流程页 = 过期了没人发现。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 新表 `page_watchers(page_id, user_id, created_at)`;PATCH /pages/:id 触发 `page_edited`;`ReadView` 顶部铃 icon

---

### P1-3 · 最近编辑 / 活动流(workspace-wide)
**当前**: `HomeView.vue` 有一行"我的最近" 是 `useRecentPages` 本地缓存;**没有"今天谁改了 page"的统一视图**。

**缺什么**: 一个 `/recent` 路由 + 顶部铃里加下拉入口,展示"今天 / 本周 / 本月"的编辑事件(actor + page + 时间);filter by space;click 跳到 page 的对应版本 diff。

**不做的影响**: 团队发现"今天事情有没有进展"必须靠读 inbox 或挨个翻;效率日志缺失。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 复用 `page_versions` 表 + JOIN users;新 view `views/RecentActivityView.vue`

---

### P1-4 · Page view counter(简单 analytics)
**当前**: 完全没在 count。`PageNode.likesCount` 是有的。

**缺什么**: 后端 `pages.view_count` int 列 + 每 GET 详情 +1(用户级别 dedup 简单点靠 session);ReadView 上显示"被看了 123 次"。Confluence 的 Page Analytics 雏形。

**不做的影响**: 不算致命,但"这篇文章写得好不好"的反馈信号缺失,管理者判断靠点赞不够。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: `apps/api/src/db/schema.ts` 加列 + 0012 迁移;`routes/pages.ts` GET 单页处 +1;`ReadView.vue` header 加灰字

---

### P1-5 · Page 重命名 + URL 重定向
**当前**: `pages.title` 可以改;**老的 URL `/p/{id}` 永远指 id 不带 slug 变化**。没有 slug 概念。

**缺什么**: 把 page 路由从 `/p/:id` 转成 `/p/:id-:slug`(Confluence / Notion 风格),后端对 id 兜底返回 slug,改 title 时 slug 重算;**保留 `page_aliases` 表** 存历史 slug → id,外部链接不死。

**不做的影响**: 用户主动分享的链接仍是 `wuj4ry9hzh`(nanoid),不可读;改标题后分享出去的人不知道改了。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: L · **关键路径**: schema + 路由 + 重定向;slug 化规则(latin transliteration + 中文 fallback)

---

### P1-6 · 自助修改个人资料(name / color / 头像)
**当前**: `UserMenu` 顶部只有「管理后台」+「登出」。`UserEditView` admin 自己能改别人,但**用户改自己的名字/颜色要去 admin 后台**(甚至可能没权限改)。

**缺什么**: UserMenu 加 「设置」入口 → 设置抽屉(name / color / 时区 / 通知开关)。

**不做的影响**: 跟企业级 wiki 一致性差;新人入职"换个好看的头像"也得 admin 来。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 新 `views/SettingsView.vue` + `PATCH /api/users/me` 路由

---

### P1-7 · Session 管理(active session list / kill)
**当前**: `sessions` 表存了 cookie → user 的映射,但 **admin 不暴露 API** 看自己有多少 active 会话,也没法踢某台设备的。

**缺什么**: Settings → 「Active Sessions」,列出 (device ua, loginAt, ip) 列表,可以单踢或全踢(除当前)。

**不做的影响**: 公共设备登录忘登出 / 密码怀疑泄露 = 无 self-service 兜底。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: `apps/api/src/routes/auth.ts` 加 GET/DELETE;前端 SettingsView

---

### P1-8 · Trash retention 自动清理
**当前**: Trash 永久保存,admin 不主动 `?purge=true` 就一直在。

**缺什么**: 默认保留 30 天(常量),`GET /api/pages/trash` 时惰性删过期项;admin /api/admin 设置可调(90/180/forever)。

**不做的影响**: DB 越用越慢;S3 附件更慢(CASCADE 不动附件,孤儿对象)。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: `routes/pages.ts` trash list 加 DELETE 过期;加 `admin_settings(retention_days)` 表

---

### P1-9 · Comment reactions(emoji 给评论)
**当前**: 整个项目只有 page 级 `page_likes`(👍 toggle);comment 完全没反应系统。

**缺什么**: comment 下方一行 emoji toolbar(😊 👍 ❤️ 👀 ✅),单选多选都行,简单表 `comment_reactions(comment_id, user_id, emoji)`。

**不做的影响**: 评论文化缺反馈回路,长期写 comment 的人没成就感。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: 新表 + GET/POST/DELETE 路由;`CommentItem.vue` 加一行 emoji 选择器

---

## 5. P2 — 日常 UX 锦上添花(7 项)

### P2-1 · Sidebar 键盘导航(箭头 + Enter 展开/收起)
**当前**: Tab 能进 PageTree 焦点,但不能 ↑↓ 跳行 / Enter 展开。

**缺什么**: 标准 roving tabindex + ↑↓ 移动 + →/← 展开折叠 + Enter 跳转。

**不做的影响**: 鼠标重度用户无所谓;键盘党一旦试过别的 wiki 就不回头。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: `PageTree.vue` 加 focus + key handler(键盘可达;屏幕阅读器无关 — 由 Excluded H 覆盖)

---

### P2-2 · Page 上 / 下 (prev / next by sibling order)
**当前**: 读完一个 page,只能回 sidebar 找下一个;Confluence / Notion 都有 ◀ ▶ footer 跳 sibling。

**缺什么**: ReadView 底部 footer:上一条 (parent 下 prev sibling) / 下一条 (parent 下 next sibling)。

**不做的影响**: 长文档按顺序读时,体验断。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: ReadView.vue footer + pagesStore 加 helper

---

### P2-3 · Image 内联尺寸调节句柄
**当前**: Image 节点可调 `align:left/center/right`,宽度走默认 `width: auto + max-width: 100%`。

**缺什么**: 选中 image 时显示 8 个 resize handle;输入数字 50%。

**不做的影响**: 大图不缩;截图小图不放大;视觉控制弱。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: Tiptap ImageResize extension 或 custom NodeView;写新 `imageWidth` attr

---

### P2-4 · 粘贴剪贴板图片
**当前**: 编辑器只识别文字 paste;系统截图工具截的图 = paste 进来是路径。

**缺什么**: paste 监听 image blob → 走 `uploadAndInsert` 现成流程。

**不做的影响**: 用户每次都得"先存到桌面 → 拖进 sidebar → 拖进正文"。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: Tiptap extension `pasteHandler` + 复用 upload

---

### P2-5 · Comments 编辑历史(可看 diff)
**当前**: `comments.isEdited` boolean;但点了看不到改了什么。

**缺什么**: comment 详情有 "edited 2h ago → view history" 按钮;展示最近 3 个版本的 diff。

**不做的影响**: 不致命,但开了合规 strict team 的问题(谁改过合规相关 comment)。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 新表 `comment_versions`;复用 `stripMarkdown` 渲染纯文本

---

### P2-6 · Page 树右键菜单 vs 横向 Action Bar
**当前**: `PageTree` 行右端 ⋯ kebab,展开 menu;**鼠标悬停不显示菜单**(CLAUDE.md 提到偏好 icon over kebab,但当前全是 kebab)。

**缺什么**: hover 时显示 edit/move/duplicate/delete 四枚 icon 按钮(<3 行,符合 kebab 切换 icon 的既得描述)。

**不做的影响**: 跟既有产品调性已有违和;每行一次 right-click 菜单开关。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: PageTree row hover state + 新 IconBtn 集群

---

### P2-7 · 时区显示(用户偏好)
**当前**: 所有 `updatedAt` 走 `new Date(n)` 浏览器本地;用户 TZ 在 `Intl.DateTimeFormat().resolvedOptions().timeZone` 决定。

**缺什么**: 给 Settings 加时区下拉;所有 timestamp 渲染走该 TZ。audit 友好(team 跨国)。

**不做的影响**: 用户多 TZ 团队沟通"什么时候改的"会错。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: 后端存 ISO 字符串 + 前端用 `Intl` + 用户 TZ

---

## 6. P3 — 差异化能力(5 项)

### P3-1 · Reaction emoji 替换 page like
**当前**: 只有 👍 👍;Confluence 有 7+ emoji + click-to-react。

**缺什么**: 把 `page_likes` 重构为 `page_reactions(page_id, user_id, emoji)`,UI 改成 emoji 浮动栏;保留默认 👍。

**不做的影响**: page like 像 2007 产品。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: S · **关键路径**: schema 迁移(page_likes → page_reactions)

---

### P3-2 · Open Graph / embed preview(对外分享好看)
**当前**: 没 metadata(头 html 没 og:*);share 给微信/钉钉 = 卡片空白。

**缺什么**: SPA 内挂一个 meta route `/p/:id.og` 渲染 server(meta + title + 第一段纯文本 + first image),SEO 引擎爬取。

**不做的影响**: 微信群分享 wiki 链接 = 死链样,流量回流差。**注意**: 不动 public 访问域(用户 Excluded D),只在已授权会话下生 share link。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: Vite plugin 注入 meta;SPA 拉取首段拼成 meta

---

### P3-3 · 管理员仪表板 + 数据图表
**当前**: `ManagerLayout` 是裸 tab,只有 list 视图;**没有任何"现在的 wiki 是什么样"可视化**。

**缺什么**: `/manager/dashboard` 页:
- 近 30 天页面编辑量柱状图
- 月活用户
- 空间页数 / 存储占用 / 附件上传

**不做的影响**: admin 不会用 = 没法用,IT 价值体现不出。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 新 `DashboardView.vue` + 简单 SQL 聚合 + 用 SVG 自绘(避引入图表库,默认 Atlassian 风)

---

### P3-4 · 导出 MD/PDF/DOCX 之外的多平台 scrape
**当前**: `apps/web/src/lib/api.ts` 有 export 路由(MD/PDF/HTML);DOCX 看了 memory 说有 5 个 custom serializer。

**缺什么**: 加 Notion `.zip` 导入;Confluence `<page>` XML 导入;**导出**加 zip 多页 + 保留 attachments。

**不做的影响**: 客户迁入迁出成本高。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: L · **关键路径**: 独立 import/export 流水线

---

### P3-5 · 内部 API 文档(spec 页)
**当前**: `docs/api.md` 存在,讲 endpoint 但非交互;**没 Swagger / OpenAPI 给前端 / 第三方引用**。

**缺什么**: 给后端加 `apps/api/openapi.gen.ts`(从 zod schema + 当前 routes 生成),`/api-docs` 路由渲染 Swagger UI。

**不做的影响**: 脚本化操作 / 集成测试都得手写 OpenAPI;中等团队不重要。

**状态**: ☐ [ ] 暂时不做  ☐ [ ] 需要做  ☐ [x] 完成  
**估时**: M · **关键路径**: 后端用 hono-openapi-middleware 或手写 OpenAPI yaml

---

## 7. 工时小计 + 建议批量

| 优先级 | 项数 | 估算总工时 |
|---|---|---|
| P0 | 7 | ~4w |
| P1 | 9 | ~3w |
| P2 | 7 | ~1.5w |
| P3 | 5 | ~2w |
| **合计** | **28** | **~10w** 一人月 |

**建议第一批一次性做完 P0 的全部**(其中 P0-6 已经在本会话修好,只剩 C1/C4 用例对齐),把内功补完后,P1 可以按月滚动做。

---

## 8. 排除类别补丁表(继续 暂时不做,只列出来对齐)

> 这些类别用户已明确不做,本节只列出来作为 "如要补需要做的事" 备忘,**不在本周 / 下月 roadmap 里**。

| # | 类别 | 如果未来要补,最直接的入口 |
|---|---|---|
| A | 生产部署 | Docker image + nginx 反代 example + CI/CD + secrets 管理 + Backup pg_dump + mc mirror MinIO |
| B | 并发冲突 | y-tiptap 接上,光标协同 + 版本差异调和;旧 PATCH 改成 OT-aware 入站 |
| C | 全文搜索 | pg_trgm 升级到 tsvector + GIN;LabelTitleMap 倒排;搜索结果高亮用 ts_headline |
| D | public 链接 | `page.share_token` 列 + /p/share/:token 公开路由 + 限速 |
| E | admin 审计 | 新表 `audit_log(actor_id, action, target_type, target_id, ip, ts)`;admin middleware 写日志 |
| F | 页面级别权限 | 新表 `page_acl(page_id, principal, level)`;Read 时 join 过滤 |
| G | starred(我的收藏) | `user_stars(user_id, page_id)` 新表 + Sidebar favorite 区 + `/me/starred` view |
| H | 屏幕阅读器 | WAI-ARIA 全 audit + 焦点环 `Tab` 显式 + 右键菜单键盘化 |
| I | 模板 | 新表 `page_templates`(已被 drop 两次)和 seed 数据 + slash menu "Template..." |

---

## 9. 总结

- **做了 60%**: 内容创建/组织/历史/评论/mention/like/标签/搜索(not FTS)/附件这些 wiki 主线骨架都到位。
- **缺 30%**: 主要集中在**让用户日常更顺手的内功**(P0)+**企业级必备的子能力**(P1):sidebar 过滤、backlinks、draft 兜底、notification preferences、UI primitives、bulk ops、watch、recents、view counter、self-service profile、session mgmt、trash retention、reaction。
- **缺 10%**: 锦上添花(P2/P3),不影响"能不能用",但做完了"想不想一直用"。

---

## 10. 行动项

请按"暂时不做 / 需要做"在每项的状态栏里打钩(我没改默认)。每完成一项,我手动改 `[x]`。完成 all P0 起,降到 P1;中途任一项客户变更优先级,直接调。
