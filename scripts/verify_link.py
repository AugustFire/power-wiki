"""验证链接功能

1. 工具栏 link 按钮存在,无选区 + 非链接上时 disabled
2. 选中文本 → link 按钮启用 → 点击 → popover 出现 → 输入 URL → 应用 → <a> 标签生成
3. 光标在已有链接上 → link 按钮 active + enabled → popover 预填当前 URL → 应用修改 → URL 更新
4. 在链接上 → popover 显示"移除链接"按钮 → 点移除 → <a> 变纯文本
5. ReadView 上链接 target=_blank rel=noopener noreferrer
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SHOTS = ROOT / "screenshots" / "link"
SHOTS.mkdir(parents=True, exist_ok=True)
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

        alert_count = {"n": 0}
        page.on("dialog", lambda d: (alert_count.__setitem__("n", alert_count["n"] + 1), asyncio.create_task(d.dismiss())))

        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # 进编辑
        await page.locator(".page-actions .btn.primary:has-text('新建页面')").first.click()
        await page.wait_for_timeout(800)

        tiptap = page.locator(".tiptap").first
        await tiptap.click()
        await page.wait_for_timeout(150)

        # ==== 1. link 按钮存在 + 初始 disabled ====
        link_btn = page.locator(".editor-toolbar .tb-btn[title*='链接']").first
        check("工具栏 link 按钮存在", await link_btn.count() == 1)
        check("初始 disabled", await link_btn.is_disabled())
        initial_title = await link_btn.get_attribute("title")
        check(f"初始 title 含 '请先选中文本' (实际 '{initial_title}')",
              initial_title and "请先选中文本" in initial_title)

        # ==== 2. 选中文本 → 启用 → 应用链接 ====
        await page.keyboard.type("atlas 设计系统", delay=10)
        await page.wait_for_timeout(150)
        # 选整段
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(200)

        check("选区后 link 按钮启用", not await link_btn.is_disabled())

        await link_btn.click()
        await page.wait_for_timeout(200)

        popover = page.locator(".link-popover").first
        check("popover 出现", await popover.count() == 1)

        await page.screenshot(path=str(SHOTS / "01_popover_open.png"), full_page=False)

        # 输入 URL 并应用
        url_input = page.locator(".link-input").first
        await url_input.fill("atlassian.com/design")
        await page.locator(".link-popover .lp-btn.primary").click()
        await page.wait_for_timeout(300)

        # 验证 <a> 标签
        a_count = await page.locator(".tiptap a").count()
        check(f"编辑器含 <a> 标签 (实际 {a_count})", a_count >= 1)
        a_href = await page.locator(".tiptap a").first.get_attribute("href")
        check(f"<a> href 自动补 https:// (实际 '{a_href}')", a_href == "https://atlassian.com/design")

        # popover 自动关闭
        check("popover 自动关闭", await page.locator(".link-popover").count() == 0)

        # ==== 3. 光标在链接上 → active 状态 + 预填当前 href ====
        await page.keyboard.press("End")
        await page.wait_for_timeout(150)
        link_btn2 = page.locator(".editor-toolbar .tb-btn[title='链接']").first
        is_active = await link_btn2.evaluate("el => el.classList.contains('active')")
        check("链接上时按钮 active", is_active)
        check("链接上时按钮启用", not await link_btn2.is_disabled())

        await link_btn2.click()
        await page.wait_for_timeout(200)
        url_input2 = page.locator(".link-input").first
        current = await url_input2.input_value()
        check(f"popover 预填当前 URL (实际 '{current}')", current == "https://atlassian.com/design")

        await page.screenshot(path=str(SHOTS / "02_popover_edit_existing.png"), full_page=False)

        # 改成新 URL
        await url_input2.fill("")
        await url_input2.type("https://example.com/docs", delay=10)
        await page.locator(".link-popover .lp-btn.primary").click()
        await page.wait_for_timeout(300)

        new_href = await page.locator(".tiptap a").first.get_attribute("href")
        check(f"修改后 href 更新 (实际 '{new_href}')", new_href == "https://example.com/docs")

        # ==== 4. 移除链接 ====
        await page.keyboard.press("End")
        await page.wait_for_timeout(150)
        link_btn3 = page.locator(".editor-toolbar .tb-btn[title='链接']").first
        await link_btn3.click()
        await page.wait_for_timeout(200)
        remove_btn = page.locator(".link-popover .lp-btn.danger").first
        check("已链接时 popover 显示'移除链接'按钮", await remove_btn.count() == 1)
        await remove_btn.click()
        await page.wait_for_timeout(300)

        a_after_remove = await page.locator(".tiptap a").count()
        check(f"移除后 <a> 标签消失 (实际 {a_after_remove})", a_after_remove == 0)
        plain_text = await tiptap.inner_text()
        check("移除后文本保留", "atlas 设计系统" in plain_text)

        # ==== 5. 发布 + 阅读视图链接硬化 ====
        # 重新插入链接
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(150)
        link_btn4 = page.locator(".editor-toolbar .tb-btn[title='链接']").first
        await link_btn4.click()
        await page.wait_for_timeout(200)
        await page.locator(".link-input").first.fill("https://power-wiki.dev/handbook")
        await page.locator(".link-popover .lp-btn.primary").click()
        await page.wait_for_timeout(300)

        # 发布
        # 编辑器有 800ms 防抖存 HTML,这里等够再点发布
        await page.wait_for_timeout(1000)
        await page.locator(".editor-toolbar .tb-action.primary, .editor-toolbar button.primary").first.click()
        await page.wait_for_timeout(800)

        # 跳到阅读视图
        if "/edit" in page.url:
            # 点"发布"按钮(底部那个)
            await page.locator("button:has-text('发布')").last.click()
            await page.wait_for_timeout(800)

        # 检查 url
        print(f"当前 URL: {page.url}")
        read_a = page.locator(".read-content a[href*='power-wiki.dev']")
        check("阅读视图含目标链接", await read_a.count() >= 1)
        if await read_a.count() >= 1:
            tgt = await read_a.first.get_attribute("target")
            rel = await read_a.first.get_attribute("rel")
            check(f"阅读视图链接 target='_blank' (实际 '{tgt}')", tgt == "_blank")
            check(f"阅读视图链接 rel 含 noopener noreferrer (实际 '{rel}')",
                  rel and "noopener" in rel and "noreferrer" in rel)

        await page.screenshot(path=str(SHOTS / "03_read_view_link.png"), full_page=True)

        # ==== 6. 没有 alert + console 干净 ====
        check(f"全程未触发 alert (实际 {alert_count['n']})", alert_count["n"] == 0)
        real = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real)})", len(real) == 0, "; ".join(real[:3]) if real else "")

        await browser.close()

    print("\n" + "=" * 60)
    print(f"链接功能验收: {sum(1 for _, ok, _ in results if ok)} / {len(results)} 通过")
    if any(not ok for _, ok, _ in results):
        print("\n失败:")
        for n, ok, d in results:
            if not ok:
                print(f"  - {n}: {d}")


if __name__ == "__main__":
    asyncio.run(main())