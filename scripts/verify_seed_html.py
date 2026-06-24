"""验证 public/seed-demo.html 真的能用
跑法:
    py -3 scripts/verify_seed_html.py
"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

BASE = "http://localhost:5173"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1. seed-demo.html 加载没问题
        await page.goto(f"{BASE}/seed-demo.html", wait_until="networkidle")
        title = await page.title()
        print(f"[OK] 页面 title: {title}")

        # 2. 按钮存在
        btn_count = await page.locator("button:has-text('注入')").count()
        print(f"[{'OK' if btn_count == 1 else 'FAIL'}] 注入按钮存在 (实际 {btn_count})")
        if btn_count != 1:
            sys.exit(1)

        # 3. 跳到 wiki 后清空 localStorage
        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        before = await page.locator(".tree-row").count()
        print(f"[OK] 注入前树节点数: {before}")

        # 4. 回 seed 页点按钮
        await page.goto(f"{BASE}/seed-demo.html", wait_until="networkidle")
        await page.locator("button:has-text('注入')").click()
        # 等跳转
        await page.wait_for_url(f"{BASE}/**", timeout=5000)
        await page.wait_for_timeout(1500)

        # 5. 验证
        after = await page.locator(".tree-row").count()
        print(f"[{'OK' if after == 6 else 'FAIL'}] 注入后树节点数: {after} (期望 6)")

        # 6. localStorage 验证
        pages_raw = await page.evaluate("() => localStorage.getItem('power-wiki:pages')")
        if pages_raw:
            import json
            data = json.loads(pages_raw)
            print(f"[OK] localStorage 包含 {len(data)} 页")
            for p in data:
                print(f"      - {p['title']}")

        # 7. 无 page error
        if errors:
            print(f"[FAIL] page errors: {errors}")
        else:
            print("[OK] 无 page error")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
