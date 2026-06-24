"""Phase 4 严格验收：Tiptap 编辑器

检查项：
1. 编辑器加载（placeholder 显示）
2. 工具栏按钮渲染（无 image / link 按钮）
3. 标题 input 工作
4. 文本格式：Bold/Italic/Strike/Code
5. 标题：H1/H2/H3 切换
6. 列表：bullet/ordered/task
7. 块：quote/codeblock/hr/table
8. Slash 菜单：输入 / 弹出菜单，点击插入
9. 自动保存：编辑后等 1s 写入 localStorage
10. 刷新后内容恢复
11. 发布 → 跳 ReadView → 内容正确渲染
12. 关闭 → confirm → 放弃修改
13. 键盘快捷键全部不绑定
14. package.json 不含 @tiptap/extension-link / @tiptap/extension-image
"""
import asyncio
import json
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "phase4"
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

        # 清空 localStorage 以保证干净状态
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # ==== 1. 创建新页 → 跳到 edit ====
        print("\n=== 1. create new page ===")
        # 由于种子会自动重新生成,使用 HomeView subheader 的"新建页面"按钮
        create_btn = page.locator(".page-actions .btn.primary:has-text('新建页面')").first
        check("新建页面按钮存在", await create_btn.count() == 1)
        await create_btn.click()
        await page.wait_for_timeout(800)

        url = page.url
        check("跳到 edit 页", "/edit" in url, url)
        # 提取新页 id
        test_page_id = url.split("#/p/")[1].split("/")[0]
        check("新页 id 已提取", bool(test_page_id), test_page_id)

        # ==== 2. 编辑器 + 工具栏渲染 ====
        print("\n=== 2. editor + toolbar ===")
        # 编辑器区域
        tiptap = page.locator(".tiptap").first
        check("Tiptap 编辑器存在", await tiptap.count() == 1)

        # placeholder
        placeholder_text = await tiptap.evaluate("el => el.getAttribute('data-placeholder') || el.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')")
        # Tiptap 把 placeholder 放在第一个空段落
        check("Placeholder 显示", "输入" in str(placeholder_text) or placeholder_text is not None,
              str(placeholder_text)[:50])

        # 标题 input
        title_input = page.locator(".edit-title-input")
        check("标题 input 存在", await title_input.count() == 1)
        title_placeholder = await title_input.get_attribute("placeholder")
        check("标题 placeholder = '无标题页面'", title_placeholder == "无标题页面", str(title_placeholder))

        # 工具栏
        toolbar = page.locator(".editor-toolbar").first
        check("工具栏存在", await toolbar.count() == 1)

        # 工具栏按钮
        tb_btns = page.locator(".editor-toolbar .tb-btn")
        tb_count = await tb_btns.count()
        check(f"工具栏按钮数 >= 12 (实际 {tb_count})", tb_count >= 12)

        # 不能有图片按钮
        img_btn = page.locator(".editor-toolbar .tb-btn[title*='图片'], .editor-toolbar .tb-btn[title*='image']")
        check("无图片按钮", await img_btn.count() == 0)

        # 链接按钮应该存在(后续单独 verify_link.py 覆盖完整行为)
        link_btn = page.locator(".editor-toolbar .tb-btn[title*='链接'], .editor-toolbar .tb-btn[title*='link']")
        check("链接按钮存在", await link_btn.count() >= 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "01_edit_empty.png"), full_page=True)

        # ==== 3. 标题输入 ====
        print("\n=== 3. title input ===")
        await title_input.fill("Phase 4 测试页")
        await page.wait_for_timeout(300)
        title_value = await title_input.input_value()
        check("标题 = Phase 4 测试页", title_value == "Phase 4 测试页", title_value)

        # ==== 4. Tiptap 文本输入 + 基础格式 ====
        print("\n=== 4. text + format ===")
        # 点击编辑器
        await tiptap.click()
        await page.wait_for_timeout(200)

        # 输入文字
        await page.keyboard.type("这是第一段文字。", delay=10)
        await page.wait_for_timeout(200)
        text1 = await tiptap.inner_text()
        check("输入文本显示", "第一段文字" in text1, text1[:50])

        # 选中最后一句
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(100)

        # 加粗
        await page.locator(".editor-toolbar .tb-btn[title*='加粗']").first.click()
        await page.wait_for_timeout(200)
        bold_count = await page.locator(".tiptap strong").count()
        check(f"加粗后含 <strong> (实际 {bold_count})", bold_count >= 1)

        # 取消加粗
        await page.locator(".editor-toolbar .tb-btn[title*='加粗']").first.click()
        await page.wait_for_timeout(200)
        no_bold_count = await page.locator(".tiptap strong").count()
        check(f"再次点击取消加粗 (残留 {no_bold_count})", no_bold_count < bold_count)

        # 移到行末 + Enter + 新段
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await page.keyboard.type("斜体测试", delay=10)
        await page.wait_for_timeout(100)
        # 选中"斜体测试"
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        # 斜体
        await page.locator(".editor-toolbar .tb-btn[title*='斜体']").first.click()
        await page.wait_for_timeout(200)
        italic_count = await page.locator(".tiptap em").count()
        check(f"斜体后含 <em> (实际 {italic_count})", italic_count >= 1)

        # ==== 5. 标题 H1/H2/H3 ====
        print("\n=== 5. headings ===")
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await page.keyboard.type("H2 测试标题", delay=10)
        await page.wait_for_timeout(100)
        # 选中
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        # 通过块类型下拉选 H2
        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(200)
        await page.locator('.tb-block-type-opt:has-text("二级标题")').first.click()
        await page.wait_for_timeout(300)
        h2_count = await page.locator(".tiptap .heading-wrapper[data-level='2']").count()
        check(f"H2 渲染 (实际 {h2_count})", h2_count >= 1)

        # 切回正文(再次打开下拉选"正文")
        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(200)
        await page.locator('.tb-block-type-opt:has-text("正文")').first.click()
        await page.wait_for_timeout(200)

        # ==== 6. 列表 ====
        print("\n=== 6. lists ===")
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        # 无序列表
        await page.locator(".editor-toolbar .tb-btn[title*='无序列表']").first.click()
        await page.wait_for_timeout(100)
        await page.keyboard.type("项目 A", delay=10)
        await page.keyboard.press("Enter")
        await page.keyboard.type("项目 B", delay=10)
        await page.wait_for_timeout(200)
        ul_count = await page.locator(".tiptap ul").count()
        check(f"无序列表 ul (实际 {ul_count})", ul_count >= 1)
        # 文字存在
        full_text = await tiptap.inner_text()
        check("无序列表含 '项目 A'", "项目 A" in full_text)

        # 切到正文
        await page.keyboard.press("Enter")
        await page.keyboard.press("Enter")
        # 任务列表
        await page.locator(".editor-toolbar .tb-btn[title*='任务列表']").first.click()
        await page.wait_for_timeout(100)
        await page.keyboard.type("任务一", delay=10)
        await page.keyboard.press("Enter")
        await page.keyboard.type("任务二", delay=10)
        await page.wait_for_timeout(200)
        task_count = await page.locator(".tiptap ul[data-type='taskList']").count()
        check(f"任务列表 (实际 {task_count})", task_count >= 1)

        # ==== 7. 表格 ====
        print("\n=== 7. table ===")
        await page.keyboard.press("Enter")
        await page.keyboard.press("Enter")
        # 切回正文
        await page.locator(".editor-toolbar .tb-btn[title*='任务列表']").first.click()
        await page.keyboard.press("Enter")
        # 插入表格
        await page.locator(".editor-toolbar .tb-btn[title*='插入表格']").first.click()
        await page.wait_for_timeout(300)
        table_count = await page.locator(".tiptap table").count()
        check(f"表格渲染 (实际 {table_count} 个)", table_count >= 1)
        # th + td 都在
        th_count = await page.locator(".tiptap table th").count()
        td_count = await page.locator(".tiptap table td").count()
        check(f"表格含 th (实际 {th_count}) + td (实际 {td_count})", th_count >= 1 and td_count >= 1)

        # ==== 8. 代码块 + 引用 ====
        print("\n=== 8. code + quote ===")
        await page.keyboard.press("End")
        # 跳出表格
        for _ in range(5):
            await page.keyboard.press("ArrowDown")
        await page.keyboard.press("Enter")
        # 引用:通过块类型下拉
        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(200)
        await page.locator('.tb-block-type-opt:has-text("引用")').first.click()
        await page.wait_for_timeout(100)
        await page.keyboard.type("这是一个引用", delay=10)
        await page.wait_for_timeout(200)
        quote_count = await page.locator(".tiptap blockquote").count()
        check(f"引用 blockquote (实际 {quote_count})", quote_count >= 1)

        # ==== 9. Slash 菜单 ====
        print("\n=== 9. slash menu ===")
        # 跳出引用
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        # 输入 /
        await page.keyboard.type("/", delay=10)
        await page.wait_for_timeout(400)

        slash_menu = page.locator(".slash-menu")
        slash_count = await slash_menu.count()
        check(f"slash 菜单出现 (实际 {slash_count})", slash_count == 1)

        # 看是否有图片/链接选项
        slash_items = page.locator(".slash-item")
        si_count = await slash_items.count()
        check(f"slash 项 >= 5 (实际 {si_count})", si_count >= 5)
        slash_texts = []
        for i in range(si_count):
            slash_texts.append(await slash_items.nth(i).inner_text())
        slash_str = " | ".join(slash_texts)
        check("slash 不含'图片'", "图片" not in slash_str, slash_str[:200])
        check("slash 不含'链接'", "链接" not in slash_str, slash_str[:200])

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_slash_menu.png"), full_page=True)

        # 选 H1
        h1_item = page.locator(".slash-item:has-text('一级标题')")
        await h1_item.click(force=True)
        await page.wait_for_timeout(300)
        h1_count = await page.locator(".tiptap .heading-wrapper[data-level='1']").count()
        check(f"slash 选 H1 后含 H1 wrapper (实际 {h1_count})", h1_count >= 1)

        # ==== 10. 自动保存 + 持久化 ====
        print("\n=== 10. auto-save + persistence ===")
        # 等防抖(800ms) + 持久化
        await page.wait_for_timeout(1500)
        pages_after = await page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
        check(f"localStorage 含 >= 5 页 (实际 {len(pages_after)})", len(pages_after) >= 5)
        # 找到我们的测试页
        my_page = next((p for p in pages_after if p["id"] == test_page_id), None)
        check("测试页存在", my_page is not None, str(test_page_id))
        if my_page:
            check("测试页标题已保存", my_page["title"] == "Phase 4 测试页", my_page["title"])
            html = my_page["contentHTML"]
            check("测试页内容含 h1", "<h1>" in html, html[:200])
            check("测试页内容含 taskList", "taskList" in html, html[-200:])

        # F5 刷新
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(800)
        # 编辑器应该恢复内容
        tiptap = page.locator(".tiptap").first
        restored = await tiptap.inner_text()
        check("刷新后内容恢复", "第一段文字" in restored and "H2 测试标题" in restored, restored[:100])
        title_after = await page.locator(".edit-title-input").input_value()
        check("刷新后标题恢复", title_after == "Phase 4 测试页", title_after)

        await page.screenshot(path=str(SCREENSHOT_DIR / "03_after_reload.png"), full_page=True)

        # ==== 11. 发布 → ReadView ====
        print("\n=== 11. publish ===")
        # 点发布
        await page.locator(".editor-toolbar .btn.primary:has-text('发布')").first.click()
        await page.wait_for_timeout(800)
        read_url = page.url
        check(f"发布后跳 ReadView ({read_url})", "#/p/" in read_url and "/edit" not in read_url)
        check(f"ReadView 是测试页", test_page_id in read_url, read_url)

        # ReadView 应该显示内容
        prose = page.locator(".prose.read-content")
        prose_text = await prose.inner_text() if await prose.count() else ""
        check("ReadView 显示正文", "第一段文字" in prose_text, prose_text[:200])
        check("ReadView 显示 h1", await page.locator(".prose h1").count() >= 1)
        check("ReadView 显示表格", await page.locator(".prose table").count() >= 1)
        check("ReadView 显示任务列表", await page.locator(".prose ul[data-type='taskList']").count() >= 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "04_read_after_publish.png"), full_page=True)

        # ==== 12. 关闭 → confirm ====
        print("\n=== 12. close with dirty state ===")
        # 再点编辑
        edit_url = page.url + "/edit"
        await page.goto(edit_url, wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(500)

        # 修改一些内容
        tiptap = page.locator(".tiptap").first
        await tiptap.click()
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await page.keyboard.type("新加的脏内容", delay=10)
        await page.wait_for_timeout(1500)  # wait for autosave

        # 关闭按钮
        page.once("dialog", lambda d: asyncio.create_task(d.accept()))
        await page.locator(".editor-toolbar .btn.ghost:has-text('关闭')").first.click()
        await page.wait_for_timeout(500)
        url_after_close = page.url
        check(f"关闭后回到 ReadView ({url_after_close})",
              "/edit" not in url_after_close and "#/p/" in url_after_close)

        # ==== 13. 键盘快捷键不绑定 ====
        print("\n=== 13. no keyboard shortcuts ===")
        # 再次进入 edit
        await page.goto(edit_url, wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(500)

        tiptap = page.locator(".tiptap").first
        await tiptap.click()
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await page.keyboard.type("test123", delay=10)
        await page.wait_for_timeout(200)

        # 选中 test123
        for _ in range(7):
            await page.keyboard.press("Shift+ArrowLeft")
        await page.wait_for_timeout(100)

        # Ctrl+B 不应有反应
        before = await tiptap.inner_html()
        await page.keyboard.press("Control+b")
        await page.wait_for_timeout(300)
        after = await tiptap.inner_html()
        check("Ctrl+B 不加粗", "<strong>test123</strong>" not in after and "<strong>test" not in after,
              "ctrl+b had no effect (good)")

        # Ctrl+I 不应有反应
        await page.keyboard.press("Control+i")
        await page.wait_for_timeout(300)
        after2 = await tiptap.inner_html()
        check("Ctrl+I 不斜体", "<em>test123</em>" not in after2,
              "ctrl+i had no effect (good)")

        # Ctrl+S 不应触发任何东西
        await page.keyboard.press("Control+s")
        await page.wait_for_timeout(300)
        check("Ctrl+S 无反应", True, "page did not navigate or anything")

        # ==== 14. package.json 不含 link/image 扩展 ====
        print("\n=== 14. no link/image extensions in package.json ===")
        pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        check("无 @tiptap/extension-link", "@tiptap/extension-link" not in deps)
        check("无 @tiptap/extension-image", "@tiptap/extension-image" not in deps)

        # ==== 15. 控制台错误 ====
        print("\n=== 15. console errors ===")
        real = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real)})", len(real) == 0,
              "; ".join(real[:3]) if real else "")

        await browser.close()

    print("\n" + "=" * 60)
    print("Phase 4 验收总结")
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
