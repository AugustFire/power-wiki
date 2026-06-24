"""放大截编辑器的标题,确认 # 锚点视觉。"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("C:/Users/Administrator/Desktop/power-wiki/screenshots/eval")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(
            viewport={"width": 1440, "height": 900},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = await ctx.new_page()

        await page.goto("http://localhost:5173")
        await page.evaluate("() => localStorage.clear()")
        await page.goto("http://localhost:5173")
        await page.wait_for_load_state("networkidle")
        await page.evaluate("() => document.fonts.ready")
        await page.wait_for_timeout(2000)

        # read view, hover 第一个 h2
        await page.evaluate("""() => {
            for (const r of document.querySelectorAll('.tree-row')) {
                if (r.textContent.includes('本地存储')) { r.click(); return; }
            }
        }""")
        await page.wait_for_timeout(2000)

        await page.hover('.prose h2')
        await page.wait_for_timeout(300)
        await page.evaluate("""() => document.querySelector('.prose h2').scrollIntoView({block:'center'})""")
        await page.wait_for_timeout(500)
        # Wider screenshot — capture left side where the anchor lives
        box = await page.evaluate("""() => {
            const h = document.querySelector('.prose h2');
            const a = h.querySelector(':scope > a.heading-anchor');
            const r = h.getBoundingClientRect();
            const ar = a?.getBoundingClientRect();
            return {
              h: { x: r.left, y: r.top, w: r.width, h: r.height },
              a: ar ? { x: ar.left, y: ar.top, w: ar.width, h: ar.height } : null,
              opacity: a ? getComputedStyle(a).opacity : null,
              visibility: a ? getComputedStyle(a).visibility : null,
            };
        }""")
        print('read h2 box:', box)
        clip = {
            "x": box['h']['x'] - 40,
            "y": box['h']['y'] - 10,
            "width": box['h']['w'] + 60,
            "height": box['h']['h'] + 20,
        }
        print('clip:', clip)
        await page.screenshot(path=str(OUT / "p17_read_h2.png"), clip=clip)

        # editor view
        await page.evaluate("() => document.querySelector('button.btn.primary')?.click()")
        await page.wait_for_timeout(1500)
        await page.hover('.tiptap .heading-wrapper')
        await page.wait_for_timeout(300)
        await page.evaluate("""() => document.querySelector('.tiptap .heading-wrapper').scrollIntoView({block:'center'})""")
        await page.wait_for_timeout(500)
        box = await page.evaluate("""() => {
            const h = document.querySelector('.tiptap .heading-wrapper');
            const r = h.getBoundingClientRect();
            return { x: r.left - 60, y: r.top - 10, width: r.width + 80, height: r.height + 20 };
        }""")
        await page.screenshot(path=str(OUT / "p17_editor_h2.png"), clip=box)

        await b.close()
        print('done')


asyncio.run(main())