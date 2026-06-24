"""验证 P2: 拖拽手柄。"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
OUT = Path("C:/Users/Administrator/Desktop/power-wiki/screenshots/eval")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        await page.goto("http://localhost:5173")
        await page.evaluate("() => localStorage.clear()")
        await page.goto("http://localhost:5173")
        await page.wait_for_load_state("networkidle")
        await page.evaluate("() => document.fonts.ready")
        await page.wait_for_timeout(2000)

        await page.evaluate("""() => {
            for (const r of document.querySelectorAll('.tree-row')) {
                if (r.textContent.includes('本地存储')) { r.click(); return; }
            }
        }""")
        await page.wait_for_timeout(2000)
        await page.evaluate("() => document.querySelector('button.btn.primary')?.click()")
        await page.wait_for_timeout(1500)

        # 悬停在一个段落上,看手柄是否出现
        await page.evaluate("""() => {
            const p = document.querySelector('.tiptap p');
            p?.scrollIntoView({block:'center'});
        }""")
        await page.wait_for_timeout(500)
        await page.hover('.tiptap p')
        await page.wait_for_timeout(800)

        info = await page.evaluate("""() => {
            const handles = document.querySelectorAll('.drag-handle');
            const tippyBoxes = document.querySelectorAll('.tippy-box');
            const visible = Array.from(handles).filter(h => {
                const r = h.getBoundingClientRect();
                const cs = getComputedStyle(h);
                const parent = h.closest('.tippy-box');
                const parentCs = parent ? getComputedStyle(parent) : null;
                return r.width > 0 && (cs.opacity > 0) && (!parentCs || parentCs.visibility !== 'hidden');
            });
            return {
              totalHandles: handles.length,
              visibleHandles: visible.length,
              tippyBoxes: tippyBoxes.length,
              tippyVisibles: Array.from(tippyBoxes).filter(b => getComputedStyle(b).visibility !== 'hidden').length,
            };
        }""")
        print('drag handle info:', info)

        # 截图
        await page.screenshot(path=str(OUT / "p18_drag.png"), full_page=False, clip={"x": 250, "y": 200, "width": 1100, "height": 700})

        ok = info['visibleHandles'] >= 1
        print('PASS P2 drag' if ok else 'FAIL P2 drag')

        await b.close()


asyncio.run(main())