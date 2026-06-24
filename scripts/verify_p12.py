"""验证 P1.2: Slash 菜单键盘导航。"""
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

        # 聚焦编辑器,移到末尾,触发 /
        await page.evaluate("""() => {
            const ed = document.querySelector('.tiptap');
            ed.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            const para = ed.querySelector('p');
            if (para && para.firstChild) {
                range.setStart(para.firstChild, para.firstChild.length);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }""")
        await page.keyboard.type('/')
        await page.wait_for_timeout(400)

        info1 = await page.evaluate("""() => {
            const m = document.querySelector('.slash-menu');
            const items = m ? Array.from(m.querySelectorAll('.slash-item')) : [];
            return {
                open: !!m,
                count: items.length,
                firstLabel: items[0]?.querySelector('.label')?.textContent || null,
                activeLabel: items.find(i => i.classList.contains('active'))?.querySelector('.label')?.textContent || null,
                hintText: m?.querySelector('.slash-hint')?.textContent || null,
            };
        }""")
        print('after /:', info1)

        # ↓ ArrowDown 两次,激活第三项
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await page.wait_for_timeout(150)
        info2 = await page.evaluate("""() => {
            const items = document.querySelectorAll('.slash-menu .slash-item');
            return Array.from(items).find(i => i.classList.contains('active'))?.querySelector('.label')?.textContent;
        }""")
        print('after ↓↓:', info2)

        # ↑ ArrowUp 一次,激活第二项
        await page.keyboard.press('ArrowUp')
        await page.wait_for_timeout(150)
        info3 = await page.evaluate("""() => {
            const items = document.querySelectorAll('.slash-menu .slash-item');
            return Array.from(items).find(i => i.classList.contains('active'))?.querySelector('.label')?.textContent;
        }""")
        print('after ↓↓↑:', info3)

        # 输入 "代" 过滤
        await page.keyboard.type('代')
        await page.wait_for_timeout(200)
        info4 = await page.evaluate("""() => {
            const items = Array.from(document.querySelectorAll('.slash-menu .slash-item'));
            return {
                count: items.length,
                labels: items.map(i => i.querySelector('.label')?.textContent),
                active: items.find(i => i.classList.contains('active'))?.querySelector('.label')?.textContent,
            };
        }""")
        print('after 代 filter:', info4)

        # Enter 应用
        await page.keyboard.press('Enter')
        await page.wait_for_timeout(400)
        info5 = await page.evaluate("""() => ({
            menuClosed: !document.querySelector('.slash-menu'),
            hasPre: !!document.querySelector('.tiptap pre'),
            activeBlock: document.querySelector('.tiptap pre code')?.textContent?.slice(0, 40) || null,
        })""")
        print('after Enter:', info5)

        await page.screenshot(path=str(OUT / "p12_slash.png"), clip={"x": 200, "y": 60, "width": 1200, "height": 400})

        ok = (
            info1['open'] and info1['count'] == 9 and info1['activeLabel'] == '一级标题'
            and '↑↓' in (info1['hintText'] or '')
            and info2 == '三级标题'
            and info3 == '二级标题'
            and info4['count'] == 1 and '代码' in info4['labels'][0]
            and info5['menuClosed'] and info5['hasPre']
        )
        print('PASS P1.2' if ok else 'FAIL P1.2')

        await b.close()


asyncio.run(main())
