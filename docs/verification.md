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
# 阶段级 — 改完一个阶段跑一遍
py -3.13 scripts/verify_b3_efficiency.py
py -3.13 scripts/verify_n_plus_1.py

# 功能级 — 改某个功能时跑
py -3.13 scripts/verify_date_inline.py
py -3.13 scripts/verify_diff_semantics.py
py -3.13 scripts/verify_restore_refresh.py

# 截图级 — 单纯拍当前视觉
py -3.13 scripts/snap_<...>.py
```

截图统一存到 `screenshots/`(已在 `.gitignore`),可随时重跑覆盖。

## 命名约定

- `verify_<feature>.py` — 跑断言,失败时报错退出
- `snap_<page>.py` — 单纯截图,不报错(用于 PR review 时附视觉)

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