"""P0.2 v2:用真实导航流程验证 sanitize。"""
import asyncio, json
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
        await page.wait_for_timeout(500)

        # 找到 RFC 页 id,叠加一段 evil HTML 进去(模拟内容污染)
        await page.evaluate("""() => {
            const pages = JSON.parse(localStorage.getItem('power-wiki:pages'));
            const rfc = pages.find(p => p.title.includes('本地存储'));
            rfc.contentHTML += '<script>window.__xss=true</script><img src=x onerror="window.__img_xss=true"><a id="jslink" href="javascript:window.__js_xss=true">点我</a><a id="extlink" href="https://example.com">example</a>';
            localStorage.setItem('power-wiki:pages', JSON.stringify(pages));
        }""")
        await page.reload()
        await page.wait_for_load_state("networkidle")
        await page.evaluate("() => document.fonts.ready")
        await page.wait_for_timeout(800)

        # 进入 RFC 页
        await page.evaluate("""() => {
            for (const r of document.querySelectorAll('.tree-row')) {
                if (r.textContent.includes('本地存储')) { r.click(); return; }
            }
        }""")
        await page.wait_for_timeout(800)

        info = await page.evaluate("""() => ({
            xssFlag: window.__xss === true,
            imgXss: window.__img_xss === true,
            jsXss: window.__js_xss === true,
            scriptTags: document.querySelectorAll('.read-content script').length,
            imgWithOnerror: document.querySelectorAll('.read-content img[onerror]').length,
            jsHrefAnchors: Array.from(document.querySelectorAll('.read-content a')).filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length,
            extLink: (() => {
                const a = document.getElementById('extlink');
                return a ? {href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target')} : null;
            })(),
            paraCount: document.querySelectorAll('.read-content p').length,
        })""")
        print(json.dumps(info, ensure_ascii=False, indent=2))

        ok = (
            info['xssFlag'] is False and info['imgXss'] is False and info['jsXss'] is False
            and info['scriptTags'] == 0 and info['imgWithOnerror'] == 0
            and info['jsHrefAnchors'] == 0
            and info['extLink'] and info['extLink']['rel'] == 'noopener noreferrer'
            and info['extLink']['target'] == '_blank'
            and info['paraCount'] >= 1
        )
        print('PASS P0.2' if ok else 'FAIL P0.2')

        await b.close()


asyncio.run(main())
