# Docs

深度文档。README 给「30 秒上手」,CLAUDE.md 给 AI 协作者「硬约束 + 关键约定」,本文档回答「具体某一块怎么工作的」。

## 索引

| 文档 | 内容 | 何时来读 |
|---|---|---|
| [architecture.md](./architecture.md) | 启动 / 路由 / 状态管理 / 编辑器流水线 / 8 个 Tiptap 自定义扩展 / Popover 契约(3 类定位)/ 阅读视图 / 持久化层 / 弹窗 chrome(focus trap) | 改 frontend 任意 view / store / 路由 / 扩展时 |
| [api.md](./api.md) | 完整 API 端点契约(21 个 route mount / 23 个 `app.route` 调用):Auth / Pages(含 versions / labels / snapshots / restrictions / shares 子路由)/ Spaces(含 permissions 子路由)/ Attachments / Comments / Notifications / Users(自服务) / Search / Admin(Users / Groups / Spaces / Settings / Audit)+ 公开 share / avatar raw proxy / avatar presets | 加 / 改 / 调 API 路由时 |
| [data-model.md](./data-model.md) | Drizzle schema(21 张表)、recursive CTE 模式、auth 自研设计、ensurePersonalSpace / personalSpaceGuard、Phase A/B/C/D 表字段、DB 注释硬约束 | 改 schema / 加新表 / 加新列时 |
| [permissions.md](./permissions.md) | 「能力速查」矩阵(6 种身份 × 25 项能力)、角色定义、3 个易踩不对称(viewer hide vs disable、space-admin ≠ global admin、admin 不可授组)、页面限制继承规则(view BFS / edit 不继承)、公开分享校验链、UI 入口 gate 表;下半段给开发者的算法 + ER 图 + 文件位置索引 + 8 个边界场景 FAQ | 改 lib/permissions / 加 page 限制 / 加 share / 改 UI gate 时 |
| [loading-ux.md](./loading-ux.md) | 数据获取 + Loading UX 硬约束(16 条,含 admin mount 请求数预算) | 加新 view / 新组件 / 新路由时必读 |
| [verification.md](./verification.md) | Playwright 验收脚本使用 + 安装 + 脚本目录(60+ verify / 10+ snap) | 改完代码后跑验证 / 加新 verify 脚本时 |

仓库根还有 [CHANGELOG.md](../CHANGELOG.md) —— 用户可见的版本变更都登记在这里。

## 文档不是单一文件的理由

- CLAUDE.md / README.md 长度上 ~60 行 / ~140 行,如果继续把所有细节塞进去,AI / 用户第一次看就会被淹没
- 按主题分文件后,改某一块只在对应文件 diff,review 友好
- 链接结构 = 渐进式披露:用户不需要的细节就不展开,需要时点进去即可