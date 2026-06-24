"""验证 P1.2 v3: 单独验证 Esc 关闭。"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("console", lambda m: print(f"[console.{m.type}] {m.text}"))
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        await page.goto("http://localhost:5173")
        await page.evaluate("() => localStorage.clear()")
        await page.goto("http://localhost:5173")
        await page.wait_for_load_state("networkidle")
        await page.evaluate("() => document.fonts.ready")
        await page.wait_for_timeout(2000)

        # 创建新页面
        await page.evaluate("""() => {
            for (const b of document.querySelectorAll('.btn.primary')) {
                if (b.textContent.includes('新建') || b.textContent.includes('创建')) { b.click(); return; }
            }
        }""")
        await page.wait_for_timeout(1500)

        await page.evaluate("""() => {
            const ed = document.querySelector('.tiptap');
            ed.focus();
        }""")
        await page.keyboard.type('/')
        await page.wait_for_timeout(400)
        before = await page.evaluate("""() => ({
            menu: !!document.querySelector('.slash-menu'),
            focused: document.activeElement?.className,
        })""")
        print('before Esc:', before)

        await page.keyboard.press('Escape')
        await page.wait_for_timeout(400)
        after = await page.evaluate("""() => ({
            menu: !!document.querySelector('.slash-menu'),
            focused: document.activeElement?.className,
        })""")
        print('after Esc:', after)

        await b.close()


asyncio.run(main())
