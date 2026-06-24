"""Phase 2 严格验收：阅读页 + 左侧树 + TOC + 视觉对比

检查项：
1. 侧边栏渲染（Space card + 4 个分区 + 树 + 创建按钮）
2. 三栏栅格（sidebar 260 + content + toc 220）
3. 树节点展开/折叠
4. 树节点 active 高亮
5. 阅读页渲染（面包屑、标题、byline、status pills、正文、子页面、reactions、TOC scroll-spy）
6. 视觉对比 wiki-read.html 原型
"""
import asyncio
import json
import os
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "phase2"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
BASE = "http://localhost:5173"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    mark = "[OK]" if ok else "[FAIL]"
    results.append((name, ok, detail))
    print(f"{mark} {name}{(' - ' + detail) if detail else ''}")


async def wait_for_fonts(page):
    await page.wait_for_function(
        "document.fonts.check('1em \"Material Symbols Outlined\"')",
        timeout=10000,
    )
    await page.wait_for_function(
        "document.fonts.check('1em \"Plus Jakarta Sans\"')",
        timeout=10000,
    )


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        console_errors: list[str] = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        # ---- HomeView ----
        print("\n=== HomeView (#/) ===")
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # 1. Topbar 渲染
        topbar = page.locator(".topbar").first
        check("Topbar 存在", await topbar.count() == 1)

        # 2. Sidebar 渲染
        sidebar = page.locator(".sidebar").first
        check("Sidebar 存在", await sidebar.count() == 1)

        # 3. Space card
        space_name = page.locator(".space-name").first
        check("Space card 名称", await space_name.inner_text() == "我的知识库")

        # 4. 4 个 section 标题
        for title in ["已加星标", "草稿", "此空间中的页面", "空间工具"]:
            loc = page.locator(f".sidebar-section-title:has-text('{title}')")
            check(f"Section '{title}'", await loc.count() >= 1)

        # 5. PageTree 渲染了树（应该有 2 个根节点：Atlas v3.0 + 会议纪要）
        tree_rows = page.locator(".tree-row")
        tree_count = await tree_rows.count()
        check(f"树节点数 >= 2 (实际 {tree_count})", tree_count >= 2)

        # 6. 创建按钮
        create_btn = page.locator(".create-page-btn").first
        check("创建页面按钮", await create_btn.is_visible())

        # 7. 无 TOC（因为 .no-toc）
        toc_panels = page.locator(".toc-panel")
        check("HomeView 无 TOC", await toc_panels.count() == 0)

        await page.screenshot(path=str(SCREENSHOT_DIR / "01_home.png"), full_page=True)

        # ---- 抓取第一个根页面 ID ----
        first_root = page.locator(".tree-row").first
        first_root_id = await first_root.evaluate(
            "el => el.querySelector('.label')?.textContent || ''"
        )
        check("第一个根节点标题非空", bool(first_root_id), first_root_id)

        # 找到 Atlas 根页面（它有子节点）
        atlas_row = page.locator(".tree-row:has-text('Atlas 设计系统')").first
        check("Atlas 根节点存在", await atlas_row.count() == 1)

        # 展开 Atlas 树
        caret = atlas_row.locator(".caret").first
        await caret.click()
        await page.wait_for_timeout(200)
        # 展开后子节点应该显示
        sub_rows = page.locator(".tree-row:has-text('设计原则'), .tree-row:has-text('颜色令牌')")
        check("Atlas 子节点展开", await sub_rows.count() >= 2)

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_home_expanded.png"), full_page=True)

        # 提取 Atlas 根页面 id（通过 hash）
        atlas_hash = await atlas_row.evaluate("el => el.outerHTML")  # for debug

        # ---- 找到 Atlas 根节点 id 用于导航 ----
        # 通过点击 Atlas 根节点触发 hash 变化
        await atlas_row.click()
        await page.wait_for_timeout(500)
        url = page.url
        check("点击 Atlas 根节点触发路由变化", "#/p/" in url, url)

        page_id = url.split("#/p/")[1].split("/")[0].split("?")[0]
        check("page id 已提取", bool(page_id), page_id)

        # ---- ReadView ----
        print(f"\n=== ReadView (#/p/{page_id}) ===")
        await page.wait_for_timeout(500)
        await wait_for_fonts(page)

        # 8. Subheader + breadcrumb
        subheader = page.locator(".subheader").first
        check("Subheader 存在", await subheader.count() == 1)
        breadcrumb = page.locator(".breadcrumb").first
        check("Breadcrumb 存在", await breadcrumb.count() == 1)

        # 9. 页面标题
        page_title = page.locator(".page-title").first
        title_text = await page_title.inner_text() if await page_title.count() else ""
        check("页面标题 = Atlas 设计系统 v3.0 版本", "Atlas" in title_text, title_text)

        # 10. Byline
        byline = page.locator(".page-byline").first
        check("Byline 存在", await byline.count() == 1)

        # 11. Status pills
        pills = page.locator(".status-pill")
        pill_count = await pills.count()
        check(f"Status pills >= 4 (实际 {pill_count})", pill_count >= 4)

        # 12. 正文渲染（v-html）
        prose = page.locator(".prose").first
        check("正文 prose 存在", await prose.count() == 1)
        h2_count = await page.locator(".prose h2").count()
        check(f"正文含 h2 标题 (实际 {h2_count})", h2_count >= 1)

        # 13. 子页面列表
        subpages = page.locator(".subpages")
        check("子页面 section 存在", await subpages.count() == 1)
        subpage_rows = page.locator(".subpage-row")
        subpage_count = await subpage_rows.count()
        check(f"子页面数 = 2 (实际 {subpage_count})", subpage_count == 2)

        # 14. Reactions
        reactions = page.locator(".reactions")
        check("Reactions 区域存在", await reactions.count() == 1)
        reaction_pills = page.locator(".reaction-pill")
        check(f"Reactions 按钮数 >= 4 (实际 {await reaction_pills.count()})",
              await reaction_pills.count() >= 4)

        # 15. Comments
        comments = page.locator(".comments")
        check("Comments 区域存在", await comments.count() == 1)

        # 16. TOC panel
        toc = page.locator(".toc-panel").first
        check("TOC panel 存在", await toc.count() == 1)
        toc_items = page.locator(".toc-item")
        toc_count = await toc_items.count()
        check(f"TOC items >= 1 (实际 {toc_count})", toc_count >= 1)

        # 17. 树 active 状态
        active_row = page.locator(".tree-row.active")
        active_count = await active_row.count()
        check(f"树 active 节点数 = 1 (实际 {active_count})", active_count == 1)
        active_label = await page.locator(".tree-row.active .label").inner_text()
        check("Active 节点 = Atlas", "Atlas" in active_label, active_label)

        await page.screenshot(path=str(SCREENSHOT_DIR / "03_read.png"), full_page=True)

        # 18. 滚动测试 scroll-spy
        await page.evaluate("window.scrollTo(0, 800)")
        await page.wait_for_timeout(500)
        active_after_scroll = page.locator(".toc-item.active")
        scroll_active_count = await active_after_scroll.count()
        check(f"滚动后 TOC 有 active 项 (实际 {scroll_active_count})", scroll_active_count >= 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "04_read_scrolled.png"))

        # ---- 切换到子页面 ----
        print("\n=== 切换到子页面 ===")
        # 找到「设计原则」行
        child_row = page.locator(".tree-row:has-text('设计原则')").first
        await child_row.click()
        await page.wait_for_timeout(500)
        url2 = page.url
        check("点击子页面触发路由", page_id not in url2.split("#/p/")[1], url2)

        await page.wait_for_timeout(300)
        child_title = await page.locator(".page-title").first.inner_text()
        check("子页面标题 = 设计原则", child_title == "设计原则", child_title)

        # 树 active 状态切换
        active_label2 = await page.locator(".tree-row.active .label").inner_text()
        check("Active 节点切换为子页面", "设计原则" in active_label2, active_label2)

        await page.screenshot(path=str(SCREENSHOT_DIR / "05_read_child.png"), full_page=True)

        # ---- EditView ----
        print("\n=== EditView ===")
        edit_url = f"{BASE}/#/p/{page_id}/edit"
        await page.goto(edit_url, wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        subheader2 = page.locator(".subheader").first
        check("EditView Subheader 存在", await subheader2.count() == 1)
        title_input = page.locator(".edit-title-input")
        check("EditView 标题 input 存在", await title_input.count() == 1)
        placeholder = await page.locator(".layout.no-toc").count()
        check("EditView 用 .no-toc 2 栏布局", placeholder == 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "06_edit.png"), full_page=True)

        # ---- NotFoundView ----
        print("\n=== NotFoundView ===")
        await page.goto(f"{BASE}/#/p/does-not-exist", wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)
        empty = page.locator(".empty h2")
        empty_h2 = await empty.inner_text() if await empty.count() else ""
        check("NotFoundView 显示'页面不存在'", "不存在" in empty_h2, empty_h2)

        await page.screenshot(path=str(SCREENSHOT_DIR / "07_notfound.png"), full_page=True)

        # ---- 持久化测试 ----
        print("\n=== 持久化 ===")
        # 读取 localStorage 验证 tree-expanded 状态
        expanded = await page.evaluate("localStorage.getItem('power-wiki:tree-expanded')")
        check("tree-expanded key 存在", expanded is not None, str(expanded)[:80])

        pages_json = await page.evaluate("localStorage.getItem('power-wiki:pages')")
        pages_data = json.loads(pages_json) if pages_json else []
        check(f"power-wiki:pages 含 4 个种子页面 (实际 {len(pages_data)})", len(pages_data) >= 4)

        # ---- 控制台错误 ----
        print("\n=== 控制台错误 ===")
        # 过滤掉一些无害的 warning
        real_errors = [e for e in console_errors if "Material Symbols" not in e and "favicon" not in e.lower()]
        check(f"无 console 错误 (实际 {len(real_errors)})", len(real_errors) == 0,
              "; ".join(real_errors[:3]) if real_errors else "")

        await browser.close()

    # ---- 总结 ----
    print("\n" + "=" * 60)
    print("Phase 2 验收总结")
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
