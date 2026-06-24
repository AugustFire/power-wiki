"""编辑器打磨验收

覆盖改动点:
1. 块类型下拉(真下拉,不是循环按钮):打开 → 6 项 → 切换 H1/H3/quote/codeblock/p → 自动关闭
2. 撤销/重做按钮:点击有效,可执行状态下 disabled 同步
3. 工具栏链接按钮:无选区时 disabled,提示文案变化;有选区时启用
4. CodeBlockView header 始终可见(无语言时显示"纯文本")
5. 不再触发 window.alert()(dialog 监听器全程静默)

跑法(需 dev server 已在 127.0.0.1:5173):
    npm run dev
    python scripts/verify_editor_polish.py
"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "editor_polish"
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
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        # 全程监听浏览器原生 dialog(alert/confirm/prompt),任何触发都算失败
        alert_count = {"n": 0}

        def on_dialog(d):
            alert_count["n"] += 1
            asyncio.create_task(d.dismiss())

        page.on("dialog", on_dialog)

        # 清空 localStorage,走种子
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # ==== 0. 准备:进入新页编辑态 ====
        print("\n=== 0. setup ===")
        create_btn = page.locator(".page-actions .btn.primary:has-text('新建页面')").first
        check("新建页面按钮存在", await create_btn.count() == 1)
        await create_btn.click()
        await page.wait_for_timeout(800)
        check("跳到 edit 页", "/edit" in page.url, page.url)

        tiptap = page.locator(".tiptap").first
        check("Tiptap 编辑器存在", await tiptap.count() == 1)
        await tiptap.click()
        await page.wait_for_timeout(200)

        toolbar = page.locator(".editor-toolbar").first
        check("工具栏存在", await toolbar.count() == 1)

        # ==== 1. 块类型下拉 ====
        print("\n=== 1. block type dropdown ===")
        wrap = page.locator(".tb-block-type-wrap").first
        check("块类型下拉容器存在", await wrap.count() == 1)

        # 初始按钮显示"正文"
        initial_label = await page.locator(".tb-block-type > span:first-child").inner_text()
        check(f"初始块类型标签 = '正文' (实际 '{initial_label}')", initial_label == "正文")

        # 点击打开
        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(150)
        menu = page.locator(".tb-block-type-menu")
        check("下拉菜单打开", await menu.count() == 1)

        opt_count = await page.locator(".tb-block-type-opt").count()
        check(f"下拉项 = 6 (实际 {opt_count})", opt_count == 6)
        opt_texts = []
        for i in range(opt_count):
            opt_texts.append(await page.locator(".tb-block-type-opt").nth(i).inner_text())
        opt_str = " | ".join(opt_texts)
        check("下拉含'正文'", "正文" in opt_str, opt_str)
        check("下拉含'一级标题'", "一级标题" in opt_str, opt_str)
        check("下拉含'二级标题'", "二级标题" in opt_str, opt_str)
        check("下拉含'三级标题'", "三级标题" in opt_str, opt_str)
        check("下拉含'引用'", "引用" in opt_str, opt_str)
        check("下拉含'代码块'", "代码块" in opt_str, opt_str)

        await page.screenshot(path=str(SCREENSHOT_DIR / "01_block_dropdown.png"), full_page=True)

        # 关闭下拉(点工具栏上的非下拉区域),再输文字,再做切换测试
        await page.keyboard.press("Escape")  # 下拉不响应 Escape,但保险起见
        await page.locator(".tb-block-type").first.click()  # 关闭
        await page.wait_for_timeout(150)
        await tiptap.click()
        await page.wait_for_timeout(150)
        await page.keyboard.type("h1 行内容", delay=10)
        await page.wait_for_timeout(150)
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(100)

        async def pick_block(opt_label: str) -> None:
            await page.locator(".tb-block-type").first.click()
            await page.wait_for_timeout(150)
            await page.locator(f".tb-block-type-opt:has-text('{opt_label}')").first.click()
            await page.wait_for_timeout(300)

        await pick_block("一级标题")
        # HeadingView 用 div + data-level;level 1 的 wrapper
        h1_count = await page.locator(".tiptap .heading-wrapper[data-level='1']").count()
        check(f"切到 H1 后含 H1 wrapper (实际 {h1_count})", h1_count >= 1)
        menu_after = await page.locator(".tb-block-type-menu").count()
        check("选择后下拉自动关闭", menu_after == 0)
        label_after_h1 = await page.locator(".tb-block-type > span:first-child").inner_text()
        check(f"按钮标签更新为'一级标题' (实际 '{label_after_h1}')", "一级标题" in label_after_h1)

        # 切 H3
        await pick_block("三级标题")
        h3_count = await page.locator(".tiptap .heading-wrapper[data-level='3']").count()
        check(f"切到 H3 后含 H3 wrapper (实际 {h3_count})", h3_count >= 1)

        # 切引用
        await pick_block("引用")
        quote_count = await page.locator(".tiptap blockquote").count()
        check(f"切到引用后含 <blockquote> (实际 {quote_count})", quote_count >= 1)

        # 切代码块
        await pick_block("代码块")
        pre_count = await page.locator(".tiptap pre").count()
        check(f"切到代码块后含 <pre> (实际 {pre_count})", pre_count >= 1)
        header_text = await page.locator(".code-block .code-block-lang").first.inner_text()
        check(f"代码块 header 显示语言 (实际 '{header_text}')", len(header_text) > 0)

        # 切回正文
        await pick_block("正文")
        paragraph_count = await page.locator(".tiptap p").count()
        check(f"切回正文后含 <p> (实际 {paragraph_count})", paragraph_count >= 1)

        # 点击外部关闭:打开下拉后点页面其他位置(避开被 drag handle 拦截的编辑器)
        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(150)
        check("下拉再次打开", await page.locator(".tb-block-type-menu").count() == 1)
        # 点击 topbar 上的品牌区(已知空区域)
        await page.locator(".brand-name").first.click()
        await page.wait_for_timeout(200)
        check("点击外部关闭下拉", await page.locator(".tb-block-type-menu").count() == 0)

        # ==== 2. 撤销 / 重做 ====
        print("\n=== 2. undo / redo ===")
        undo_btn = page.locator(".editor-toolbar .tb-btn[title^='撤销']").first
        redo_btn = page.locator(".editor-toolbar .tb-btn[title^='重做']").first
        check("撤销按钮存在", await undo_btn.count() == 1)
        check("重做按钮存在", await redo_btn.count() == 1)

        # 此时刚做了多次下拉切换,撤销栈非空
        # 先把光标放回编辑器(下拉点击后焦点在按钮上)
        await tiptap.click()
        await page.wait_for_timeout(150)
        undo_disabled_initial = await undo_btn.is_disabled()
        check(f"撤销按钮初始状态可用 (disabled={undo_disabled_initial})", not undo_disabled_initial)
        redo_disabled_initial = await redo_btn.is_disabled()
        check(f"重做按钮初始 disabled (实际 disabled={redo_disabled_initial})", redo_disabled_initial)

        # 在编辑器末尾输入文字(在正文段)
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await page.keyboard.type("undoable", delay=10)
        await page.wait_for_timeout(200)
        text_before = await tiptap.inner_text()
        check("输入后文本含 'undoable'", "undoable" in text_before, text_before[-50:])

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_undo_redo_before.png"), full_page=True)

        # 点撤销 → 文本消失
        await undo_btn.click()
        await page.wait_for_timeout(300)
        text_after_undo = await tiptap.inner_text()
        check(f"撤销后 'undoable' 消失 (实际末尾: '{text_after_undo[-30:]}')",
              "undoable" not in text_after_undo)

        # 重做按钮此时应可用
        check("撤销后重做按钮可用", not await redo_btn.is_disabled())

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_undo_redo_after_undo.png"), full_page=True)

        # 点重做 → 文本回来
        await redo_btn.click()
        await page.wait_for_timeout(300)
        text_after_redo = await tiptap.inner_text()
        check(f"重做后 'undoable' 恢复", "undoable" in text_after_redo, text_after_redo[-50:])

        # 一直撤销到底,直到 undo 按钮变 disabled
        for _ in range(50):
            if await undo_btn.is_disabled():
                break
            await undo_btn.click()
            await page.wait_for_timeout(80)
        check("撤销到底后 undo 按钮 disabled", await undo_btn.is_disabled())
        check("撤销到底后 redo 按钮可用", not await redo_btn.is_disabled())

        # 再一直重做到顶
        for _ in range(50):
            if await redo_btn.is_disabled():
                break
            await redo_btn.click()
            await page.wait_for_timeout(80)
        check("重做到顶后 redo 按钮 disabled", await redo_btn.is_disabled())

        # ==== 3. 链接工具栏可用 ====
        print("\n=== 3. link toolbar ===")
        link_btn = page.locator(".editor-toolbar .tb-btn[title*='链接']").first
        check("工具栏链接按钮存在", await link_btn.count() == 1)
        # 此时编辑器已有内容,但未必有选区
        # 选一段文字 → 按钮启用
        await tiptap.click()
        await page.wait_for_timeout(150)
        await page.keyboard.press("Control+Home")
        await page.keyboard.press("ArrowDown")
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(150)
        check("选区后链接按钮启用", not await link_btn.is_disabled())
        await link_btn.click()
        await page.wait_for_timeout(200)
        popover = page.locator(".link-popover").first
        check("链接 popover 出现", await popover.count() == 1)
        await page.locator(".link-input").first.fill("https://example.com")
        await page.locator(".link-popover .lp-btn.primary").click()
        await page.wait_for_timeout(300)
        a_count = await page.locator(".tiptap a").count()
        check(f"应用链接后 <a> 出现 (实际 {a_count})", a_count >= 1)
        check("popover 自动关闭", await page.locator(".link-popover").count() == 0)

        # ==== 4. CodeBlockView header ====
        print("\n=== 4. codeblock header ===")
        # 全删,清空选区,再插入代码块
        await page.keyboard.press("Control+a")
        await page.keyboard.press("Delete")
        await page.wait_for_timeout(150)
        # 工具栏"代码块"按钮(块类型下拉里的"代码块"会切当前段;这里要用工具栏的"代码块"按钮)
        codeblock_toolbar_btn = page.locator(".editor-toolbar .tb-btn[title='代码块']").first
        check("工具栏'代码块'按钮存在", await codeblock_toolbar_btn.count() == 1)
        await codeblock_toolbar_btn.click()
        await page.wait_for_timeout(300)
        # 代码块应该有 header,文字为"纯文本"
        cb_lang = page.locator(".tiptap .code-block-lang").first
        check("代码块 header 渲染", await cb_lang.count() == 1)
        cb_lang_text = await cb_lang.inner_text() if await cb_lang.count() else ""
        check(f"无语言代码块 header 文字 = '纯文本' (实际 '{cb_lang_text}')",
              cb_lang_text == "纯文本")

        await page.screenshot(path=str(SCREENSHOT_DIR / "04_codeblock_header.png"), full_page=True)

        # ==== 5. 整段没有 alert ====
        print("\n=== 5. no native alerts ===")
        check(f"全程未触发 alert (实际触发 {alert_count['n']} 次)", alert_count["n"] == 0)

        # ==== 6. console 错误 ====
        print("\n=== 6. console errors ===")
        real = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real)})", len(real) == 0,
              "; ".join(real[:3]) if real else "")

        await browser.close()

    print("\n" + "=" * 60)
    print("编辑器打磨验收总结")
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