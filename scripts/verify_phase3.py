"""Phase 3 严格验收：侧边栏交互（创建/删除/重命名）

检查项：
1. 树节点 hover 显示 ⋯ 按钮
2. 点击 ⋯ 弹出菜单（3 项：添加子页面/重命名/删除）
3. 点击外部关闭菜单
4. 添加子页面 → 路由到 edit 页 → localStorage 新增页面
5. 重命名 → inline input → Enter 提交 → 树标题更新
6. 重命名 → Escape 取消
7. 删除 → confirm → 节点消失
8. 删除当前页 → 跳回 home
9. 删除含子页面的节点 → 子页面也被删
10. 空状态：删完所有页后 HomeView 显示插画
11. 持久化：刷新后所有改动保留
"""
import asyncio
import json
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "phase3"
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


async def setup_dialog_handler(page, action="accept"):
    """对 confirm() 自动 accept/dismiss。"""
    if action == "accept":
        page.once("dialog", lambda d: asyncio.create_task(d.accept()))
    else:
        page.once("dialog", lambda d: asyncio.create_task(d.dismiss()))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        console_errors: list[str] = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        # 先清空 localStorage 以保证干净的种子数据
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # ==== 1. 树节点 hover 显示 菜单按钮 ====
        print("\n=== 1. tree row hover shows menu button ===")
        atlas_row = page.locator(".tree-row:has-text('Atlas 设计系统')").first
        check("Atlas 根节点存在", await atlas_row.count() == 1)

        # 菜单按钮初始 opacity:0,需要 hover 才显示
        menu_btn = atlas_row.locator(".menu-btn").first
        check("menu button 存在", await menu_btn.count() == 1)

        # hover 触发显示
        await atlas_row.hover()
        await page.wait_for_timeout(150)
        opacity = await menu_btn.evaluate("el => getComputedStyle(el).opacity")
        check(f"hover 后 menu button opacity=1 (实际 {opacity})", float(opacity) > 0.9)

        await page.screenshot(path=str(SCREENSHOT_DIR / "01_row_hover.png"))

        # ==== 2. 点击 菜单按钮 弹出菜单 ====
        print("\n=== 2. menu opens ===")
        await menu_btn.click()
        await page.wait_for_timeout(200)

        # 菜单出现
        menu = page.locator(".menu").first
        check("菜单存在", await menu.count() == 1)

        # 菜单有 3 个 menu-item
        menu_items = page.locator(".menu .menu-item")
        mi_count = await menu_items.count()
        check(f"菜单项 = 3 (实际 {mi_count})", mi_count == 3)

        # 菜单文字正确
        add_text = await page.locator(".menu .menu-item").nth(0).inner_text()
        rename_text = await page.locator(".menu .menu-item").nth(1).inner_text()
        del_text = await page.locator(".menu .menu-item").nth(2).inner_text()
        check("'add child' item", "子页面" in add_text, add_text)
        check("'rename' item", "重命名" in rename_text, rename_text)
        check("'delete' item", "删除" in del_text, del_text)
        # 危险项 class
        del_item = page.locator(".menu .menu-item.danger")
        check("delete item has .danger class", await del_item.count() == 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_menu_open.png"))

        # ==== 3. 点击外部关闭菜单 ====
        print("\n=== 3. click outside closes ===")
        # 点击 backdrop(它会拦截并关闭菜单)
        await page.locator(".menu-backdrop").first.click()
        await page.wait_for_timeout(200)
        menu_count_after = await page.locator(".menu").count()
        check(f"click backdrop 后菜单消失 (实际 {menu_count_after})", menu_count_after == 0)

        # ==== 4. 添加子页面 ====
        print("\n=== 4. 添加子页面 ===")
        # 记录添加前的页面数
        pages_before = await page.evaluate(
            "JSON.parse(localStorage.getItem('power-wiki:pages') || '[]').length"
        )

        # hover Atlas → 点 ⋯ → 点"在下方添加子页面"
        await atlas_row.hover()
        await page.wait_for_timeout(100)
        await atlas_row.locator(".menu-btn").click()
        await page.wait_for_timeout(200)
        await page.locator(".menu .menu-item").nth(0).click()
        await page.wait_for_timeout(500)

        # 路由到 /p/<新id>/edit
        url = page.url
        check("添加子页后跳到 edit", "/edit" in url, url)

        # localStorage 新增
        pages_after = await page.evaluate(
            "JSON.parse(localStorage.getItem('power-wiki:pages') || '[]').length"
        )
        check(f"localStorage pages 从 {pages_before} → {pages_after}", pages_after == pages_before + 1)

        # 新页 parentId 应该是 Atlas 的 id
        atlas_id = await atlas_row.evaluate(
            "el => el.querySelector('.label')?.textContent"
        )
        new_pages = await page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
        latest = max(new_pages, key=lambda p: p["createdAt"])
        check(f"新页 parentId 指向 Atlas 根 (id={latest['parentId']})",
              any(p["title"] == "Atlas 设计系统 v3.0 版本" and p["id"] == latest["parentId"] for p in new_pages),
              str(latest.get("parentId")))

        await page.screenshot(path=str(SCREENSHOT_DIR / "03_after_add_child.png"), full_page=True)

        # ==== 5. 重命名 ====
        print("\n=== 5. rename ===")
        # 回到 home
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # hover Atlas → 点 ⋯ → 重命名
        atlas_row = page.locator(".tree-row:has-text('Atlas 设计系统')").first
        await atlas_row.hover()
        await page.wait_for_timeout(100)
        await atlas_row.locator(".menu-btn").click()
        await page.wait_for_timeout(300)

        # 在 rename 之前用 nth(0) 抓 row handle,之后用 .rename-input 抓
        await page.locator(".menu .menu-item").nth(1).click()
        await page.wait_for_timeout(300)

        rename_input = page.locator(".rename-input").first
        ri_count = await rename_input.count()
        check("重命名 input 出现", ri_count == 1)
        if ri_count == 1:
            is_focused = await rename_input.evaluate("el => el === document.activeElement")
            check("重命名 input 自动 focus", is_focused)

        await page.screenshot(path=str(SCREENSHOT_DIR / "04_renaming.png"))

        # 清空 + 输入新名 + Enter
        await rename_input.fill("Atlas 设计系统 v4.0 版本")
        await rename_input.press("Enter")
        await page.wait_for_timeout(300)

        # 树标题更新
        new_title_row = page.locator(".tree-row:has-text('v4.0')")
        check("树标题已更新为 v4.0", await new_title_row.count() == 1)

        # localStorage 更新
        updated_pages = await page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
        renamed = [p for p in updated_pages if "v4.0" in p["title"]]
        check("localStorage 中新名持久化", len(renamed) == 1)

        # ==== 5b. Escape 取消重命名 ====
        print("\n=== 5b. Escape cancel ===")
        atlas_row = page.locator(".tree-row:has-text('Atlas 设计系统')").first
        await atlas_row.hover()
        await page.wait_for_timeout(100)
        await atlas_row.locator(".menu-btn").click()
        await page.wait_for_timeout(200)
        await page.locator(".menu .menu-item").nth(1).click()
        await page.wait_for_timeout(300)
        rename_input2 = page.locator(".rename-input").first
        await rename_input2.fill("这个改名应该被取消")
        await rename_input2.press("Escape")
        await page.wait_for_timeout(200)
        # 标题不应该变成 "这个改名应该被取消"
        cancelled = page.locator(".tree-row:has-text('这个改名应该被取消')")
        check("Escape 取消重命名", await cancelled.count() == 0)

        # ==== 6. 删除 ====
        print("\n=== 6. 删除 ===")
        # 删 Atlas(它有子页面)
        await atlas_row.hover()
        await page.wait_for_timeout(100)

        # 自动 accept confirm
        page.once("dialog", lambda d: asyncio.create_task(d.accept()))
        await atlas_row.locator(".menu-btn").click()
        await page.wait_for_timeout(200)
        await page.locator(".menu .menu-item.danger").click()
        await page.wait_for_timeout(500)

        # Atlas 节点消失
        atlas_after = page.locator(".tree-row:has-text('Atlas')")
        check("Atlas 节点消失", await atlas_after.count() == 0)

        # 子页面（设计原则/颜色令牌）也被删
        child1 = page.locator(".tree-row:has-text('设计原则')")
        child2 = page.locator(".tree-row:has-text('颜色令牌')")
        check("设计原则子页也被删", await child1.count() == 0)
        check("颜色令牌子页也被删", await child2.count() == 0)

        # localStorage 验证
        pages_after_del = await page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
        atlas_count = sum(1 for p in pages_after_del if "Atlas" in p["title"])
        child1_count = sum(1 for p in pages_after_del if "设计原则" in p["title"])
        child2_count = sum(1 for p in pages_after_del if "颜色令牌" in p["title"])
        check(f"localStorage 中 Atlas 全部清理 (残留 {atlas_count})", atlas_count == 0)
        check(f"localStorage 中子页面全部清理 (残留 {child1_count + child2_count})",
              child1_count == 0 and child2_count == 0)

        await page.screenshot(path=str(SCREENSHOT_DIR / "05_after_delete.png"), full_page=True)

        # ==== 7. 删除当前正在查看的页 → 跳回 home ====
        print("\n=== 7. 删除当前页 ===")
        # 找到"会议纪要" id
        meeting_row = page.locator(".tree-row:has-text('会议纪要')").first
        meeting_id_text = await meeting_row.inner_text()
        check("会议纪要节点存在", "会议纪要" in meeting_id_text)

        # 点击进入会议纪要
        await meeting_row.click()
        await page.wait_for_timeout(400)
        url_before = page.url
        check("进入会议纪要", "#/p/" in url_before, url_before)

        # hover + ⋯ + 删除
        await meeting_row.hover()
        await page.wait_for_timeout(100)
        page.once("dialog", lambda d: asyncio.create_task(d.accept()))
        await meeting_row.locator(".menu-btn").click()
        await page.wait_for_timeout(200)
        await page.locator(".menu .menu-item.danger").click()
        await page.wait_for_timeout(500)

        url_after = page.url
        check(f"删除当前页后跳回首页 ({url_after})", url_after.endswith("#/"))

        # ==== 8. 空状态 ====
        print("\n=== 8. 空状态 ===")
        # 此时应只剩... 啥都没了（前面 Atlas+子页已删, 会议纪要刚删）
        # 刷新一下
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        # tree rows 应该为 0
        all_rows = await page.locator(".tree-row").count()
        check(f"树清空 (剩余 {all_rows} 个)", all_rows == 0)

        # HomeView 显示空状态
        empty_h2 = page.locator(".empty h2")
        check("HomeView 空状态显示", await empty_h2.count() == 1)
        empty_text = await empty_h2.inner_text() if await empty_h2.count() else ""
        check("空状态文案 = '还没有任何页面'", "还没有" in empty_text, empty_text)
        create_btn = page.locator(".empty .btn.primary")
        check("空状态下有创建按钮", await create_btn.count() == 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "06_empty_state.png"), full_page=True)

        # ==== 9. 持久化（不依赖刷新）====
        print("\n=== 9. 持久化跨刷新 ===")
        # 创建 3 个嵌套页
        await create_btn.click()
        await page.wait_for_timeout(500)
        # 此时在 /p/<newid>/edit
        # 跳回 home
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.wait_for_timeout(300)

        # hover 第一个 → 添加子页
        first_row = page.locator(".tree-row").first
        await first_row.hover()
        await page.wait_for_timeout(100)
        await first_row.locator(".menu-btn").click()
        await page.wait_for_timeout(200)
        await page.locator(".menu .menu-item").nth(0).click()
        await page.wait_for_timeout(500)

        # 再回到 home,在新子页下再添加一个
        # (addChild 已自动 expand 父节点, 所以子页 B 应该可见)
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.wait_for_timeout(300)
        # hover 子节点 → 添加
        child_row = page.locator(".tree-children .tree-row").first
        await child_row.hover()
        await page.wait_for_timeout(100)
        await child_row.locator(".menu-btn").click()
        await page.wait_for_timeout(200)
        await page.locator(".menu .menu-item").nth(0).click()
        await page.wait_for_timeout(500)

        # 检查：localStorage 应有 3 个页面
        pages_now = await page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
        check(f"嵌套创建后 localStorage = 3 页 (实际 {len(pages_now)})", len(pages_now) == 3)

        # 刷新看是否保留
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(300)

        pages_after_reload = await page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
        check(f"刷新后 3 个页仍存在 (实际 {len(pages_after_reload)})", len(pages_after_reload) == 3)

        # 展开状态:刷新后 第一个应该是展开的
        expanded_after = await page.evaluate("JSON.parse(localStorage.getItem('power-wiki:tree-expanded') || '[]')")
        check(f"刷新后 tree-expanded 至少 2 项 (实际 {len(expanded_after)})", len(expanded_after) >= 2)

        await page.screenshot(path=str(SCREENSHOT_DIR / "07_nested_persisted.png"), full_page=True)

        # ==== 10. 控制台错误 ====
        print("\n=== 10. 控制台错误 ===")
        real_errors = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real_errors)})", len(real_errors) == 0,
              "; ".join(real_errors[:3]) if real_errors else "")

        await browser.close()

    print("\n" + "=" * 60)
    print("Phase 3 验收总结")
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
