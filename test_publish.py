"""Verify the "发布到" (publish) flow for personal space pages."""
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
        print(f"{OK} logged in (admin)")

        # 1a. ensure a regular test user exists
        create_user = await api.post(
            "http://127.0.0.1:8787/api/admin/users",
            data=json.dumps({"email": "publish-test@power-wiki.local", "name": "Publish Test"}),
            headers={"content-type": "application/json"},
        )
        if create_user.status == 201:
            user_data = json.loads(await create_user.text())
            initial_password = user_data["initialPassword"]
            print(f"{OK} created user: {user_data['user']['name']} (initial pw: {initial_password})")
        elif create_user.status == 409:
            print(f"{OK} user already exists; using known initial password")
            # We need to reset the password to get a known one
            users_list_resp = await api.get("http://127.0.0.1:8787/api/admin/users?limit=200")
            users_list = json.loads(await users_list_resp.text())
            user_id = None
            for u in users_list.get("items", users_list):
                if u.get("email") == "publish-test@power-wiki.local":
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

        # sign out admin, sign in as the test user
        await api.post("http://127.0.0.1:8787/api/auth/sign-out")
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.wait_for_timeout(800)
        # Hard reload to clear any stale in-memory auth state
        await page.reload()
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "publish-test@power-wiki.local")
        await page.fill("input[type=password]", initial_password)
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        # If mustResetPassword, the page might be /reset-password; that's fine.
        await page.wait_for_timeout(500)
        print(f"{OK} logged in as Publish Test (now at {page.url})")

        # If we need to reset, do that first
        if "/reset-password" in page.url:
            print("[INFO] need to reset password first")
            # Try setting a new password directly via API
            r = await api.post(
                "http://127.0.0.1:8787/api/auth/reset-password",
                data=json.dumps({"currentPassword": initial_password, "newPassword": initial_password + "X1!"}),
                headers={"content-type": "application/json"},
            )
            if r.status == 200:
                print(f"{OK} reset password via API")
                await page.wait_for_timeout(500)
            else:
                err = json.loads(await r.text())
                print(f"{NO} reset password failed: {r.status} {err}")
                return
            initial_password = initial_password + "X1!"
            await page.goto("http://127.0.0.1:5173/#/")
            await page.wait_for_timeout(800)

        # 1b. find user id, sign back in as admin, add user to team space
        # get test user id from admin list
        await api.post("http://127.0.0.1:8787/api/auth/sign-out")
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.reload()
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "admin@power-wiki.local")
        await page.fill("input[type=password]", "admin123")
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(500)
        print(f"{OK} re-signed in admin")

        users_resp = await api.get("http://127.0.0.1:8787/api/admin/users?limit=200")
        users_list = json.loads(await users_resp.text())
        items = users_list.get("items", users_list) if isinstance(users_list, dict) else users_list
        test_user_id = next((u["id"] for u in items if u.get("email") == "publish-test@power-wiki.local"), None)
        if not test_user_id:
            print(f"{NO} could not find test user id")
            return
        # find or create a group that has access to the team space
        # simplest: add user to a group that has access to default team space (cgpquwn63u)
        # get groups
        groups_resp = await api.get("http://127.0.0.1:8787/api/admin/groups?limit=200")
        groups = json.loads(await groups_resp.text())
        gitems = groups.get("items", groups) if isinstance(groups, dict) else groups
        # try to find a group that has access to the default team space
        team_space_id = "cgpquwn63u"
        target_group_id = None
        for g in gitems:
            gd = await api.get(f"http://127.0.0.1:8787/api/admin/groups/{g['id']}")
            gd_json = json.loads(await gd.text())
            # Check the group has access to the team space
            team = await api.get(f"http://127.0.0.1:8787/api/admin/spaces/{team_space_id}")
            team_json = json.loads(await team.text())
            if team_json.get("accessGroupIds") and g["id"] in team_json["accessGroupIds"]:
                target_group_id = g["id"]
                break

        if not target_group_id:
            # create a new group
            gcreate = await api.post(
                "http://127.0.0.1:8787/api/admin/groups",
                data=json.dumps({"name": "publish-test-group", "description": "for publish test"}),
                headers={"content-type": "application/json"},
            )
            if gcreate.status == 201:
                g = json.loads(await gcreate.text())
                target_group_id = g["id"]
                print(f"{OK} created group: publish-test-group")
            else:
                err = json.loads(await gcreate.text())
                print(f"{NO} could not create group: {gcreate.status} {err}")
                return
            # grant this group access to team space
            grant = await api.post(
                f"http://127.0.0.1:8787/api/admin/spaces/{team_space_id}/access/{target_group_id}",
            )
            if grant.status == 200:
                print(f"{OK} granted group access to default team space")
            else:
                err = json.loads(await grant.text())
                print(f"{NO} could not grant access: {grant.status} {err}")
                return

        # add test user to the group
        add = await api.post(
            f"http://127.0.0.1:8787/api/admin/groups/{target_group_id}/members",
            data=json.dumps({"userId": test_user_id}),
            headers={"content-type": "application/json"},
        )
        if add.status == 200:
            print(f"{OK} added test user to group {target_group_id}")
        else:
            err = json.loads(await add.text())
            print(f"[info] add user to group: {add.status} {err}")

        # sign back in as test user to pick up new group membership
        await api.post("http://127.0.0.1:8787/api/auth/sign-out")
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.reload()
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "publish-test@power-wiki.local")
        await page.fill("input[type=password]", initial_password)
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(800)
        print(f"{OK} re-signed in Publish Test (now at {page.url})")

        # 2. get personal + team spaces
        spaces_resp = await api.get("http://127.0.0.1:8787/api/spaces")
        spaces = json.loads(await spaces_resp.text())
        if isinstance(spaces, dict) and "items" in spaces:
            spaces = spaces["items"]
        personal = next((s for s in spaces if s.get("kind") == "personal"), None)
        team = next((s for s in spaces if s.get("kind") == "shared"), None)
        if not personal or not team:
            print(f"{NO} need one personal and one team space, got spaces: {[s.get('kind') for s in spaces]}")
            return
        print(f"{OK} personal space: {personal['name']} ({personal['id']})")
        print(f"{OK} team space: {team['name']} ({team['id']})")

        # 3. create a personal-space page with content
        body = {
            "spaceId": personal["id"],
            "parentId": None,
            "title": "Personal Draft",
            "contentHTML": "<h2>Hello from personal</h2><p>body</p>",
            "contentJSON": {
                "type": "doc",
                "content": [
                    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Hello from personal"}]},
                    {"type": "paragraph", "content": [{"type": "text", "text": "body"}]},
                ],
            },
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
        draft = json.loads(await create.text())
        print(f"{OK} created draft: {draft['title']} (id={draft['id']})")

        # 4. publish to team space
        pub = await api.post(
            f"http://127.0.0.1:8787/api/pages/{draft['id']}/publish",
            data=json.dumps({"targetSpaceId": team["id"]}),
            headers={"content-type": "application/json"},
        )
        if pub.status != 201:
            err = json.loads(await pub.text())
            print(f"{NO} publish failed: status={pub.status} body={err}")
            return
        copy_page = json.loads(await pub.text())
        print(f"{OK} published copy: {copy_page['title']} (id={copy_page['id']})")

        # 5. assertions
        if "个人分享" not in copy_page["title"]:
            print(f"{NO} new title missing '个人分享' suffix: {copy_page['title']!r}")
        else:
            print(f"{OK} title has 个人分享 suffix")
        if copy_page["spaceId"] != team["id"]:
            print(f"{NO} new page not in target space: {copy_page['spaceId']}")
        else:
            print(f"{OK} new page in target team space")
        if copy_page["contentHTML"] != draft["contentHTML"]:
            print(f"{NO} content changed during publish")
        else:
            print(f"{OK} content copied verbatim")

        # 6. verify original page is still in personal space, untouched
        get_orig = await api.get(f"http://127.0.0.1:8787/api/pages/{draft['id']}")
        if get_orig.status != 200:
            print(f"{NO} original page gone: status={get_orig.status}")
        else:
            orig = json.loads(await get_orig.text())
            if orig["spaceId"] != personal["id"]:
                print(f"{NO} original moved out of personal: spaceId={orig['spaceId']}")
            else:
                print(f"{OK} original still in personal space (id unchanged, space unchanged)")
            if orig["title"] != draft["title"]:
                print(f"{NO} original title changed: {orig['title']!r}")
            else:
                print(f"{OK} original title unchanged")

        # 7. negative test: try publishing a team-space page — should 403
        neg = await api.post(
            f"http://127.0.0.1:8787/api/pages/{copy_page['id']}/publish",
            data=json.dumps({"targetSpaceId": team["id"]}),
            headers={"content-type": "application/json"},
        )
        if neg.status == 403:
            err = json.loads(await neg.text())
            print(f"{OK} team-space publish correctly rejected: 403 {err.get('error')}")
        else:
            print(f"{NO} team-space publish should be 403, got {neg.status}")

        # 8. negative test: publishing to same space — should 400
        same = await api.post(
            f"http://127.0.0.1:8787/api/pages/{draft['id']}/publish",
            data=json.dumps({"targetSpaceId": personal["id"]}),
            headers={"content-type": "application/json"},
        )
        if same.status in (400, 403):
            err = json.loads(await same.text())
            print(f"{OK} same-space publish correctly rejected: {same.status} {err.get('error')}")
        else:
            print(f"{NO} same-space publish should be 400/403, got {same.status}")

        # 9. UI screenshot: navigate to the published copy
        await page.goto(f"http://127.0.0.1:5173/#/p/{copy_page['id']}")
        await page.wait_for_selector(".page-title, h1, .read-content", timeout=10000)
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(SHOTS / "published_copy.png"), full_page=False)
        print(f"{OK} saved {SHOTS / 'published_copy.png'}")

        # 10. verify UI menu rename: open draft in tree and check "发布到" appears
        # First switch to personal space so the draft is in the visible tree
        await page.evaluate(
            f"() => {{ localStorage.setItem('power-wiki:active-space', '{personal['id']}') }}"
        )
        await page.goto(f"http://127.0.0.1:5173/#/p/{draft['id']}")
        await page.wait_for_timeout(1000)
        # open tree context menu on draft
        # the draft should be visible in the sidebar under personal space
        # find the row in the page tree
        rows = await page.query_selector_all(".tree-row .label")
        target_row = None
        for r in rows:
            text = (await r.inner_text()).strip()
            if text == draft["title"]:
                target_row = r
                break
        if not target_row:
            print(f"{NO} could not find draft in tree")
        else:
            # right-click the row to open context menu
            box = await target_row.bounding_box()
            if box:
                await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, button="right")
                await page.wait_for_timeout(400)
                # look for "发布到..." text
                menu_texts = await page.query_selector_all(".menu .menu-item span:last-child")
                labels = [(await m.inner_text()).strip() for m in menu_texts]
                if "发布到..." in labels:
                    print(f"{OK} menu shows '发布到...' (old '移动到...' replaced)")
                else:
                    print(f"{NO} menu labels: {labels}")
                await page.screenshot(path=str(SHOTS / "publish_menu.png"), full_page=False)
                print(f"{OK} saved {SHOTS / 'publish_menu.png'}")

                # 11. click 发布到... and verify popover appears with team space option
                publish_item = None
                items = await page.query_selector_all(".menu .menu-item")
                for it in items:
                    text = (await it.inner_text()).strip()
                    if "发布到" in text:
                        publish_item = it
                        break
                if publish_item:
                    await publish_item.click()
                    await page.wait_for_timeout(500)
                    # look for the popover with team space
                    popover = await page.query_selector(".m2s-root")
                    if popover:
                        print(f"{OK} publish popover appears")
                        # check header text
                        title_el = await page.query_selector(".m2s-title")
                        if title_el:
                            title_text = (await title_el.inner_text()).strip()
                            print(f"   popover title: {title_text!r}")
                        await page.screenshot(path=str(SHOTS / "publish_popover.png"), full_page=False)
                        print(f"{OK} saved {SHOTS / 'publish_popover.png'}")

                        # click the team space option (default shared)
                        team_options = await page.query_selector_all(".m2s-item")
                        if team_options:
                            await team_options[0].click()
                            await page.wait_for_timeout(1500)
                            # should navigate to new page
                            cur_url = page.url
                            print(f"   after click URL: {cur_url}")
                            if cur_url != f"http://127.0.0.1:5173/#/p/{draft['id']}":
                                print(f"{OK} navigated away from source draft (expected, goes to new copy)")
                            else:
                                print(f"{NO} still on source draft URL")
                            await page.screenshot(path=str(SHOTS / "publish_after.png"), full_page=False)
                            print(f"{OK} saved {SHOTS / 'publish_after.png'}")
                    else:
                        print(f"{NO} popover did not appear")

        await browser.close()


asyncio.run(main())
