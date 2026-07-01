"""Verify the todo list checkbox/text alignment in both edit and read mode."""
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

        # 1. login as admin (we need admin to create a test user if needed)
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "admin@power-wiki.local")
        await page.fill("input[type=password]", "admin123")
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(500)
        print(f"{OK} logged in admin")

        # 2. ensure a regular test user exists; use a non-admin user because
        #    admin cannot write to personal space (personal_space_readonly).
        test_email = "todo-test@power-wiki.local"
        create_user = await api.post(
            "http://127.0.0.1:8787/api/admin/users",
            data=json.dumps({"email": test_email, "name": "Todo Test"}),
            headers={"content-type": "application/json"},
        )
        if create_user.status == 201:
            user_data = json.loads(await create_user.text())
            initial_password = user_data["initialPassword"]
            print(f"{OK} created user: {user_data['user']['name']} (initial pw: {initial_password})")
        elif create_user.status == 409:
            print(f"{OK} user already exists; using known initial password")
            users_list_resp = await api.get("http://127.0.0.1:8787/api/admin/users?limit=200")
            users_list = json.loads(await users_list_resp.text())
            user_id = None
            for u in users_list.get("items", users_list):
                if u.get("email") == test_email:
                    user_id = u["id"]
                    break
            if not user_id:
                print(f"{NO} cannot find existing user")
                return
            r = await api.post(f"http://127.0.0.1:8787/api/admin/users/{user_id}/reset-password")
            initial_password = json.loads(await r.text())["initialPassword"]
            print(f"{OK} reset password: {initial_password}")
        else:
            err = json.loads(await create_user.text())
            print(f"{NO} create user failed: {create_user.status} {err}")
            return

        # 3. sign out admin, sign in as the test user
        await api.post("http://127.0.0.1:8787/api/auth/sign-out")
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.reload()
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", test_email)
        await page.fill("input[type=password]", initial_password)
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(800)
        print(f"{OK} logged in as Todo Test (now at {page.url})")

        # If mustResetPassword, the page might be /reset-password; handle it.
        # We need to either (a) reset via UI so the auth store picks up the new
        # flag, or (b) sign out + sign in again via UI to refresh the store.
        # Easiest: reset password via API, then sign in again from scratch.
        if "/reset-password" in page.url:
            new_pw = initial_password + "X1!"
            r = await api.post(
                "http://127.0.0.1:8787/api/auth/reset-password",
                data=json.dumps({"currentPassword": initial_password, "newPassword": new_pw}),
                headers={"content-type": "application/json"},
            )
            if r.status == 200:
                print(f"{OK} reset password via API")
            else:
                err = json.loads(await r.text())
                print(f"{NO} reset password failed: {r.status} {err}")
                return
            # Sign out and sign back in via UI to refresh auth store
            await api.post("http://127.0.0.1:8787/api/auth/sign-out")
            await page.goto("http://127.0.0.1:5173/#/login")
            await page.reload()
            await page.wait_for_selector("input[type=email]", timeout=10000)
            await page.fill("input[type=email]", test_email)
            await page.fill("input[type=password]", new_pw)
            await page.click("button[type=submit]")
            await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
            await page.wait_for_timeout(800)
            initial_password = new_pw
            print(f"{OK} re-logged in (now at {page.url})")

        # 4. find personal space for the test user
        spaces_resp = await api.get("http://127.0.0.1:8787/api/spaces")
        spaces = json.loads(await spaces_resp.text())
        if isinstance(spaces, dict) and "items" in spaces:
            spaces = spaces["items"]
        personal = next((s for s in spaces if s.get("kind") == "personal"), None)
        if not personal:
            print(f"{NO} no personal space")
            return
        print(f"{OK} personal space: {personal['name']} ({personal['id']})")

        # Tiptap ProseMirror JSON for a single task list with two items
        task_list_json = {
            "type": "doc",
            "content": [
                {
                    "type": "taskList",
                    "content": [
                        {
                            "type": "taskItem",
                            "attrs": {"checked": False},
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [
                                        {"type": "text", "text": "X管理端,不需要给个人空间 - 授权访问组,限定的本人访问就好了。"}
                                    ],
                                }
                            ],
                        },
                        {
                            "type": "taskItem",
                            "attrs": {"checked": True},
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [
                                        {"type": "text", "text": "已完成的待办,验证 checkbox 选中态对齐"}
                                    ],
                                }
                            ],
                        },
                    ],
                }
            ],
        }
        body = {
            "spaceId": personal["id"],
            "parentId": None,
            "title": "Todo alignment test",
            "contentJSON": task_list_json,
            "contentHTML": "",
        }
        create = await api.post(
            "http://127.0.0.1:8787/api/pages",
            data=json.dumps(body),
            headers={"content-type": "application/json"},
        )
        if create.status != 201:
            err = json.loads(await create.text())
            print(f"{NO} create failed: status={create.status} body={err}")
            return
        created = json.loads(await create.text())
        new_id = created["id"]
        print(f"{OK} created todo test page: id={new_id}")

        # 4. navigate to edit mode, take screenshot, measure alignment
        # First verify the page exists via API
        get_resp = await api.get(f"http://127.0.0.1:8787/api/pages/{new_id}")
        print(f"   page exists check: status={get_resp.status}")
        if get_resp.status != 200:
            err = json.loads(await get_resp.text())
            print(f"{NO} page {new_id} not found: {err}")
            return
        page_meta = json.loads(await get_resp.text())
        print(f"   page meta: id={page_meta.get('id')} title={page_meta.get('title')!r}")
        # Check contentJSON was stored
        cj = page_meta.get("contentJSON")
        if cj:
            print(f"   contentJSON keys: {list(cj.keys()) if isinstance(cj, dict) else type(cj)}")
        else:
            print(f"   [WARN] contentJSON is empty!")

        # Refresh the pages store via Pinia, then go to edit. The store doesn't
        # know about pages created via raw API, so EditView's getPage() returns
        # undefined and a new empty page is created.
        # We do a hard page.reload() to make the store re-fetch.
        await page.goto("http://127.0.0.1:5173/#/")
        await page.wait_for_timeout(1500)
        await page.reload()
        await page.wait_for_timeout(2500)
        # Now go to edit page
        await page.goto(f"http://127.0.0.1:5173/#/p/{new_id}/edit")
        await page.wait_for_timeout(2500)
        # debug: what's on the page
        debug = await page.evaluate(
            """
            () => ({
                url: location.href,
                hasTiptap: !!document.querySelector('.tiptap'),
                tiptapHTML: document.querySelector('.tiptap')?.innerHTML?.slice(0, 300),
                hasReadContent: !!document.querySelector('.read-content, .prose'),
                proseHTML: document.querySelector('.read-content, .prose')?.innerHTML?.slice(0, 300),
                allUl: Array.from(document.querySelectorAll('ul')).slice(0, 3).map(u => ({
                    cls: u.className,
                    dataType: u.getAttribute('data-type'),
                    parent: u.parentElement?.className,
                })),
            })
            """
        )
        print(f"   debug: {debug}")
        if "taskList" not in (debug.get("tiptapHTML") or ""):
            # One more retry — wait + check
            await page.wait_for_timeout(3000)
            debug2 = await page.evaluate(
                """
                () => ({
                    url: location.href,
                    tiptapHTML: document.querySelector('.tiptap')?.innerHTML?.slice(0, 300),
                })
                """
            )
            print(f"   debug2 (after 3s): {debug2}")
            if "taskList" not in (debug2.get("tiptapHTML") or ""):
                print(f"{NO} editor did not load the task list — EditView probably created a new page")
                return
        await page.wait_for_selector(".tiptap ul[data-type=taskList]", timeout=5000)
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SHOTS / "todo_align_edit.png"), full_page=False)
        print(f"{OK} saved {SHOTS / 'todo_align_edit.png'}")

        # measure: get bounding boxes of checkbox and the first text line
        edit_metrics = await page.evaluate(
            """
            () => {
                const items = document.querySelectorAll('.tiptap ul[data-type=taskList] > li');
                if (items.length === 0) return null;
                const li = items[0];
                const label = li.querySelector('label');
                const cb = label?.querySelector('input[type=checkbox]');
                const p = li.querySelector('div > p');
                if (!label || !cb || !p) return null;
                const liBox = li.getBoundingClientRect();
                const labelBox = label.getBoundingClientRect();
                const cbBox = cb.getBoundingClientRect();
                const pBox = p.getBoundingClientRect();
                return {
                    liTop: liBox.top,
                    labelTop: labelBox.top,
                    labelHeight: labelBox.height,
                    cbTop: cbBox.top,
                    cbCenter: cbBox.top + cbBox.height / 2,
                    pTop: pBox.top,
                    pHeight: pBox.height,
                };
            }
            """
        )
        if not edit_metrics:
            print(f"{NO} could not measure edit mode alignment")
        else:
            print(f"   edit mode metrics: {edit_metrics}")
            # ideal: cbCenter should equal approximately pTop + pHeight*0.5 (or at least
            # within 4px of where the visible text center sits inside the line)
            text_center = edit_metrics["pTop"] + edit_metrics["pHeight"] / 2
            cb_center = edit_metrics["cbCenter"]
            delta = abs(text_center - cb_center)
            print(f"   text center y={text_center:.1f}, cb center y={cb_center:.1f}, delta={delta:.1f}px")
            if delta < 4:
                print(f"{OK} edit mode aligned within 4px")
            elif delta < 8:
                print(f"[WARN] edit mode off by {delta:.1f}px (acceptable)")
            else:
                print(f"{NO} edit mode off by {delta:.1f}px — still misaligned")

        # 5. save (so the new HTML is committed to DB), then navigate to read mode
        # Save by clicking the save button if visible, or just rely on autosave.
        # The Tiptap editor should auto-save after a moment. Wait for it.
        await page.wait_for_timeout(2500)
        # navigate to read mode
        await page.goto(f"http://127.0.0.1:5173/#/p/{new_id}")
        await page.wait_for_selector(".prose ul[data-type=taskList]", timeout=10000)
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SHOTS / "todo_align_read.png"), full_page=False)
        print(f"{OK} saved {SHOTS / 'todo_align_read.png'}")

        read_metrics = await page.evaluate(
            """
            () => {
                const items = document.querySelectorAll('.prose ul[data-type=taskList] > li');
                if (items.length === 0) return null;
                const li = items[0];
                const label = li.querySelector('label');
                const cb = label?.querySelector('input[type=checkbox]');
                const p = li.querySelector('div > p');
                if (!label || !cb || !p) return null;
                const liBox = li.getBoundingClientRect();
                const labelBox = label.getBoundingClientRect();
                const cbBox = cb.getBoundingClientRect();
                const pBox = p.getBoundingClientRect();
                return {
                    liTop: liBox.top,
                    labelTop: labelBox.top,
                    labelHeight: labelBox.height,
                    cbTop: cbBox.top,
                    cbCenter: cbBox.top + cbBox.height / 2,
                    pTop: pBox.top,
                    pHeight: pBox.height,
                };
            }
            """
        )
        if not read_metrics:
            print(f"{NO} could not measure read mode alignment")
        else:
            print(f"   read mode metrics: {read_metrics}")
            text_center = read_metrics["pTop"] + read_metrics["pHeight"] / 2
            cb_center = read_metrics["cbCenter"]
            delta = abs(text_center - cb_center)
            print(f"   text center y={text_center:.1f}, cb center y={cb_center:.1f}, delta={delta:.1f}px")
            if delta < 4:
                print(f"{OK} read mode aligned within 4px")
            elif delta < 8:
                print(f"[WARN] read mode off by {delta:.1f}px (acceptable)")
            else:
                print(f"{NO} read mode off by {delta:.1f}px — still misaligned")

        # 6. cleanup
        await page.goto(f"http://127.0.0.1:5173/#/p/{new_id}/edit")
        await page.wait_for_timeout(1000)
        # delete via API (test user can soft-delete their own pages)
        del_resp = await api.delete(f"http://127.0.0.1:8787/api/pages/{new_id}")
        if del_resp.status == 204:
            print(f"{OK} cleaned up test page")

        await browser.close()


asyncio.run(main())
