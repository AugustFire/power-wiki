"""验证 P1.1: 选中文字时 BubbleMenu 出现,带格式按钮和链接入口。"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("C:/Users/Administrator/Desktop/power-wiki/screenshots/eval")
OUT.mkdir(parents=True, exist_ok=True)


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

        # 进 RFC 编辑页
        await page.evaluate("""() => {
            for (const r of document.querySelectorAll('.tree-row')) {
                if (r.textContent.includes('本地存储')) { r.click(); return; }
            }
        }""")
        await page.wait_for_timeout(800)
        await page.evaluate("""() => {
            for (const b of document.querySelectorAll('.btn.primary')) {
                if (b.textContent.includes('编辑')) { b.click(); return; }
            }
        }""")
        await page.wait_for_timeout(2500)

        # 选中第一段正文
        await page.evaluate("""() => {
            const ed = document.querySelector('.tiptap');
            const para = ed.querySelectorAll('p')[2] || ed.querySelector('p');
            const range = document.createRange();
            const sel = window.getSelection();
            const text = para.firstChild;
            if (text && text.nodeType === 3) {
                range.setStart(text, 0);
                range.setEnd(text, Math.min(text.length, 30));
            } else {
                range.selectNodeContents(para);
            }
            sel.removeAllRanges();
            sel.addRange(range);
            para.scrollIntoView({block:'center'});
        }""")
        await page.wait_for_timeout(400)

        info = await page.evaluate("""() => {
            const bm = document.querySelector('.bubble-menu');
            const fmtBtns = bm ? bm.querySelectorAll('.bubble-row .bubble-btn').length : 0;
            const icons = bm ? Array.from(bm.querySelectorAll('.bubble-btn .material-symbols-outlined')).map(s => s.textContent.trim()) : [];
            return {
                visible: !!bm,
                display: bm ? getComputedStyle(bm).display : null,
                fmtBtns,
                icons,
            };
        }""")
        print(info)
        await page.screenshot(path=str(OUT / "p11_bubble.png"), clip={"x": 200, "y": 60, "width": 1200, "height": 360})

        ok = info['visible'] and info['fmtBtns'] >= 4 and 'format_bold' in info['icons'] and 'link' in info['icons']
        print('PASS P1.1' if ok else 'FAIL P1.1')

        await b.close()


asyncio.run(main())
