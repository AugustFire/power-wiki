"""从 seed_demo.py 提取 HTML 内容,生成 seed_demo_browser.html
(用户在自己浏览器里点一下就能注入 6 篇 demo 页)

跑法:
    py -3 scripts/build_seed_html.py
"""
import re
import sys
from pathlib import Path

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
TEMPLATE = ROOT / "scripts" / "seed_demo_browser.html"
OUT = ROOT / "scripts" / "seed_demo_browser.html"

# 从 seed_demo.py 提取 6 个 HTML 字符串字面量
SOURCE = ROOT / "scripts" / "seed_demo.py"
src = SOURCE.read_text(encoding="utf-8")

def extract(name: str) -> str:
    pattern = rf'^{name}\s*=\s*"""(.*?)"""'
    m = re.search(pattern, src, re.MULTILINE | re.DOTALL)
    if not m:
        sys.exit(f"找不到 {name} = ...")
    return m.group(1)

html = TEMPLATE.read_text(encoding="utf-8")
for name in ("HOME_HTML", "ATLAS_HTML", "INCIDENT_HTML", "SNIPPET_HTML", "MEETING_HTML", "OKR_HTML"):
    content = extract(name)
    # 转义反引号和 ${} (它们在 JS template literal 里会有问题)
    safe = content.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    html = html.replace(f"__{name}__", safe)

OUT.write_text(html, encoding="utf-8")
print(f"OK: 写入 {OUT} ({len(html)} chars)")
