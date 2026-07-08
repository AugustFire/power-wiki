# Architecture

power-wiki 前端架构、路由、状态管理、编辑器流水线、Tiptap 自定义扩展、阅读视图、持久化层 —— 一份集中讲「frontend 怎么跑起来 + 怎么组织」的文档。

## 入口 / 启动

`apps/web/src/main.ts` 创建 app,安装 Pinia + Router,然后 `router.isReady()` 触发 `authStore.init()`(幂等,module-scoped `initRef` 防 HMR 漏)。`pagesStore` / `spacesStore` / `uiStore` 首次访问时初始化。

## 路由

`apps/web/src/router/index.ts`(hash 历史,`scrollBehavior` 优先 `savedPosition` → `to.hash` → 顶部)。

完整路由表:
- `/login` (LoginView) / `/reset-password` (ResetPasswordView) — 公开
- `/` (HomeView) / `/me` (MySpaceView) / `/p/:id` (ReadView) / `/p/:id/edit` (EditView) / `/new?parent=:id` (EditView) — 需登录
- `/p/:id/history` (HistoryView) — 需登录,Confluence 风格独立历史路由
- `/manager/*` (ManagerLayout + 子路由) — 需 admin
  - `/manager/people` / `/manager/people/users/:id` / `/manager/people/groups/:id`
  - `/manager/spaces` / `/manager/spaces/:id`
  - `/manager/trash`
  - `/manager/users` / `/manager/users/:id` / `/manager/groups` / `/manager/groups/:id`(back-compat redirect)
- catch-all 404

**守卫顺序**(重要):idempotent auth init → public pass-through → mustResetPassword 强制重置 → requiresAdmin 走 NotFound(不暴露 `/manager` 存在)→ requiresAuth 走 `/login`。

## 状态管理

`apps/web/src/stores/` 下四个 Pinia setup store:

| Store | 文件 | 职责 |
|---|---|---|
| pages | `stores/pages.ts` | `PageNode[]` 数组,业务数据走 API(乐观更新 + 失败回滚)。CRUD + 树构建 + 回收站本地状态 + 跨空间移动 + 发布到 / 复制 |
| ui | `stores/ui.ts` | 树节点展开状态(持久化到 `power-wiki:tree-expanded`)、节点上下文菜单(全树共享,同一时刻只有一个菜单)、重命名状态、全局 error banner |
| auth | `stores/auth.ts` | 当前 user / `isAuthed` / `isAdmin` / `needsPasswordReset`、`status: 'idle'|'loading'|'ready'|'error'` 状态机、`init()` 幂等。401 = "未登录"(不报错),其他 = 真的错误 |
| spaces | `stores/spaces.ts` | 可见 space 列表、`activeSpaceId`(持久化到 `power-wiki:active-space`)、`setActive(id)` 触发侧边栏 / 树重新渲染 |

业务数据走 API(`api.pages.*` + `api.comments.*` + `api.notifications.*` + `api.attachments.*` + `api.search.*`),不再用 localStorage。localStorage 只剩 2 个 key 集中在 `packages/shared/src/keys.ts`:`power-wiki:tree-expanded`(per-space `Record<spaceId, string[]>`)+ `power-wiki:active-space`。

跨视图共享的 module-level composable:`useManagerStats`(users + groups,admin 视图用)、`useMentionCandidates`(mention 候选缓存,editor + comment composer 共用)、`useNotifications`(unread-count 30s 轮询,bell 弹层 + 跨 view 共享)。

## 编辑器流水线

`apps/web/src/components/editor/RichEditor.vue` 用 `useEditor` 挂载扩展(来自 `apps/web/src/editor/extensions.ts`),防抖 800ms 把 `getJSON()` + `getHTML()` emit 给父组件(`apps/web/src/views/EditView.vue`)。

`EditView.vue` 持有本地 title/JSON/HTML 引用、`isDirty`、`saveState`;`onMounted` 时若无 `id` 则新建页面,然后 `router.replace` 到 `/p/:id/edit`。"已保存" 提示通过定时器自动隐藏。

## Tiptap 官方扩展

`apps/web/src/editor/extensions.ts` 配置:

- StarterKit 关闭 `heading` / `codeBlock`(由 `HeadingAnchor` / `CodeBlockView` 替换);其余默认开
- `Markdown` 输入 / 粘贴规则(StarterKit 自带,`## ` → h2、`**bold**` → bold、`- ` → ul 等);IME 期间(`view.composing === true`)inputRules 自动跳过,中文打字不会被误判
- 启用:Link、TextStyle + Color、Highlight、TaskList + TaskItem、Table + Row + Cell + Header、CodeBlockLowlight、TextAlign、Placeholder、BubbleMenu、DragHandle、Collaboration / y-prosemirror / y-tiptap(为后续多端协作预留,Y.js 已安装但未启用)

## Tiptap 自定义扩展

全部在 `apps/web/src/editor/` 下,每个扩展都有对应的 `apps/web/src/components/editor/<Name>View.vue` NodeView(行内 / 块级都走 `VueNodeViewRenderer`):

