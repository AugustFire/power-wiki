"""Verify toolbar position by taking a screenshot of the edit page."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
OUT = ROOT / "screenshots"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        # Clear localStorage so we get seed data
        await page.goto("http://localhost:5173")
        await page.evaluate("() => localStorage.clear()")
        await page.goto("http://localhost:5173")
        await page.wait_for_load_state("networkidle")
        for family in ("Material Symbols Outlined", "Plus Jakarta Sans"):
            try:
                await page.wait_for_function(
                    f"document.fonts.check('1em \"{family}\"')", timeout=5000
                )
            except Exception:
                pass
        await page.wait_for_timeout(800)

        # Navigate to the edit page of the first root page
        info = await page.evaluate(
            """() => {
                const firstRow = document.querySelector('.tree-row');
                const title = firstRow?.querySelector('.label')?.textContent?.trim();
                return {title};
            }"""
        )
        print("First root:", info)

        # Click on first root and then edit
        await page.evaluate(
            """() => {
                const firstRow = document.querySelector('.tree-row');
                firstRow?.click();
            }"""
        )
        await page.wait_for_timeout(800)
        # Click the edit button
        await page.evaluate(
            """() => {
                const btns = document.querySelectorAll('.btn.primary');
                for (const b of btns) {
                    if (b.textContent.includes('编辑')) { b.click(); return; }
                }
            }"""
        )
        await page.wait_for_timeout(2000)

        # Take screenshot
        await page.screenshot(path=str(OUT / "edit_toolbar.png"), full_page=False)
        # Also a top-cropped screenshot
        await page.screenshot(path=str(OUT / "edit_toolbar_top.png"), clip={"x": 0, "y": 0, "width": 1440, "height": 300})

        # Inspect toolbar position
        info = await page.evaluate(
            """() => {
                const tb = document.querySelector('.editor-toolbar');
                if (!tb) return {error: 'no toolbar'};
                const cs = getComputedStyle(tb);
                const rect = tb.getBoundingClientRect();
                const content = document.querySelector('.content');
                const contentRect = content?.getBoundingClientRect();
                return {
                    position: cs.position,
                    top: cs.top,
                    height: rect.height,
                    rectLeft: rect.left,
                    rectRight: rect.right,
                    rectTop: rect.top,
                    contentLeft: contentRect?.left,
                    contentRight: contentRect?.right,
                    contentTop: contentRect?.top,
                    borderTop: cs.borderTop,
                    borderBottom: cs.borderBottom,
                    borderRadius: cs.borderRadius,
                    margin: cs.margin,
                    background: cs.background,
                };
            }"""
        )
        print("Toolbar position:", info)

        await browser.close()


asyncio.run(main())
