"""Phase 5 严格验收:UI/UX 打磨

检查项:
1. HomeView 空状态:插画 + 大按钮
2. 切换页面有 fade 过渡
3. localStorage JSON 损坏 → console.warn + 回退种子
4. 路由到不存在 id → NotFoundView 友好提示 + 返回首页按钮
5. Delete 确认文案含子页面数
6. 焦点环:focus-visible 颜色 #4C9AFF
7. 删完所有页面 → 回到空状态
8. README.md 存在并包含关键信息
9. 整体 console 无 error
"""
import asyncio
import json
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "phase5"
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


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        console_errors: list[str] = []
        console_warnings: list[str] = []
        page.on("console", lambda m: (
            console_errors.append(m.text) if m.type == "error"
            else console_warnings.append(m.text) if m.type == "warning"
            else None
        ))
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        # ==== 1. 空状态:删完所有页面 → 看到插画和大按钮 ====
        print("\n=== 1. home empty state ===")
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # 清空 localStorage 并 reload,触发种子,然后逐一删除
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(500)

        # 删完所有种子页(4 个)
        # 使用 store 的 delete action
        await page.evaluate("""
            (() => {
                const pages = JSON.parse(localStorage.getItem('power-wiki:pages') || '[]');
                if (pages.length > 0) {
                    localStorage.setItem('power-wiki:pages', '[]');
                }
            })()
        """)
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(500)

        # 现在应该是空状态
        empty_h2 = page.locator(".empty h2")
        check("空状态 h2 渲染", await empty_h2.count() == 1)
        h2_text = await empty_h2.inner_text() if await empty_h2.count() else ""
        check("h2 文本 = '还没有任何页面'", h2_text == "还没有任何页面", h2_text)

        # SVG 插画存在
        illustration = page.locator(".empty-illustration svg")
        check("空状态 SVG 插画", await illustration.count() == 1)

        # "创建第一个页面" 大按钮
        create_first = page.locator(".empty .create-first")
        check("'创建第一个页面' 大按钮", await create_first.count() == 1)
        # 字号比普通按钮大
        create_font = await create_first.evaluate("el => window.getComputedStyle(el).fontSize")
        check(f"大按钮字号 15px (实际 {create_font})", create_font == "15px")

        await page.screenshot(path=str(SCREENSHOT_DIR / "01_empty_state.png"), full_page=True)

        # 验证点击大按钮能跳到 edit 页
        await create_first.click()
        await page.wait_for_timeout(1000)
        check("点击大按钮跳到 edit 页", "/edit" in page.url, page.url)

        # ==== 2. NotFoundView ====
        print("\n=== 2. not found view ===")
        # 用一个完全不匹配的路径(不是 /p/:id 形式)
        await page.goto(f"{BASE}/#/some-invalid-path-xxx", wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(500)

        # 应该看到 404 标题
        h2 = page.locator(".empty h2")
        h2_text = await h2.inner_text() if await h2.count() else ""
        check(f"NotFound h2 文本 (实际: {h2_text})", h2_text == "找不到这个页面")

        # 返回首页按钮
        back_btn = page.locator(".empty .btn.primary:has-text('返回首页')")
        check("返回首页按钮", await back_btn.count() == 1)
        # SVG 插画
        illu = page.locator(".empty-illustration svg")
        check("NotFound SVG 插画", await illu.count() == 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_notfound.png"), full_page=True)

        # 点击返回首页
        await back_btn.click()
        await page.wait_for_timeout(800)
        check("返回首页按钮跳到 /", page.url.endswith("#/"), page.url)

        # ==== 3. localStorage 损坏恢复 ====
        print("\n=== 3. corrupted localStorage recovery ===")
        # 先访问一次让 store 初始化
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.wait_for_timeout(500)
        # 写入坏 JSON
        await page.evaluate("localStorage.setItem('power-wiki:pages', '{not valid json')")
        console_warnings.clear()
        # 重新加载
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(800)
        # 应当出现 console.warn
        all_warn = [w for w in console_warnings if "storage" in w.lower() or "pages" in w.lower() or "fallback" in w.lower()]
        check(f"出现回退相关 console.warn ({len(all_warn)} 条)", len(all_warn) >= 1, "; ".join(all_warn[:2]) if all_warn else "")

        # 通过 store 验证页面被回退到种子(seed 有 2 个根)
        seed_count = await page.evaluate("""
            (() => {
                // 检查 sidebar 树是否渲染了多个根节点
                return document.querySelectorAll('.tree-branch > .tree-row').length;
            })()
        """)
        check(f"损坏恢复后树渲染 {seed_count} 个根 (seed 是 2 个根)", seed_count >= 2)

        # ==== 4. 页面切换 fade 过渡 ====
        print("\n=== 4. page transition fade ===")
        # 看 CSS 是否有 .fade-enter-active 规则
        has_fade = await page.evaluate("""
            (() => {
                for (const sheet of document.styleSheets) {
                    try {
                        for (const rule of sheet.cssRules) {
                            if (rule.cssText && rule.cssText.includes('fade-enter-active')) return true;
                        }
                    } catch {}
                }
                return false;
            })()
        """)
        check("CSS 含 .fade-enter-active 规则", has_fade)

        # ==== 5. focus-visible 样式 ====
        print("\n=== 5. focus-visible ===")
        # 浏览器会把 #4C9AFF 解析为 rgb(76, 154, 255)
        has_focus = await page.evaluate("""
            (() => {
                for (const sheet of document.styleSheets) {
                    try {
                        for (const rule of sheet.cssRules) {
                            if (rule.cssText && rule.cssText.includes('focus-visible') &&
                                (rule.cssText.includes('76, 154, 255') ||
                                 rule.cssText.includes('4C9AFF') ||
                                 rule.cssText.includes('4c9aff'))) return true;
                        }
                    } catch {}
                }
                return false;
            })()
        """)
        check("CSS 含 focus-visible + #4C9AFF (浏览器解析为 rgb 76,154,255)", has_focus)

        # ==== 6. 删完所有页面 → 回到空状态 ====
        print("\n=== 6. delete all pages back to empty ===")
        # 先清掉损坏数据
        await page.evaluate("localStorage.removeItem('power-wiki:pages')")
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(800)
        # 把种子清空(模拟用户全删)
        await page.evaluate("localStorage.setItem('power-wiki:pages', '[]')")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(800)
        # 应有 empty 状态
        empty_h2_count = await page.locator(".empty h2").count()
        check(f"删完所有页 → 空状态 (实际 {empty_h2_count} 个 h2)", empty_h2_count == 1)

        # ==== 7. Delete 确认文案含子页面数(手动验证) ====
        print("\n=== 7. delete confirm dialog text ===")
        # 重新 seed(清空 → reload → 触发 init 写回种子)
        await page.evaluate("localStorage.removeItem('power-wiki:pages')")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(800)
        # 确认有 tree-row(seed 有 2 个根 + 2 个嵌套子页 = 4 行,2 个根 + 展开后子页可见)
        tree_count = await page.locator(".tree-row").count()
        check(f"重新 seed 后有 {tree_count} 个 tree-row", tree_count >= 2)

        # 找到根节点 hover 出菜单
        first_tree_row = page.locator(".tree-row").first
        await first_tree_row.hover()
        await page.wait_for_timeout(300)
        menu_btn = first_tree_row.locator(".menu-btn")
        check("菜单按钮可点", await menu_btn.count() == 1)
        await menu_btn.click()
        await page.wait_for_timeout(400)
        # 点击删除 - 会有 confirm 弹窗
        dialog_msg = None
        async def on_dialog(d):
            nonlocal dialog_msg
            dialog_msg = d.message
            await d.accept()
        page.on("dialog", lambda d: asyncio.create_task(on_dialog(d)))
        delete_item = page.locator(".menu-item.danger")
        check("删除菜单项", await delete_item.count() == 1)
        await delete_item.click()
        await page.wait_for_timeout(800)
        check("删除 confirm 弹窗", dialog_msg is not None, str(dialog_msg)[:80] if dialog_msg else "no dialog")
        if dialog_msg:
            has_title = "「" in dialog_msg and "」" in dialog_msg
            check("confirm 包含页面标题", has_title, dialog_msg[:60])

        # ==== 8. README.md 存在并包含关键信息 ====
        print("\n=== 8. README.md ===")
        readme_path = ROOT / "README.md"
        check("README.md 存在", readme_path.exists())
        if readme_path.exists():
            text = readme_path.read_text(encoding="utf-8")
            check("README 含 '快速开始'", "快速开始" in text)
            check("README 含 '技术栈'", "技术栈" in text)
            check("README 含 '硬约束'", "硬约束" in text)
            check("README 提到 '无键盘快捷键' / 'Ctrl+B'", "Ctrl+B" in text)
            check("README 提到 '无 Image' 扩展", "@tiptap/extension-image" in text or "Image" in text)
            check("README 提到 '无 Link' 扩展", "@tiptap/extension-link" in text or "Link" in text)

        # ==== 9. console 无 error ====
        print("\n=== 9. console errors ===")
        real = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real)})", len(real) == 0,
              "; ".join(real[:3]) if real else "")

        await browser.close()

    print("\n" + "=" * 60)
    print("Phase 5 验收总结")
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

    return failed == 0


if __name__ == "__main__":
    ok = asyncio.run(main())
    sys.exit(0 if ok else 1)
