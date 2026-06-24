"""验证 P1.2 v2: 在新建空白页验证 slash 菜单键盘导航。"""
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

        # 创建新页面
        await page.evaluate("""() => {
            for (const b of document.querySelectorAll('.btn.primary')) {
                if (b.textContent.includes('新建页面') || b.textContent.includes('创建')) { b.click(); return; }
            }
        }""")
        await page.wait_for_timeout(1500)

        # 聚焦编辑器
        await page.evaluate("""() => {
            const ed = document.querySelector('.tiptap');
            if (!ed) return;
            ed.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            const para = ed.querySelector('p');
            if (para) {
                range.selectNodeContents(para);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }""")
        await page.wait_for_timeout(200)

        # 触发 slash 菜单
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

        await page.screenshot(path=str(OUT / "p12_slash_open.png"), clip={"x": 100, "y": 60, "width": 1100, "height": 500})

        # ↓↓↓ 三次到第 4 项
        for _ in range(3):
            await page.keyboard.press('ArrowDown')
            await page.wait_for_timeout(80)
        info2 = await page.evaluate("""() => {
            const items = document.querySelectorAll('.slash-menu .slash-item');
            return {
                active: items && Array.from(items).find(i => i.classList.contains('active'))?.querySelector('.label')?.textContent,
                count: items?.length || 0,
            };
        }""")
        print('after ↓↓↓:', info2)

        # ↑ 回 1
        await page.keyboard.press('ArrowUp')
        await page.wait_for_timeout(80)
        info3 = await page.evaluate("""() => {
            const items = document.querySelectorAll('.slash-menu .slash-item');
            return {
                active: items && Array.from(items).find(i => i.classList.contains('active'))?.querySelector('.label')?.textContent,
            };
        }""")
        print('after ↓↓↓↑:', info3)

        # 输入 "代" 过滤
        await page.keyboard.type('代')
        await page.wait_for_timeout(200)
        info4 = await page.evaluate("""() => {
            const m = document.querySelector('.slash-menu');
            const items = m ? Array.from(m.querySelectorAll('.slash-item')) : [];
            return {
                menuExists: !!m,
                count: items.length,
                labels: items.map(i => i.querySelector('.label')?.textContent),
                active: items.find(i => i.classList.contains('active'))?.querySelector('.label')?.textContent,
            };
        }""")
        print('after 代 filter:', info4)

        # Esc 关闭
        await page.keyboard.press('Escape')
        await page.wait_for_timeout(200)
        info5 = await page.evaluate("""() => ({
            menuClosed: !document.querySelector('.slash-menu'),
            editorHasText: document.querySelector('.tiptap').textContent,
        })""")
        print('after Esc:', info5)

        ok = (
            info1['open'] and info1['count'] == 9 and info1['activeLabel'] == '一级标题'
            and '↑↓' in (info1['hintText'] or '')
            and info2['active'] == '无序列表' and info2['count'] == 9
            and info3['active'] == '三级标题'
            and info4['count'] == 1 and info4['active'] == '代码块'
            and info5['menuClosed'] and '代' in info5['editorHasText']
        )
        print('PASS P1.2' if ok else 'FAIL P1.2')

        await b.close()


asyncio.run(main())
