"""Callout (提示框) 验收 — 4 种 variant 都能插入,variant 切换生效,seed callout 解析保留

跑法(需 dev server 已在 127.0.0.1:5173):
    npm run dev
    python scripts/verify_fix7.py

覆盖:
1. seed 页面 (Atlas v3.0) 在 read 视图正常渲染 — 4 种 variant 的 .callout 节点都存在
2. 工具栏"提示框"按钮能插入默认 info 提示框
3. 工具栏变体下拉:在 callout 内时显示,可切换 4 种 variant
4. 工具栏"移除提示框"能把 callout 拆成普通 paragraph
5. slash 菜单"提示框"项能插入默认 info 提示框
6. 编辑保存后,read 视图能正确渲染新插入的 callout
7. 无 console 错误,无 alert 触发
"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SCREENSHOT_DIR = ROOT / "screenshots" / "fix7"
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


async def get_callout_state(page) -> dict:
    """读当前页 callout 节点的状态。读视图用 .prose / .content,编辑视图用 .tiptap。"""
    return await page.evaluate(
        """() => {
          const counts = { info: 0, success: 0, warning: 0, danger: 0, total: 0 }
          const root = document.querySelector('.tiptap')
                  || document.querySelector('.prose')
                  || document.querySelector('.content')
                  || document.body
          root.querySelectorAll('.callout').forEach(el => {
            counts.total += 1
            const v = el.getAttribute('data-variant') ||
                      Array.from(el.classList).find(c => ['info','success','warning','danger'].includes(c))
            if (v && v in counts) counts[v] += 1
          })
          return counts
        }"""
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

        def on_dialog(d):
            alert_count["n"] += 1
            asyncio.create_task(d.dismiss())

        page.on("dialog", on_dialog)

        # 清空 localStorage,走种子
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await wait_for_fonts(page)
        await page.wait_for_timeout(400)

        # ==== 1. seed callout 在 read 视图渲染 ====
        print("\n=== 1. seed callout render in read view ===")
        # 进 Atlas v3.0 种子页 — 通过 URL 路由(避免中文字符在 has-text 里被编码)
        atlas_href = await page.evaluate(
            "() => { const rows = document.querySelectorAll('.tree-row');"
            "  for (const r of rows) {"
            "    const lbl = r.querySelector('.label');"
            "    if (lbl && lbl.textContent.includes('Atlas') && lbl.textContent.includes('v3.0')) return r.getAttribute('data-href') || lbl.textContent;"
            "  } return null; }"
        )
        # 备用:直接进首页 (首页也有 callout)
        await page.locator(".tree-row").filter(has_text="我的知识库").first.click()
        await page.wait_for_timeout(800)

        # ==== 1a. 首页 (info callout) ====
        home_state = await get_callout_state(page)
        check(f"首页 .callout total > 0 (实际 {home_state['total']})", home_state["total"] >= 1)
        check(f"首页有 info callout (实际 {home_state['info']})", home_state["info"] >= 1)
        await page.screenshot(path=str(SCREENSHOT_DIR / "01_seed_home_read.png"), full_page=True)

        # ==== 1b. Atlas v3.0 页 (success + warning) ====
        # 用 JS 直接调路由,避免在 has-text 里塞中文
        atlas_clicked = await page.evaluate(
            "() => { const rows = document.querySelectorAll('.tree-row');"
            "  for (const r of rows) {"
            "    const lbl = r.querySelector('.label');"
            "    if (lbl && lbl.textContent.includes('Atlas') && lbl.textContent.includes('v3.0')) { r.click(); return true; }"
            "  } return false; }"
        )
        check("点击 Atlas 行", atlas_clicked, str(atlas_clicked))
        await page.wait_for_timeout(800)
        atlas_state = await get_callout_state(page)
        check(f"Atlas 页面 .callout total >= 2 (实际 {atlas_state['total']})", atlas_state["total"] >= 2)
        check(f"Atlas 页面有 success callout (实际 {atlas_state['success']})", atlas_state["success"] >= 1)
        check(f"Atlas 页面有 warning callout (实际 {atlas_state['warning']})", atlas_state["warning"] >= 1)

        # 看 class 是否正确(确认 .callout.success 这种复合 class 还在)
        success_visible = await page.locator(".callout.success").count()
        check(f".callout.success 节点存在 (实际 {success_visible})", success_visible >= 1)
        warning_visible = await page.locator(".callout.warning").count()
        check(f".callout.warning 节点存在 (实际 {warning_visible})", warning_visible >= 1)

        # 关键: <p> 描述文字不丢
        desc_visible = await page.locator(".callout p").count()
        check(f".callout 内有 <p> 描述 (实际 {desc_visible})", desc_visible >= 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_seed_atlas_read.png"), full_page=True)

        # ==== 2. 工具栏插入默认 info callout ====
        print("\n=== 2. toolbar insert default info callout ===")
        # 回到首页 (有"新建页面"按钮)
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.wait_for_timeout(400)
        # 新建一个空白页
        await page.locator(".page-actions .btn.primary:has-text('新建页面')").first.click()
        await page.wait_for_timeout(800)
        check("新建后进入 edit 页", "/edit" in page.url, page.url)

        tiptap = page.locator(".tiptap").first
        await tiptap.click()
        await page.wait_for_timeout(200)
        await page.keyboard.type("前面这一段用来定位。", delay=8)
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(100)

        # 工具栏"提示框"按钮
        callout_btn = page.locator(".editor-toolbar .tb-btn[title='提示框']").first
        check("工具栏'提示框'按钮存在", await callout_btn.count() == 1)
        await callout_btn.click()
        await page.wait_for_timeout(300)

        state_after_insert = await get_callout_state(page)
        check(f"插入后 .callout total = 1 (实际 {state_after_insert['total']})", state_after_insert["total"] == 1)
        check(f"默认 variant = info (实际 {state_after_insert['info']})", state_after_insert["info"] == 1)

        # callout 内有 paragraph
        p_in_callout = await page.locator(".tiptap .callout p").count()
        check(f"callout 内有 <p> (实际 {p_in_callout})", p_in_callout >= 1)

        # 变体下拉应出现(在 callout 内)
        callout_variant_wrap = page.locator(".tb-block-type-wrap").filter(has_text="信息")
        # 变体下拉只在 .currentCalloutVariant 非空时显示;它一定在工具栏里
        # 关键检查:有显示 variant 文字的按钮
        var_label = await page.locator(".tb-block-type:has-text('信息')").count()
        check("工具栏显示变体标签'信息'", var_label >= 1)

        await page.screenshot(path=str(SCREENSHOT_DIR / "03_after_toolbar_insert.png"), full_page=True)

        # ==== 3. 变体下拉切换 4 种 variant ====
        print("\n=== 3. variant switch ===")
        # 点开变体下拉
        await page.locator(".tb-block-type:has-text('信息')").first.click()
        await page.wait_for_timeout(150)
        var_menu = page.locator(".tb-block-type-menu")
        check("变体下拉打开", await var_menu.count() == 1)
        opt_count = await var_menu.locator(".tb-block-type-opt").count()
        # 4 个 variant + 1 个"移除提示框"分隔后按钮 = 5
        check(f"变体下拉含 4 个 variant + 移除 (实际 {opt_count})", opt_count == 5)

        # 切到 success
        await page.locator(".tb-block-type-menu .tb-block-type-opt:has-text('成功')").click()
        await page.wait_for_timeout(300)
        state_success = await get_callout_state(page)
        check(f"切到 success (实际 {state_success})", state_success["success"] == 1 and state_success["info"] == 0)
        # 工具栏标签更新
        check("工具栏标签更新为'成功'", await page.locator(".tb-block-type:has-text('成功')").count() >= 1)
        await page.screenshot(path=str(SCREENSHOT_DIR / "04_variant_success.png"), full_page=True)

        # 切到 warning
        await page.locator(".tb-block-type:has-text('成功')").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-menu .tb-block-type-opt:has-text('警告')").click()
        await page.wait_for_timeout(300)
        state_warn = await get_callout_state(page)
        check(f"切到 warning (实际 {state_warn})", state_warn["warning"] == 1 and state_warn["success"] == 0)

        # 切到 danger
        await page.locator(".tb-block-type:has-text('警告')").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-menu .tb-block-type-opt:has-text('危险')").click()
        await page.wait_for_timeout(300)
        state_danger = await get_callout_state(page)
        check(f"切到 danger (实际 {state_danger})", state_danger["danger"] == 1 and state_danger["warning"] == 0)

        # 切回 info
        await page.locator(".tb-block-type:has-text('危险')").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-menu .tb-block-type-opt:has-text('信息')").click()
        await page.wait_for_timeout(300)
        state_info = await get_callout_state(page)
        check(f"切回 info (实际 {state_info})", state_info["info"] == 1 and state_info["danger"] == 0)

        # ==== 4. 移除提示框 ====
        print("\n=== 4. unset callout ===")
        await page.locator(".tb-block-type:has-text('信息')").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-menu .tb-block-type-opt:has-text('移除提示框')").click()
        await page.wait_for_timeout(300)
        state_unset = await get_callout_state(page)
        check(f"移除后 .callout total = 0 (实际 {state_unset['total']})", state_unset["total"] == 0)
        # 变体下拉应消失
        check("变体下拉容器消失", await page.locator(".tb-block-type:has-text('信息')").count() == 0)

        # ==== 5. slash 菜单插入 callout ====
        print("\n=== 5. slash menu insert callout ===")
        # 在编辑器里输 "/"
        await tiptap.click()
        await page.wait_for_timeout(150)
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await page.keyboard.type("/", delay=20)
        await page.wait_for_timeout(300)

        slash_menu = page.locator(".slash-menu")
        check("slash 菜单打开", await slash_menu.count() == 1)
        # 检查有"提示框"项
        slash_callout = slash_menu.locator(".slash-item:has-text('提示框')")
        check("slash 菜单含'提示框'项", await slash_callout.count() == 1)
        await page.screenshot(path=str(SCREENSHOT_DIR / "05_slash_menu.png"), full_page=True)

        await slash_callout.click()
        await page.wait_for_timeout(300)
        state_slash = await get_callout_state(page)
        check(f"slash 插入后 .callout total = 1 (实际 {state_slash['total']})", state_slash["total"] == 1)
        check(f"slash 插入默认 variant = info (实际 {state_slash['info']})", state_slash["info"] == 1)
        check("slash 菜单已关闭", await page.locator(".slash-menu").count() == 0)

        # ==== 6. 发布 → read 视图渲染新插入的 callout ====
        print("\n=== 6. publish then read view ===")
        # 等 RichEditor 800ms debounce 跑完
        await page.wait_for_timeout(1200)
        # 点发布按钮
        publish_btn = page.locator(".editor-toolbar .btn.primary, .tb-action.primary").filter(has_text="发布")
        # toolbar 右上的"发布"按钮
        pub_count = await publish_btn.count()
        if pub_count == 0:
            # 备用:找 .tb-action 且 text=发布
            publish_btn = page.locator(".tb-action:has-text('发布')")
            pub_count = await publish_btn.count()
        check("发布按钮存在", pub_count >= 1, f"found {pub_count}")
        await publish_btn.first.click()
        await page.wait_for_timeout(1200)

        # 跳到 read 视图
        check("跳到 read 视图 (非 /edit)", "/edit" not in page.url, page.url)
        # 新插入的 callout 应可见
        new_callout = await get_callout_state(page)
        check(f"read 视图 .callout total >= 1 (实际 {new_callout['total']})", new_callout["total"] >= 1)
        check("read 视图含 info callout", new_callout["info"] >= 1)
        await page.screenshot(path=str(SCREENSHOT_DIR / "06_read_after_publish.png"), full_page=True)

        # ==== 7. 切到 success 验证 variant 在 read 视图 ====
        print("\n=== 7. variant persists to read view ===")
        # 拿到当前页 id,直接跳到 edit 页
        current_url = page.url
        page_id = current_url.split("/p/")[-1].rstrip("/")
        await page.goto(f"{BASE}/#/p/{page_id}/edit", wait_until="networkidle")
        await page.wait_for_timeout(800)
        check("回到 edit 页", "/edit" in page.url, page.url)

        await page.locator(".tiptap").first.click()
        await page.wait_for_timeout(200)
        # 光标移到 callout 内 → 变体下拉出现
        await page.keyboard.press("Control+End")
        await page.wait_for_timeout(100)
        await page.keyboard.press("ArrowUp")
        await page.wait_for_timeout(200)
        # 此时光标在 callout 最后一个 paragraph 末
        # 点开变体下拉,切到 danger
        if await page.locator(".tb-block-type:has-text('信息')").count() == 0:
            # 光标可能不在 callout 内;再 ↑ 一次
            await page.keyboard.press("ArrowUp")
            await page.wait_for_timeout(150)
        if await page.locator(".tb-block-type:has-text('信息')").count() == 0:
            # 直接把光标硬放进 callout 内部
            callout_el = page.locator(".tiptap .callout").first
            box = await callout_el.bounding_box()
            if box:
                await page.mouse.click(box["x"] + 20, box["y"] + box["height"] - 5)
                await page.wait_for_timeout(200)

        if await page.locator(".tb-block-type:has-text('信息')").count():
            await page.locator(".tb-block-type:has-text('信息')").first.click()
            await page.wait_for_timeout(150)
            await page.locator(".tb-block-type-menu .tb-block-type-opt:has-text('危险')").click()
            await page.wait_for_timeout(300)
        else:
            check("能在 callout 内看到变体下拉", False, "变体下拉未出现")

        state_d = await get_callout_state(page)
        check(f"切到 danger (实际 {state_d})", state_d["danger"] == 1)

        # 发布
        await page.wait_for_timeout(1200)
        pub_btn2 = page.locator(".tb-action:has-text('发布')").first
        if await pub_btn2.count() == 0:
            pub_btn2 = page.locator("button:has-text('发布')").first
        await pub_btn2.click()
        await page.wait_for_timeout(1200)
        check("跳到 read 视图", "/edit" not in page.url, page.url)
        state_read = await get_callout_state(page)
        check(f"read 视图渲染 danger callout (实际 {state_read['danger']})", state_read["danger"] >= 1)
        await page.screenshot(path=str(SCREENSHOT_DIR / "07_read_danger.png"), full_page=True)

        # ==== 8. 不触发 alert + 无 console 错误 ====
        print("\n=== 8. no native alerts / no console errors ===")
        check(f"全程未触发 alert (实际 {alert_count['n']} 次)", alert_count["n"] == 0)
        real = [e for e in console_errors if "favicon" not in e.lower() and "Material Symbols" not in e]
        check(f"无 console 错误 (实际 {len(real)})", len(real) == 0,
              "; ".join(real[:3]) if real else "")

        await browser.close()

    print("\n" + "=" * 60)
    print("fix7 (Callout 提示框) 验收总结")
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
