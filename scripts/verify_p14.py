"""验证 P1.4: 代码块语法高亮。"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

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

        # 进 RFC 种子页(有 typescript 代码块)
        await page.evaluate("""() => {
            for (const r of document.querySelectorAll('.tree-row')) {
                if (r.textContent.includes('本地存储')) { r.click(); return; }
            }
        }""")
        await page.wait_for_timeout(800)
        await page.wait_for_timeout(800)
        await page.evaluate("() => document.querySelector('.tiptap') || document.querySelector('a.btn.primary')?.click()")

        info = await page.evaluate("""() => {
            const pres = document.querySelectorAll('.prose pre');
            const samples = [];
            pres.forEach((pre, i) => {
                const code = pre.querySelector('code');
                const lang = code?.className.match(/language-(\w+)/)?.[1];
                const spans = code?.querySelectorAll('span[class^="hljs-"]');
                const classes = code ? Array.from(new Set(Array.from(code.querySelectorAll('span')).map(s => Array.from(s.classList).filter(c => c.startsWith('hljs-'))).flat())).slice(0, 8) : [];
                samples.push({i, lang, spanCount: spans?.length || 0, classes});
            });
            return samples;
        }""")
        print('read 代码块:', info)

        await page.screenshot(path=str(OUT / "p14_highlight.png"), full_page=False, clip={"x": 250, "y": 400, "width": 1100, "height": 700})

        ok = any(s.get('lang') == 'typescript' and s.get('spanCount', 0) >= 3 for s in info)
        print('PASS P1.4' if ok else 'FAIL P1.4')

        await b.close()


asyncio.run(main())