| 扩展 | 用途 |
|---|---|
| `HeadingAnchor` (`headingAnchor.ts` + `HeadingView.vue`) | 替换 heading 节点,渲染时挂 `id` 锚点 |
| `CodeBlockView` (`extensions.ts:170-180` + `CodeBlockView.vue`) | 代码块 NodeView,语言切换 + 复制按钮 |
| `Callout` (`calloutExtension.ts` + `CalloutView.vue`) | 4 种 variant(info / success / warning / danger)的提示框 |
| `Toggle` (`toggleExtension.ts` + `ToggleView.vue`) | `<details>/<summary>` 折叠块,允许任意块嵌套;read 视图默认收起 |
| `PageRef` (`pageRefExtension.ts`) | Notion 风格页面引用卡片(`<a class="page-ref-card" data-page-id="...">`) |
| `DateInline` (`dateInlineExtension.ts` + `DateInlineView.vue` + `DateTimePicker.vue`) | 行内日期 atom 节点,`mode: 'now' | 'fixed'`,now 模式在 NodeView 中启动 setInterval 每 60s 重算显示文案;点击节点弹 DateTimePicker 编辑 |
| `Mention` (`mentionExtension.ts` + `MentionList.vue` + `MentionView.vue`) | 行内 `@` 提及,候选限定为当前 page 所在 space 的访问组成员;`/useMentionCandidates` module-scope composable 缓存候选 |
| `ImageAttachment` (`imageAttachmentExtension.ts` + `ImageAttachmentView.vue`) | 页面级附件(MinIO S3 字节 + DB 元数据),image 内联渲染,file 走 `download` 卡片;`/lib/attachmentPicker` + `editor/uploadAndInsert` 处理 toolbar 拖入 / 粘贴 / slash 菜单 |
| `BlockBrowserSave` (`extensions.ts:42-67`) | ProseMirror 插件 `priority: 1000`,**只**拦截 Cmd/Ctrl+S 防浏览器「保存网页」对话框;其余格式快捷键(Cmd+B/I/U/Z/Y、Alt+1/2/3、Ctrl+Alt+C 等)全部放行给 Tiptap 默认 keymap |

## Popover 组件

定位方案分三类:

- **Tiptap BubbleMenu**(贴光标位置 + tippy mount 到 `body`):`EditorBubbleMenu` —— 编辑器内 bubble,选中文本时浮出。
- **position:absolute 锚定在容器内**(`ColorPopover` / `LinkPopover` / `EmojiPicker` / `DateTimePicker` / `CalloutVariantMenu` / `TableMenu` / `CellColorPicker` / `BlockTypeMenu` / `ExportMenu` / `MentionList` / `UserMenu` / `NotificationBell`):父容器是 `position:relative`,popover `position:absolute` + 偏移。`ExportMenu` 是 ReadView 操作区的「导出」popover,`MentionList` 是编辑器内 mention 弹层(Tippy `pw-mention` theme + mount body),`NotificationBell` 是 TopBar 的通知弹层。
- **position:fixed + 视口坐标**:`DateInlineView` 的 `.di-popover` —— 唯一例外,因为 atom 节点内不能塞 `position:absolute` 锚点。

**依赖契约**:`apps/web/src/styles/components.css` 里 `.editor-toolbar .tb-inner` 必须是 `overflow:visible`,不能加 `overflow:auto` / `overflow:hidden`,否则所有下拉被裁掉。这条契约在 CSS 注释里已正式标记。`MentionList` 因为 Tippy mount body,它的样式集中在 `apps/web/src/styles/mention.css`(global,非 scoped)。

## 阅读视图

`apps/web/src/views/ReadView.vue` 通过 `v-html`(在 `apps/web/src/lib/sanitize.ts` 中预先 sanitize)渲染 `contentHTML`。`TocPanel.vue` 用 `IntersectionObserver` 做 scroll-spy,点击目录项滚动到锚点;锚点由 `apps/web/src/lib/headingAnchors.ts` 在 `v-html` 渲染后注入(因为 `v-html` 不在 ProseMirror 管辖范围)。

**折叠块 read 端默认收起**:`safeHtml` 在 `sanitizeAndHardenLinks` 之后再走一次 `collapseTogglesByDefault`,把所有 `<details open>` 的 `open` 属性剥掉,渲染时浏览器原生 collapsed。用户点 summary 仍可展开,刷新页面后回到 collapsed —— "默认折叠" 的语义。不放在 `sanitize.ts` 里,因为 `exportPageAsHtml` 也走那条管道,导出需要保留原 open 状态。

## 评论系统

`CommentsSection.vue` 嵌入 ReadView 底部,管整页评论树(顶 + 二级回复,v0 嵌套深度 = 2)。`CommentItem.vue` 单条评论:
- view 态:`author · time · (已编辑) · actions` + mention chip 渲染
- edit 态(作者本人):行内 `<textarea>` + 保存/取消,Cmd/Ctrl+Enter 提交,Esc 取消
- delete 态(作者本人或 admin):自研 confirm 弹窗 + 软删除

**编辑权限 = 仅作者**(后端 `guardMutateComment` 同步收窄),admin 不能编辑他人评论但仍可删除 — 跟 Confluence / Notion / 飞书 默认一致。`canEdit` 与 `canModify` 在前端解耦:`canEdit` 仅作者(显示 ✏️),`canModify` 作者或 admin(显示 🗑)。

mention 重新计算:`useCommentMention` 只在 popover 选中时往 `mentionedUserIds` set add,文本里删 @name 不会自动 remove,会让已删的收件人仍收到通知。`saveEdit()` 在保存前调 `parseMentionsFromText(editText, candidateMap)` 从文本反查 user ids,跟 popover 集合取并集再发到后端 re-verify。

「已编辑」徽章带 `title` 属性展示「编辑于 {相对时间}」,v0 不展示「编辑人」(actor 永远是作者本人,后端已收窄)。

## 持久化层

业务数据走 Postgres(经 `apps/api` Hono 路由),前端 `stores/pages.ts` 调 `apps/web/src/lib/api.ts` 的 `api.pages.*`。`apps/web/src/lib/storage.ts` 保留作为离线降级兜底(目前未用)。

localStorage 只剩 2 个 key:`power-wiki:tree-expanded`(`ui` store)+ `power-wiki:active-space`(`spaces` store),都集中在 `packages/shared/src/keys.ts`。