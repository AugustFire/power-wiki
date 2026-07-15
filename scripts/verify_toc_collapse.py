"""Verify: TOC 折叠状态只出现 1 个滚动条(主页面),不再有 2 个。

判定:`clientHeight < scrollHeight` 标识元素有滚动条;`.content` 应有且仅
它一个;`.toc-panel` 折叠后不应有滚动条(应该 hidden 或宽度为 0)。

策略:直接调用 API 找一个带 headings 的现有页面,免去动态建页+保存的麻烦。
"""
import sys
import io
import urllib.request
import json
from http.cookiejar import CookieJar
from urllib.request import HTTPCookieProcessor, build_opener
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173"
API = "http://127.0.0.1:8787"


def signin() -> tuple[str, str]:
    cj = CookieJar()
    opener = build_opener(HTTPCookieProcessor(cj))
    req = urllib.request.Request(
        f"{API}/api/auth/sign-in",
        data=json.dumps({"email": "admin@power-wiki.local", "password": "admin123"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    opener.open(req).read()
    cookie = next(c.value for c in cj if c.name == "pw_session")
    return cookie, "; ".join(f"{c.name}={c.value}" for c in cj)


def list_space_pages(cookie: str) -> list[dict]:
    """List all pages, pick the one with most headings (TOC overflow candidate)."""
    import re

    req = urllib.request.Request(
        f"{API}/api/pages?limit=100&offset=0",
        headers={"Cookie": f"pw_session={cookie}"},
    )
    data = json.loads(urllib.request.urlopen(req).read())
    items = data.get("items") if isinstance(data, dict) else data
    out: list[dict] = []
    for pg in items or []:
        pid = pg.get("id") or pg.get("pageId")
        if not pid:
            continue
        req = urllib.request.Request(
            f"{API}/api/pages/{pid}",
            headers={"Cookie": f"pw_session={cookie}"},
        )
        try:
            page_data = json.loads(urllib.request.urlopen(req).read())
        except Exception:
            continue
        cjson = page_data.get("contentJSON") or {}
        chtml = page_data.get("contentHtml") or ""
        # 用 contentJSON 计数 headings(prosemirror JSON 形式)
        n_h = 0
        def walk(node):
            nonlocal n_h
            if isinstance(node, dict):
                t = node.get("type")
                if t in ("heading",) and node.get("attrs", {}).get("level", 0) in (1, 2, 3):
                    n_h += 1
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        walk(cjson)
        if n_h == 0 and chtml:
            n_h = len(re.findall(r"<h[1-3]\b", chtml))
        if n_h >= 3:
            out.append({"id": pid, "title": pg.get("title", "?"), "headings": n_h})
    return out


def check_scrollbars(page, label: str) -> dict:
    info = page.evaluate("""
        () => {
          const targets = [
            { sel: '.layout',    name: 'layout' },
            { sel: '.content',   name: 'content' },
            { sel: '.toc-panel', name: 'toc-panel' },
          ];
          return targets.map(t => {
            const el = document.querySelector(t.sel);
            if (!el) return { name: t.name, exists: false };
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const scrollH = el.scrollHeight, clientH = el.clientHeight;
            const overflowY = cs.overflowY;
            const hasScrollY = (overflowY === 'auto' || overflowY === 'scroll') && scrollH > clientH + 1;
            return {
              name: t.name, exists: true,
              width: rect.width, scrollH, clientH,
              overflowY, opacity: cs.opacity, hasScrollY,
            };
          });
        }
    """)
    print(f"\n--- {label} ---")
    for r in info:
        if not r.get('exists'):
            print(f"  {r['name']:12s} (not present)")
            continue
        flag = ""
        if r['name'] == 'toc-panel' and r.get('opacity') == '0':
            flag = " <- hidden"
        if r['name'] == 'toc-panel' and r.get('hasScrollY'):
            flag += " !! scrollbar visible"
        print(f"  {r['name']:12s} w={r['width']:5.0f}  "
              f"scrollH={r['scrollH']:5d}  clientH={r['clientH']:5d}  "
              f"overflowY={r['overflowY']:8s}  opacity={r['opacity']}{flag}")
    return info


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    cookie, _ = signin()
    print("finding a page with rich headings via API ...")
    candidates = list_space_pages(cookie)
    candidates.sort(key=lambda x: -x["headings"])
    if not candidates:
        print("ERROR: no page with >= 3 headings found via API")
        return 2
    target = candidates[0]
    pid = target["id"]
    print(f"  selected pid={pid} title={target['title']!r} headings={target['headings']}")
    for i, c in enumerate(candidates[:6]):
        print(f"   candidate[{i}]: pid={c['id']} h={c['headings']} {c['title']!r}")

    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 2560, "height": 900})
        ctx.add_cookies([{
            "name": "pw_session", "value": cookie, "domain": "127.0.0.1",
            "path": "/", "httpOnly": True, "sameSite": "Lax",
        }])
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))

        # 直接 read mode (先 /#/ 让 router 引导,然后点击链接到 read)
        page.goto(f"{BASE}/")
        page.wait_for_selector(".ss-root", timeout=10000)
        page.wait_for_timeout(500)
        if page.locator(".ss-trigger-clickable").count() > 0:
            page.click(".ss-trigger-clickable")
            page.wait_for_selector(".ss-menu", timeout=3000)
            page.click(".ss-menu-item")
            page.wait_for_timeout(800)
        # 直接 hash 跳转,跟现有 verify 同样的路由
        page.evaluate(f"() => location.hash = '#/p/{pid}'")
        page.wait_for_selector(".toc-panel", timeout=10000)
        page.wait_for_timeout(1200)  # 等 headings collector + skeleton 消失

        if page.locator(".toc-collapse-btn").count() == 0:
            failures.append("ReadView 加载后未渲染 .toc-collapse-btn")
        n_items = page.locator(".toc-item").count()
        print(f"  toc-item count: {n_items}")

        check_scrollbars(page, "ReadView BEFORE collapse")
        page.screenshot(path="scripts/screenshots/toc-fix-1-before.png", full_page=False)

        page.click(".toc-collapse-btn")
        page.wait_for_timeout(500)
        info_after = check_scrollbars(page, "ReadView AFTER collapse")
        page.screenshot(path="scripts/screenshots/toc-fix-2-collapsed.png", full_page=False)

        toc_after = next((r for r in info_after if r.get('name') == 'toc-panel' and r.get('exists')), None)
        if not toc_after or toc_after.get('width', -1) > 5:
            failures.append(f"折叠态 .toc-panel width 应 ≤ 5px,实测 {toc_after.get('width') if toc_after else 'not found'}")
        if toc_after and toc_after.get('hasScrollY'):
            failures.append("ReadView 折叠态 .toc-panel 仍显示滚动条 (hasScrollY=true)")

        page.click(".toc-expand-handle")
        page.wait_for_timeout(500)
        info_open = check_scrollbars(page, "ReadView AFTER expand")
        page.screenshot(path="scripts/screenshots/toc-fix-3-expanded.png", full_page=False)
        toc_open = next((r for r in info_open if r.get('name') == 'toc-panel' and r.get('exists')), None)
        if not toc_open or toc_open.get('width', -1) < 200:
            failures.append(f"展开态 .toc-panel width 应 ≥ 200px,实测 {toc_open.get('width') if toc_open else 'not found'}")

        # EditView
        page.goto(f"{BASE}/#/p/{pid}/edit")
        page.wait_for_selector(".ProseMirror", timeout=5000)
        page.wait_for_timeout(1200)
        check_scrollbars(page, "EditView BEFORE collapse")
        if page.locator(".toc-collapse-btn").count() == 0:
            failures.append("EditView 加载后未渲染 .toc-collapse-btn")
        else:
            page.click(".toc-collapse-btn")
            page.wait_for_timeout(500)
            info_edit_after = check_scrollbars(page, "EditView AFTER collapse")
            page.screenshot(path="scripts/screenshots/toc-fix-4-edit-collapsed.png", full_page=False)
            toc_edit_after = next(
                (r for r in info_edit_after if r.get('name') == 'toc-panel' and r.get('exists')),
                None,
            )
            if toc_edit_after and toc_edit_after.get('hasScrollY'):
                failures.append("EditView 折叠态 .toc-panel 仍显示滚动条 (hasScrollY=true)")

        if errors:
            print("\n=== BROWSER ERRORS ===")
            for e in errors[:20]:
                print(f"  ! {e}")
        else:
            print("\n(no browser errors)")

        print("\n=== RESULT ===")
        if failures:
            for f in failures:
                print(f"  X {f}")
        else:
            print("  + all checks passed")
        browser.close()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
