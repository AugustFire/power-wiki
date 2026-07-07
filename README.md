# power-wiki

> 给团队的 Confluence 风格知识库。桌面端优先,Atlassian Atlas 设计语言。

<!-- 用户填图: 全屏主界面截图(ReadView + 树 + TOC 三栏最好同框展示)。建议 2560×1440,文件名 hero.png -->
![hero](printscreen/hero.png)

团队的文档不是写完就锁进 PDF。power-wiki 是活的:可评论、可版本化、可被搜索、可被一个团队共同拥有。个人空间写笔记,「发布到」一行把好的想法推到团队空间,带"来自 XXX 的个人分享"后缀。

## 它能做什么

- **个人 + 共享空间分离。** 每个用户自动有 personal space 写自己的笔记;admin 建 shared space 收编团队资产,按用户组授权。
- **Tiptap 2 编辑器。** 30+ 官方扩展 + 8 个自定义扩展(Callout / Toggle / PageRef / DateInline / Mention / ImageAttachment / HeadingAnchor / BlockBrowserSave),Markdown 输入规则,键盘快捷键全开。
- **评论 + @mention + 通知。** `页面上写 + @提人 + bell 红点`;`@` 候选限定为该 page 所在 space 的访问组成员;mention / reply / comment_on_my_page 三种 kind,TopBar bell 30s 轮询。
- **版本历史静默可靠。** auto-save 永远静默,30s idle 或 route-leave 边界自动打 checkpoint;inline 字符级 diff,`/p/:id/history` 独立路由,restore 一键回滚。
- **附件走对象存储。** MinIO 一行起,image inline 渲染,file 走 download;`sanitize.ts` 的 `img src` 协议白名单只放行 `/api/attachments/*`,外部 URL 粘贴图被挡。
- **全文搜索零中间件。** 后端 Drizzle `ILIKE` over title + content_text;前端 debounce 200ms + 跨 space 分组 + 命中高亮,不引 ES / Meili / Typesense。

## 编辑器

<!-- 用户填图: 编辑器主界面,展示至少 1 个 Callout / 1 个 Toggle / 1 个 PageRef / 1 个 @mention。建议 2000×1200,文件名 editor.png -->
![editor](printscreen/editor.png)

代码块自带 highlight.js + 一键复制;toolbar 收气泡菜单 + slash 菜单 + 拖拽手柄;bubble 浮于选区,slash 菜单浮于光标。DateInline 节点支持 now 模式,自动跳到当天。

## 三栏布局

280 / 1100 / 240,宽度可拖,刷新保留。TOC scroll-spy 跟着滚动高亮当前章节;打开子页自动展开树路径 + 闪一下高亮节点;树拖拽改父子关系,服务端 cycle 检测挡环。

<!-- 用户填图: 三栏布局截图,展示树 + 内容 + TOC 三栏同框。建议文件名 layout.png -->
![layout](printscreen/layout.png)

## 30 秒上手

```bash
pnpm install                  # 装依赖
docker compose up -d           # Postgres(5432)+ MinIO(9100/9101)
pnpm dev                      # 同时起 web(5173)+ api(8787)
```

打开 `http://localhost:5173`,首次启动自动 bootstrap 管理员账号(读 `apps/api/.env` 的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`)→ 跳登录 → 进主页。需要 Node 20.11+、pnpm 9+、Docker。

## 栈

Vue 3 · Tiptap 2 · Hono · Drizzle ORM · Postgres · MinIO (S3 协议) · pnpm workspaces

## 文档

- 架构 · [docs/architecture.md](./docs/architecture.md)
- API 端点 · [docs/api.md](./docs/api.md)
- 数据模型 · [docs/data-model.md](./docs/data-model.md)
- 更新日志 · [CHANGELOG.md](./CHANGELOG.md)

## License

MIT