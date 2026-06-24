"""验证 P1: 代码块 header(语言标签 + 复制按钮)。"""
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
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))
        page.on("console", lambda m: print(f"[console:{m.type}] {m.text}") if m.type in ("error", "warning") else None)

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
        await page.wait_for_timeout(1000)

        # ── Read view ──
        read_info = await page.evaluate("""() => {
            const blocks = document.querySelectorAll('.prose .code-block');
            const samples = [];
            blocks.forEach((b, i) => {
                const lang = b.querySelector('.code-block-lang')?.textContent?.trim();
                const copy = b.querySelector('.code-block-copy');
                const pre = b.querySelector('pre');
                const code = pre?.querySelector('code');
                const codeClass = code?.className || '';
                samples.push({
                    i, lang,
                    hasCopy: !!copy,
                    copyText: copy?.textContent?.trim(),
                    codeLang: codeClass.match(/language-(\\w+)/)?.[1] || null,
                    hljsApplied: code?.dataset?.hljsApplied,
                });
            });
            return samples;
        }""")
        print('read:', read_info)

        await page.screenshot(path=str(OUT / "p16_read.png"), full_page=True)

        read_ok = (
            len(read_info) >= 2
            and all(b['hasCopy'] and '复制' in b['copyText'] for b in read_info)
            and all(b['lang'] for b in read_info)
        )
        print('PASS read side' if read_ok else 'FAIL read side')

        # ── Editor view ──
        # 进入编辑模式
        await page.evaluate("() => document.querySelector('button.btn.primary')?.click()")
        await page.wait_for_timeout(1500)

        editor_info = await page.evaluate("""() => {
            const blocks = document.querySelectorAll('.tiptap .code-block');
            const samples = [];
            blocks.forEach((b, i) => {
                const lang = b.querySelector('.code-block-lang')?.textContent?.trim();
                const copy = b.querySelector('.code-block-copy');
                const code = b.querySelector('pre code');
                samples.push({
                    i, lang,
                    hasCopy: !!copy,
                    copyText: copy?.textContent?.trim(),
                    codeLang: code?.className?.match(/language-(\\w+)/)?.[1] || null,
                });
            });
            return samples;
        }""")
        print('editor:', editor_info)

        await page.screenshot(path=str(OUT / "p16_editor.png"), full_page=True)

        editor_ok = (
            len(editor_info) >= 2
            and all(b['hasCopy'] and '复制' in b['copyText'] for b in editor_info)
            and all(b['lang'] for b in editor_info)
        )
        print('PASS editor side' if editor_ok else 'FAIL editor side')

        # ── 复制按钮点击测试 ──
        copy_result = await page.evaluate("""async () => {
            const btn = document.querySelector('.tiptap .code-block .code-block-copy');
            if (!btn) return { ok: false, reason: 'no button' };
            const before = btn.textContent?.trim();
            btn.click();
            await new Promise(r => setTimeout(r, 400));
            const after = btn.textContent?.trim();
            const copied = btn.classList.contains('copied');
            await new Promise(r => setTimeout(r, 1500));
            const restored = btn.textContent?.trim();
            return { ok: copied && after.includes('已复制') && restored.includes('复制'), copied, before, after, restored };
        }""")
        print('copy click:', copy_result)

        print('PASS P1.6' if (read_ok and editor_ok and copy_result['ok']) else 'FAIL P1.6')

        await b.close()


asyncio.run(main())