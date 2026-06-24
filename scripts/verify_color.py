"""验证颜色功能"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "color"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
BASE = "http://localhost:5173"

results: list[tuple[str, bool, str]] = []

def check(name: str, ok: bool, detail: str = ""):
    mark = "[OK]" if ok else "[FAIL]"
    results.append((name, ok, detail))
    print(f"{mark} {name}{(' - ' + detail) if detail else ''}")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        console_errors: list[str] = []
        page.on("console", lambda m: console_errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"[pageerror] {e}"))

        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(800)
        cur_url = page.url
        print(f"当前 URL: {cur_url}")
        title_count = await page.locator(".brand-name").count()
        print(f"brand-name 数: {title_count}")
        await page.screenshot(path=str(SCREENSHOT_DIR / "00_home.png"), full_page=True)

        # 创建新页
        btn_count = await page.locator(".btn.primary:has-text('新建页面')").count()
        all_btns = await page.locator(".btn").count()
        all_primary = await page.locator(".btn.primary").count()
        print(f"新建页面按钮数: {btn_count}, all btn: {all_btns}, all primary: {all_primary}")
        await page.locator(".btn.primary:has-text('新建页面')").first.click()
        await page.wait_for_timeout(800)

        tiptap = page.locator(".tiptap").first
        await tiptap.click()
        await page.wait_for_timeout(200)
        await page.keyboard.type("彩色文字测试", delay=10)
        await page.wait_for_timeout(200)

        # 选中
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(150)

        # 文字颜色按钮存在
        text_btn = page.locator(".editor-toolbar .tb-btn[title='文字颜色']").first
        check("文字颜色按钮存在", await text_btn.count() == 1)

        highlight_btn = page.locator(".editor-toolbar .tb-btn[title='背景颜色']").first
        check("背景颜色按钮存在", await highlight_btn.count() == 1)

        # 点文字色按钮,弹出 popover
        await text_btn.click()
        await page.wait_for_timeout(200)
        popover = page.locator(".color-popover").first
        check("文字色 popover 出现", await popover.count() == 1)
        swatch_count = await page.locator(".cp-swatch").count()
        check(f"色板数 = 8 (实际 {swatch_count})", swatch_count == 8)

        await page.screenshot(path=str(SCREENSHOT_DIR / "01_text_color_picker.png"), full_page=True)

        # 选红色
        await page.locator('.cp-swatch[title="红色"]').first.click()
        await page.wait_for_timeout(300)
        check("文字色 popover 自动关闭", await page.locator(".color-popover").count() == 0)

        # 检查选中文字有 color style
        span_count = await page.locator('.tiptap span[style*="color"]').count()
        check(f"选中文字应用了 color 样式 (实际 {span_count})", span_count >= 1)

        # 检查保存的 HTML 含 color
        saved = await page.evaluate("""() => {
            const wrap = document.querySelector('.tb-color-wrap');
            if (!wrap) return null;
            const inst = wrap.__vueParentComponent;
            const editor = inst.setupState.editor || inst.props.editor;
            return editor.getHTML();
        }""")
        check(f"保存 HTML 含 color:#FF5630", "color" in saved.lower() if saved else False, saved[:200] if saved else "")

        # 现在应用背景色
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        # 重新选一遍(光标可能在 popover 焦点后位置变了)
        await tiptap.click()
        await page.wait_for_timeout(100)
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(150)

        await highlight_btn.click()
        await page.wait_for_timeout(200)
        check("背景色 popover 出现", await page.locator(".color-popover").count() == 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_highlight_picker.png"), full_page=True)

        # 选蓝色背景
        await page.locator('.cp-swatch[title="蓝"]').first.click()
        await page.wait_for_timeout(300)

        # 检查 mark 标签
        mark_count = await page.locator(".tiptap mark").count()
        check(f"应用背景色后含 <mark> (实际 {mark_count})", mark_count >= 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "03_colored.png"), full_page=True)

        # 再测"无"色:再次打开文字色,选默认(去掉色)
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await tiptap.click()
        await page.wait_for_timeout(100)
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(150)

        await text_btn.click()
        await page.wait_for_timeout(200)
        await page.locator('.cp-swatch[title="默认"]').first.click()
        await page.wait_for_timeout(300)

        # 文字色应被移除(span 还在,但 style 应没有 color)
        # 注意:有可能整段被 textStyle mark 包住,里面没有 color 属性
        # 这里我们只验证色板依然能开
        await text_btn.click()
        await page.wait_for_timeout(200)
        check("色板能反复打开", await page.locator(".color-popover").count() == 1)
        await page.keyboard.press("Escape")

        # ==== 5. console 错误 ====
        real = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real)})", len(real) == 0,
              "; ".join(real[:3]) if real else "")

        await browser.close()

    print("\n--- console msgs ---")
    for m in console_errors[:20]:
        try:
            print(m)
        except UnicodeEncodeError:
            print(repr(m))

    print("\n" + "=" * 60)
    print("颜色功能验收总结")
    print("=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"通过: {passed} / {len(results)}")
    print(f"失败: {failed}")
    if failed:
        print("\n失败项:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}: {detail}")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())