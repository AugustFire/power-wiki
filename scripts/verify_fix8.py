"""fix8 验收:拖拽手柄默认隐藏,鼠标进入编辑区才显示

跑法(需 dev server 已在 127.0.0.1:5173):
    npm run dev
    python scripts/verify_fix8.py
"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "fix8"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
BASE = "http://localhost:5173"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    mark = "[OK]" if ok else "[FAIL]"
    results.append((name, ok, detail))
    print(f"{mark} {name}{(' - ' + detail) if detail else ''}")


async def wait_for_fonts(page):
    await page.wait_for_function(
        "document.fonts.check('1em \"Material Symbols Outlined\"')", timeout=10000
    )


async def get_handle_opacity(page) -> float:
    return await page.evaluate(
        """() => {
          const el = document.querySelector('.drag-handle')
          if (!el) return -1
          return parseFloat(getComputedStyle(el).opacity)
        }"""
    )


async def body_has_hover(page) -> bool:
    return await page.evaluate("() => document.body.classList.contains('editor-hover')")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        console_errors: list[str] = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        # 清空 localStorage,走种子
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # 进新建页
        await page.locator(".page-actions .btn.primary:has-text('新建页面')").first.click()
        await page.wait_for_timeout(800)
        check("进入 edit 页", "/edit" in page.url, page.url)

        tiptap = page.locator(".tiptap").first
        await tiptap.click()
        await page.wait_for_timeout(200)

        # ==== 1. 默认状态:鼠标在 topbar/外侧,body 不应有 editor-hover,handle 应隐藏 ====
        print("\n=== 1. default state (mouse outside editor) ===")
        # 鼠标移到 topbar(不是 editor)
        await page.locator(".brand").first.hover()
        await page.wait_for_timeout(200)
        hover_outside = await body_has_hover(page)
        check("鼠标在 topbar 时 body 无 .editor-hover", not hover_outside, str(hover_outside))
        op_outside = await get_handle_opacity(page)
        check(f"鼠标在 topbar 时 handle 隐藏 (实际 opacity={op_outside})", op_outside == 0.0)

        await page.screenshot(path=str(SCREENSHOT_DIR / "01_outside_hidden.png"), full_page=True)

        # ==== 2. 鼠标进入编辑区,handle 应显示 ====
        print("\n=== 2. mouse in editor area ===")
        # 先确认 handle 存在
        handle_count = await page.locator(".drag-handle").count()
        check(".drag-handle 节点存在", handle_count >= 1, f"count={handle_count}")

        # 鼠标移到 tiptap
        await tiptap.hover()
        await page.wait_for_timeout(200)
        hover_inside = await body_has_hover(page)
        check("鼠标在 editor 时 body 有 .editor-hover", hover_inside, str(hover_inside))
        op_inside = await get_handle_opacity(page)
        check(f"鼠标在 editor 时 handle 显示 (实际 opacity={op_inside})", op_inside > 0.5)

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_inside_visible.png"), full_page=True)

        # ==== 3. 鼠标离开编辑区,handle 应重新隐藏 ====
        print("\n=== 3. mouse leaves editor ===")
        await page.locator(".brand").first.hover()
        await page.wait_for_timeout(300)
        hover_after_leave = await body_has_hover(page)
        check("鼠标离开后 body 无 .editor-hover", not hover_after_leave, str(hover_after_leave))
        op_after_leave = await get_handle_opacity(page)
        check(f"鼠标离开后 handle 重新隐藏 (实际 opacity={op_after_leave})", op_after_leave == 0.0)

        # ==== 4. 回到 editor 又可见 ====
        print("\n=== 4. re-enter editor ===")
        await tiptap.hover()
        await page.wait_for_timeout(200)
        op_re = await get_handle_opacity(page)
        check(f"再次进入 editor handle 显示 (实际 opacity={op_re})", op_re > 0.5)

        # ==== 5. handle 仍可拖拽(hover 后 active 状态背景色变) ====
        print("\n=== 5. handle still functional ===")
        # 拖动:模拟 hover handle 看到背景色变化
        handle = page.locator(".drag-handle").first
        await handle.hover()
        await page.wait_for_timeout(200)
        hover_bg = await page.evaluate(
            """() => {
              const el = document.querySelector('.drag-handle')
              if (!el) return null
              return getComputedStyle(el).backgroundColor
            }"""
        )
        check(f"hover handle 背景变化 (实际 {hover_bg})", hover_bg is not None and "rgba(0, 0, 0, 0)" not in hover_bg and "transparent" not in hover_bg.lower())

        # ==== 6. 无 console 错误 ====
        print("\n=== 6. console errors ===")
        real = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real)})", len(real) == 0,
              "; ".join(real[:3]) if real else "")

        await browser.close()

    print("\n" + "=" * 60)
    print("fix8 (拖拽手柄 hover-only) 验收总结")
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
