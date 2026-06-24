"""视觉验收:三个最近修复的用户问题

1. 编辑页不再意外上滑(overflow-anchor: none)
2. 链接入口已移除(工具栏 + bubble menu 都没有 link)
3. 编辑器内 H1/H2/H3 视觉明显区别于正文(不再被 HeadingView margin 覆盖)
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path("C:/Users/Administrator/Desktop/power-wiki")
SHOTS = ROOT / "screenshots" / "visual"
SHOTS.mkdir(parents=True, exist_ok=True)
BASE = "http://localhost:5173"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.evaluate("localStorage.clear()")
        await page.reload(wait_until="networkidle")
        await page.wait_for_function(
            "document.fonts.check('1em \"Material Symbols Outlined\"')", timeout=10000
        )
        await page.wait_for_timeout(300)

        # 进入编辑态
        await page.locator(".page-actions .btn.primary:has-text('新建页面')").first.click()
        await page.wait_for_timeout(800)

        tiptap = page.locator(".tiptap").first

        # ==== 截图 1:三个 heading 级别对比 ====
        # 在空编辑器里,从顶到底依次:H1 / H2 / H3 / paragraph
        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-opt:has-text('一级标题')").first.click()
        await page.wait_for_timeout(200)
        await tiptap.click()
        await page.keyboard.type("一级标题 32px", delay=10)
        await page.keyboard.press("Enter")

        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-opt:has-text('二级标题')").first.click()
        await page.wait_for_timeout(200)
        await tiptap.click()
        await page.keyboard.press("End")
        await page.keyboard.type("二级标题 24px", delay=10)
        await page.keyboard.press("Enter")

        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-opt:has-text('三级标题')").first.click()
        await page.wait_for_timeout(200)
        await tiptap.click()
        await page.keyboard.press("End")
        await page.keyboard.type("三级标题 18px", delay=10)
        await page.keyboard.press("Enter")

        await page.locator(".tb-block-type").first.click()
        await page.wait_for_timeout(150)
        await page.locator(".tb-block-type-opt:has-text('正文')").first.click()
        await page.wait_for_timeout(200)
        await tiptap.click()
        await page.keyboard.press("End")
        await page.keyboard.type("正文段落 15px,这是普通段落文字", delay=10)

        await page.wait_for_timeout(300)
        await page.screenshot(path=str(SHOTS / "01_heading_sizes.png"), full_page=False)

        # 抓 DOM 信息确认
        for tag in ("h1", "h2", "h3", "p"):
            loc = page.locator(f".tiptap {tag}")
            n = await loc.count()
            if n == 0:
                continue
            styles = await loc.first.evaluate("""el => {
                const cs = getComputedStyle(el);
                return {
                    fontSize: cs.fontSize,
                    fontWeight: cs.fontWeight,
                    marginTop: cs.marginTop,
                };
            }""")
            print(f"{tag}: count={n}, styles={styles}")

        # ==== 截图 2:工具栏 — 确认没有 link 按钮 ====
        await page.screenshot(path=str(SHOTS / "02_toolbar_no_link.png"),
                              clip={"x": 0, "y": 60, "width": 1440, "height": 130})

        link_toolbar = await page.locator(".editor-toolbar .tb-btn[title*='链接']").count()
        link_bubble = await page.locator(".bubble-menu [title*='链接']").count()
        print(f"工具栏 link 按钮: {link_toolbar}, bubble menu link 按钮: {link_bubble}")

        # ==== 截图 3:bubble menu — 选区时显示,无 link ====
        # 选中一段文字
        await page.keyboard.press("Control+Home")
        # 光标跳到顶部后,往下选几行
        await page.keyboard.press("ArrowDown")
        await page.keyboard.press("ArrowDown")
        await page.keyboard.press("ArrowDown")
        await page.keyboard.press("ArrowDown")
        await page.keyboard.press("Home")
        await page.keyboard.down("Shift")
        await page.keyboard.press("ArrowDown")
        await page.keyboard.press("End")
        await page.keyboard.up("Shift")
        await page.wait_for_timeout(300)

        bubble = page.locator(".bubble-menu")
        bubble_visible = await bubble.count() > 0 and await bubble.first.is_visible()
        print(f"bubble menu 显示: {bubble_visible}")
        if bubble_visible:
            await page.screenshot(path=str(SHOTS / "03_bubble_no_link.png"),
                                  clip={"x": 200, "y": 60, "width": 1000, "height": 300})

        # ==== 截图 4:滚动不跳 ====
        # 在文档底部继续输入,触发内容增长,检查滚动位置不突变
        scroll_before = await page.evaluate("window.scrollY")
        await page.keyboard.press("Control+End")
        for i in range(8):
            await page.keyboard.type(f"这是滚动测试段落第 {i+1} 行内容", delay=10)
            await page.keyboard.press("Enter")
        await page.wait_for_timeout(400)
        scroll_after = await page.evaluate("window.scrollY")
        print(f"输入前 scrollY={scroll_before}, 输入后 scrollY={scroll_after}")
        # 滚动应正常往下走,不应被强制重置
        await page.screenshot(path=str(SHOTS / "04_after_long_typing.png"), full_page=False)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())