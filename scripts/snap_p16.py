"""放大截一个代码块,确认 header 细节。"""
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

        await page.evaluate("""() => {
            for (const r of document.querySelectorAll('.tree-row')) {
                if (r.textContent.includes('本地存储')) { r.click(); return; }
            }
        }""")
        await page.wait_for_timeout(1000)

        # 找第一个 read 端 code block 并滚动到视图
        await page.evaluate("""() => {
            const cb = document.querySelector('.prose .code-block');
            cb?.scrollIntoView({block: 'center'});
        }""")
        await page.wait_for_timeout(1500)

        info = await page.evaluate("""() => {
            const cb = document.querySelector('.prose .code-block');
            const pre = cb?.querySelector('pre');
            const code = pre?.querySelector('code');
            const rect = cb?.getBoundingClientRect();
            const preRect = pre?.getBoundingClientRect();
            return {
              cbHeight: rect?.height,
              preHeight: preRect?.height,
              codeLen: code?.textContent?.length,
              cbW: rect?.width,
            };
        }""")
        print('read cb info:', info)

        cb = await page.query_selector('.prose .code-block')
        await cb.screenshot(path=str(OUT / "p16_read_block.png"))

        # Editor
        await page.evaluate("() => document.querySelector('button.btn.primary')?.click()")
        await page.wait_for_timeout(1500)

        await page.evaluate("""() => {
            const cb = document.querySelector('.tiptap .code-block');
            cb?.scrollIntoView({block: 'center'});
        }""")
        await page.wait_for_timeout(800)

        cb2 = await page.query_selector('.tiptap .code-block')
        await cb2.screenshot(path=str(OUT / "p16_editor_block.png"))

        # 复制后状态
        info = await page.evaluate("""async () => {
            const btn = document.querySelector('.tiptap .code-block .code-block-copy');
            btn?.click();
            await new Promise(r => setTimeout(r, 100));
            return { txt: btn?.textContent?.trim(), copied: btn?.classList.contains('copied') };
        }""")
        print('after click:', info)
        await page.wait_for_timeout(200)
        cb3 = await page.query_selector('.tiptap .code-block')
        await cb3.screenshot(path=str(OUT / "p16_editor_copied.png"))

        await b.close()
        print('done')


asyncio.run(main())