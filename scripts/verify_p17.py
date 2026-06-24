"""验证 P1.7: H2/H3 锚点链接。"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

# Windows console encoding fix
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

OUT = Path("C:/Users/Administrator/Desktop/power-wiki/screenshots/eval")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(
            viewport={"width": 1440, "height": 900},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))
        page.on("console", lambda m: print(f"[console:{m.type}] {m.text}") if m.type in ("debug", "warning", "error") else None)

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

        # 检查 read 端的标题锚点
        read_info = await page.evaluate("""() => {
            const headings = document.querySelectorAll('.prose h2, .prose h3');
            return Array.from(headings).map((h, i) => {
                const a = h.querySelector(':scope > a.heading-anchor');
                return {
                    i,
                    tag: h.tagName,
                    id: h.id,
                    hasAnchor: !!a,
                    href: a?.getAttribute('href'),
                    anchorApplied: h.dataset?.anchorApplied,
                };
            });
        }""")
        print('read headings:', read_info)

        await page.screenshot(path=str(OUT / "p17_read.png"), full_page=False, clip={"x": 250, "y": 200, "width": 1100, "height": 700})

        # hover 一个 h2 看锚点是否显示
        await page.hover('.prose h2:nth-of-type(1)')
        await page.wait_for_timeout(300)
        hover_info = await page.evaluate("""() => {
            const h = document.querySelector('.prose h2');
            const a = h?.querySelector(':scope > a.heading-anchor');
            if (!a) return null;
            const cs = getComputedStyle(a);
            return { opacity: cs.opacity, color: cs.color };
        }""")
        print('hover info:', hover_info)

        # 截一张 hover 状态的图
        await page.screenshot(path=str(OUT / "p17_read_hover.png"), full_page=False, clip={"x": 200, "y": 200, "width": 1100, "height": 700})

        # 点击锚点 → 复制 URL
        click_info = await page.evaluate("""async () => {
            const h = document.querySelector('.prose h2');
            const a = h?.querySelector(':scope > a.heading-anchor');
            if (!a) return { ok: false, reason: 'no anchor' };
            a.click();
            await new Promise(r => setTimeout(r, 200));
            const text = a.textContent;
            const copied = a.classList.contains('copied');
            let clip = null;
            try { clip = await navigator.clipboard.readText(); } catch (e) {}
            return { ok: copied && text === '✓' && clip && clip.includes('#'), copied, text, clip };
        }""")
        print('click:', click_info)

        read_ok = (
            len(read_info) >= 3
            and all(h['hasAnchor'] and h['id'] and h['href'] == f"#{h['id']}" for h in read_info)
            and float(hover_info['opacity']) > 0.5
            and click_info.get('ok', False)
        )
        print('PASS read side' if read_ok else 'FAIL read side')

        # ── Editor 端 ──
        await page.evaluate("() => document.querySelector('button.btn.primary')?.click()")
        await page.wait_for_timeout(1500)

        editor_info = await page.evaluate("""() => {
            const headings = document.querySelectorAll('.tiptap h2, .tiptap h3');
            const allAnchors = document.querySelectorAll('.tiptap .heading-anchor');
            const sample = headings[0] ? {
              html: headings[0].outerHTML.slice(0, 300),
              childCount: headings[0].children.length,
            } : null;
            return {
              headings: Array.from(headings).map((h, i) => {
                const a = h.querySelector(':scope > a.heading-anchor');
                return {
                    i, tag: h.tagName,
                    id: h.id,
                    hasAnchor: !!a,
                    anchorApplied: h.dataset?.anchorApplied,
                };
              }),
              anchorCount: allAnchors.length,
              sample,
            };
        }""")
        print('editor headings:', editor_info['headings'])
        print('total anchors in editor:', editor_info['anchorCount'])
        print('sample h2 html:', editor_info['sample'])
        print('PASS editor side' if all(h['hasAnchor'] for h in editor_info['headings']) else 'FAIL editor side')

        print('PASS P1.7' if (read_ok and all(h['hasAnchor'] for h in editor_info['headings'])) else 'FAIL P1.7')

        await b.close()


asyncio.run(main())