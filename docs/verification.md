# 验收脚本

`scripts/verify_*.py` 和 `scripts/snap_*.py` 是按阶段划分的 Playwright 自动化检查,改动完成后跑一遍就能验证视觉 / 行为基线。

## 安装

```bash
pip install playwright
playwright install chromium
```

需要 Python 3.13+ 和 dev server 在 `127.0.0.1:5173` 上跑着。

## 启动 dev server

```bash
docker compose up -d         # Postgres(若未起)
pnpm dev                      # 同时起 web(5173) + api(8787)
```

## 跑脚本

```bash
# 阶段级 — 改完一个阶段跑一遍(本组没有 CLI 参数,直接跑)
py -3.13 scripts/verify_b3_efficiency.py
py -3.13 scripts/verify_n_plus_1.py
py -3.13 scripts/verify_phase8_efficiency.py

# 功能级 — 改某个功能时跑(无 CLI 参数,直接跑)
py -3.13 scripts/verify_date_inline.py
py -3.13 scripts/verify_diff_semantics.py
py -3.13 scripts/verify_emoji.py
py -3.13 scripts/verify_mention_popover.py
py -3.13 scripts/verify_comment_ux.py
py -3.13 scripts/verify_export_smoke.py
py -3.13 scripts/verify_personal_space.py

# 截图级 — 单纯拍当前视觉(snap_*.py 也无 CLI 参数)
py -3.13 scripts/snap_<page>.py
```

截图统一存到 `screenshots/`(已在 `.gitignore`),可随时重跑覆盖。`scripts/` 目前有 **60+ `verify_*.py` + 10+ `snap_*.py`**,核心子集见下方"脚本目录"。

## 命名约定

- `verify_<feature>.py` — 跑断言,失败时报错退出
- `snap_<page>.py` — 单纯截图,不报错(用于 PR review 时附视觉)
- `verify_phase<N>_<area>.py` — 按里程碑聚合的端到端验收(phase1..8)

## 脚本目录(核心子集)

| 脚本 | 覆盖 |
|---|---|
| `verify_b3_efficiency.py` | admin 视图 mount 请求数预算 + edit-new-url-instant |
| `verify_n_plus_1.py` | admin 跨 view 切换 0 个 `pages?space=` 重复请求 |
| `verify_phase8_efficiency.py` | Stage 8 性能预算(页面树懒加载 + 评论分页 + 全文搜索) |
| `verify_emoji.py` | toolbar 表情按钮 + 折叠块小标题表情输入 |
| `verify_mention_popover.py` | `@` mention 弹层搜索 + 键盘导航 + 跨 view 缓存 |
| `verify_comment_ux.py` | 评论列表 / composer / 分页 / 软删除 |
| `verify_export_smoke.py` | 单页导出 HTML / MD / PDF 烟测 + 文件名清洗 + chrome strip |
| `verify_personal_space.py` | personal space auto-bootstrap + admin 写保护 `personal_space_readonly` |
| `verify_diff_semantics.py` | inline 字符级 diff 语义 + unchanged-run 折叠 |
| `verify_date_inline.py` | DateInline now/fixed 模式 + 60s live 重算 |
| `verify_attach_upload.py` *(若存在)* | MinIO 附件上传 / 列表 / 下载 / 删除 |
| `verify_topbar_space_switcher.py` | TopBar space 切换 + 树懒加载 |
| `verify_template_icons_api.py` | 模板图标 API 兼容(历史保留) |
| `snap_*.py`(10+ 个) | 各 view 视觉快照,PR review 附图用 |

## 加新脚本

新功能 / 新视图验收时:

1. 复制现有最接近的脚本作为模板
2. 命名 `verify_<feature>.py`
3. 启动 Playwright,登录 → 触发场景 → 抓 DOM / Network → 断言
4. 截图存 `screenshots/<feature>-<scenario>.png`
5. 在 `docs/verification.md` 本节末尾登记一行

## 跟手动测试的关系

验收脚本**不**替代手动测试,但能:

- 截断视觉回归(改了 CSS 不知道改了哪 → 跑截图脚本对比)
- 锁定 API 契约(改返回字段 → 脚本断言失败)
- CI / pre-commit hook 时跑(可选,目前没配)

复杂交互(多 tab、拖拽、长流程)还是得手测,脚本只覆盖 happy path + 关键边界。