"""Verify comment delete uses the custom ConfirmDialog (not browser confirm)."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).parent
SHOTS = ROOT / "screenshots"
SHOTS.mkdir(exist_ok=True)
OK = "[OK]"
NO = "[FAIL]"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 2560, "height": 1440})
        page = await ctx.new_page()
        api = page.request

        # 1. login as admin
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "admin@power-wiki.local")
        await page.fill("input[type=password]", "admin123")
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(500)
        print(f"{OK} logged in admin")

        # 2. find a page with an existing comment, or pick any page
        pages_resp = await api.get("http://127.0.0.1:8787/api/pages?space=cgpquwn63u&limit=50")
        pages = json.loads(await pages_resp.text())
        items = pages.get("items", pages) if isinstance(pages, dict) else pages
        if not items:
            print(f"{NO} no pages found")
            return
        target_page = items[0]
        page_id = target_page["id"]
        print(f"{OK} picked page: {target_page['title']} (id={page_id})")

        # 3. post a fresh comment so we can delete it
        c = await api.post(
            "http://127.0.0.1:8787/api/comments",
            data=json.dumps({"pageId": page_id, "contentMd": f"Test comment to delete — ts={int(asyncio.get_event_loop().time()*1000)}"}),
            headers={"content-type": "application/json"},
        )
        if c.status != 200 and c.status != 201:
            err = json.loads(await c.text())
            print(f"{NO} post comment failed: {c.status} {err}")
            return
        created = json.loads(await c.text())
        comment_id = created["id"]
        print(f"{OK} posted comment id={comment_id}")

        # 4. navigate to the page so the comment renders
        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id}")
        await page.wait_for_selector(".comment-item", timeout=10000)
        await page.wait_for_timeout(800)

        # 5. listen for any window.confirm dialog — should NOT fire
        confirm_fired = False
        async def on_dialog(d):
            nonlocal confirm_fired
            confirm_fired = True
            print(f"{NO} native confirm dialog appeared: {d.message!r}")
            await d.dismiss()
        page.on("dialog", lambda d: asyncio.create_task(on_dialog(d)))

        # 6. open kebab on the comment and click delete
        items = await page.query_selector_all(".comment-item")
        # find the one matching our test comment
        target = None
        for it in items:
            text = (await it.inner_text())
            if "Test comment to delete" in text:
                target = it
                break
        if not target:
            print(f"{NO} could not find posted comment in DOM")
            return
        # click the kebab
        kebab = await target.query_selector(".ci-kebab")
        if not kebab:
            print(f"{NO} kebab button missing")
            return
        await kebab.click()
        await page.wait_for_timeout(300)
        # click the delete menu item
        del_btn = await page.query_selector(".ci-menu button")
        if not del_btn:
            print(f"{NO} delete menu item missing")
            return
        await del_btn.click()
        await page.wait_for_timeout(500)

        # 7. custom confirm dialog should appear (.confirm-dialog)
        dialog = await page.query_selector(".confirm-dialog")
        if dialog:
            title_text = (await (await dialog.query_selector(".confirm-title")).inner_text()).strip()
            print(f"{OK} custom dialog appeared: {title_text!r}")
        else:
            print(f"{NO} custom dialog missing")
        await page.screenshot(path=str(SHOTS / "comment_delete_confirm.png"), full_page=False)
        print(f"{OK} saved {SHOTS / 'comment_delete_confirm.png'}")

        # 8. cancel: click the cancel button (first .btn.ghost in .confirm-actions)
        cancel_btn = await page.query_selector(".confirm-actions .btn.ghost")
        if cancel_btn:
            await cancel_btn.click()
            await page.wait_for_timeout(500)
            items = await page.query_selector_all(".comment-item")
            still_there = False
            for it in items:
                text = await it.inner_text()
                if "Test comment to delete" in text:
                    still_there = True
                    break
            if still_there:
                print(f"{OK} cancel kept the comment")
            else:
                print(f"{NO} cancel deleted the comment")
        else:
            print(f"{NO} no cancel button found in custom dialog")

        if confirm_fired:
            print(f"{NO} native confirm() was used — should be replaced with custom dialog")
        else:
            print(f"{OK} native confirm() not used (custom dialog took over)")

        # 9. delete for real: open kebab → delete → confirm
        items = await page.query_selector_all(".comment-item")
        target = None
        for it in items:
            text = await it.inner_text()
            if "Test comment to delete" in text:
                target = it
                break
        if target:
            await (await target.query_selector(".ci-kebab")).click()
            await page.wait_for_timeout(300)
            await (await page.query_selector(".ci-menu button")).click()
            await page.wait_for_timeout(500)
            # find the confirm button (last .btn in .confirm-actions, has primary or danger class)
            confirm_btn = await page.query_selector(".confirm-actions .btn.primary, .confirm-actions .btn.danger")
            if confirm_btn:
                await confirm_btn.click()
                await page.wait_for_timeout(1500)
                items = await page.query_selector_all(".comment-item")
                still_there = False
                for it in items:
                    text = await it.inner_text()
                    if "Test comment to delete" in text:
                        still_there = True
                        break
                if not still_there:
                    print(f"{OK} confirm deleted the comment")
                else:
                    print(f"{NO} confirm did not delete the comment")
            else:
                print(f"{NO} no confirm button found")

        await browser.close()


asyncio.run(main())
