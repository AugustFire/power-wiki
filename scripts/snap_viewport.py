"""版心自适应验证:1280 / 1440 / 1680 / 1920 视口下 content-inner 实际宽度

期望(从 grid 260 + 220 + content padding 32×2 推算):
  视口 1280 → 1280 - 260 - 220 - 64 = 736,content-inner 限 1100 → 实际 736
  视口 1440 → 1440 - 260 - 220 - 64 = 896,实际 896
  视口 1680 → 1680 - 260 - 220 - 64 = 1136,封顶 1100,实际 1100
  视口 1920 → 1920 - 260 - 220 - 64 = 1376,封顶 1100,实际 1100

工具栏 .editor-toolbar .tb-inner 应同步,跟 .content-inner 同样宽度。
"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "viewport"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
BASE = "http://localhost:5173"

# 编辑视图是 .layout.no-toc(2 栏:260 + 1fr),read 视图是 3 栏(260 + 1fr + 220)
# 这里测的是编辑视图,所以按 2 栏算中间可用
#   中间 1fr = 视口 - 260
#   减 .content 的 padding 32×2 = -64
#   content-inner max-width 1100 封顶
EXPECTED = {
    1280: (950, 962),    # 1280 - 260 - 64 = 956
    1440: (1090, 1110),  # 1440 - 260 - 64 = 1116 → 封顶 1100
    1680: (1090, 1110),  # 1680 - 260 - 64 = 1356 → 封顶 1100
    1920: (1090, 1110),  # 1920 - 260 - 64 = 1596 → 封顶 1100
}

results: list[tuple[str, bool, str]] = []

def check(name: str, ok: bool, detail: str = ""):
    mark = "[OK]" if ok else "[FAIL]"
    results.append((name, ok, detail))
    print(f"{mark} {name}{(' - ' + detail) if detail else ''}")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        for vw in (1280, 1440, 1680, 1920):
            ctx = await browser.new_context(viewport={"width": vw, "height": 900})
            page = await ctx.new_page()
            await page.goto(f"{BASE}/#/", wait_until="networkidle")
            await page.evaluate("localStorage.clear()")
            await page.reload(wait_until="networkidle")
            await page.wait_for_function(
                "document.fonts.check('1em \"Material Symbols Outlined\"')", timeout=10000
            )
            await page.wait_for_timeout(300)

            # 进编辑态(同时验证 read 和 edit 版心)
            await page.locator(".page-actions .btn.primary:has-text('新建页面')").first.click()
            await page.wait_for_timeout(800)

            # 测 content-inner
            inner_box = await page.locator(".content-inner").first.bounding_box()
            inner_w = inner_box["width"] if inner_box else 0
            lo, hi = EXPECTED[vw]
            check(f"视口 {vw}px: content-inner 实际 {inner_w:.0f}px,期望 [{lo}, {hi}]",
                  lo <= inner_w <= hi)

            # 测工具栏 tb-inner
            tb_box = await page.locator(".editor-toolbar .tb-inner").first.bounding_box()
            tb_w = tb_box["width"] if tb_box else 0
            # 工具栏 .editor-toolbar 用 margin: 0 -32px 突破 .content padding,
            # 所以 tb-inner 应比 content-inner 略宽 0~64px(被 1100 封顶),小屏会被 15px 滚动条挤掉
            check(f"视口 {vw}px: 工具栏 tb-inner 实际 {tb_w:.0f}px (≥ content-inner {inner_w:.0f}px)",
                  tb_w >= inner_w - 4)

            # 测阅读区(.read-content)的 prose 容器宽度
            await page.screenshot(path=str(SCREENSHOT_DIR / f"edit_{vw}.png"), full_page=True)

            await ctx.close()

        # 再用 1680 视口截一张 read 视图
        ctx = await browser.new_context(viewport={"width": 1680, "height": 900})
        page = await ctx.new_page()
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.wait_for_timeout(500)
        # 点开首页某页
        first_page = page.locator(".tree-row").first
        if await first_page.count() == 1:
            await first_page.click()
            await page.wait_for_timeout(800)
            # 此时应进入 read 视图
            in_read = "/p/" in page.url and "/edit" not in page.url
            if in_read:
                article_box = await page.locator(".prose.read-content").first.bounding_box()
                article_w = article_box["width"] if article_box else 0
                check(f"read 视图(1680 视口) prose 实际 {article_w:.0f}px,期望 [1000, 1110]",
                      1000 <= article_w <= 1110)
                await page.screenshot(path=str(SCREENSHOT_DIR / "read_1680.png"), full_page=True)
        await ctx.close()

        await browser.close()

    print("\n" + "=" * 60)
    print(f"通过: {sum(1 for _, ok, _ in results if ok)} / {len(results)}")
    failed = [n for n, ok, _ in results if not ok]
    if failed:
        print(f"失败项: {', '.join(failed)}")
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    asyncio.run(main())
