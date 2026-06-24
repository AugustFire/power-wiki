"""验证 P0.2: DOMPurify XSS 防护 + 链接 hardening。"""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("C:/Users/Administrator/Desktop/power-wiki/screenshots/eval")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        # 先观察是否被 XSS
        await page.goto("http://localhost:5173")
        await page.evaluate("() => localStorage.clear()")

        # 直接种入一份含恶意 payload 的页面,模拟"用户从外部粘贴富文本进来"
        await page.goto("http://localhost:5173")
        await page.evaluate("""() => {
            const evil = {
                id: 'evil',
                parentId: null,
                title: 'XSS 测试',
                contentJSON: {type:'doc',content:[{type:'paragraph'}]},
                contentHTML: '<p>正常段落</p><script>window.__xss=true;alert(1)</script><img src=x onerror="window.__img_xss=true"><a href="javascript:window.__js_xss=true">点我</a><p>外链:</p><a href="https://example.com">example</a>',
                order: 99,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                authorId: 'me',
            };
            localStorage.setItem('power-wiki:pages', JSON.stringify([evil]));
        }""")
        await page.goto("http://localhost:5173/#/p/evil")
        await page.wait_for_load_state("networkidle")
        await page.evaluate("() => document.fonts.ready")
        await page.wait_for_timeout(1500)

        info = await page.evaluate("""() => ({
            xssFlag: window.__xss === true,
            imgXss: window.__img_xss === true,
            jsXss: window.__js_xss === true,
            scriptTags: document.querySelectorAll('.read-content script').length,
            imgWithOnerror: document.querySelectorAll('.read-content img[onerror]').length,
            jsHrefAnchors: Array.from(document.querySelectorAll('.read-content a')).filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length,
            externalAnchors: Array.from(document.querySelectorAll('.read-content a[href^="https://"]')).map(a => ({
                href: a.getAttribute('href'),
                rel: a.getAttribute('rel'),
                target: a.getAttribute('target'),
            })),
            paraCount: document.querySelectorAll('.read-content p').length,
        })""")
        print(json.dumps(info, ensure_ascii=False, indent=2))

        ok = (
            info['xssFlag'] is False
            and info['imgXss'] is False
            and info['jsXss'] is False
            and info['scriptTags'] == 0
            and info['imgWithOnerror'] == 0
            and info['jsHrefAnchors'] == 0
            and all(a.get('rel') == 'noopener noreferrer' and a.get('target') == '_blank' for a in info['externalAnchors'])
        )
        print("PASS P0.2" if ok else "FAIL P0.2")

        await b.close()


asyncio.run(main())
