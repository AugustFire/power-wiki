"""Verify the 3 comment UX fixes:

  1. No circular avatar in the comment list — only the composer keeps one.
  2. Comments reload when navigating between pages (no bleed-through).
  3. Reply / delete are direct icon buttons (no kebab menu).

Run with dev server on 127.0.0.1:5173 + 127.0.0.1:8787.
"""
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

        # ---- setup: sign in as admin, find two team-space pages ----
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "admin@power-wiki.local")
        await page.fill("input[type=password]", "admin123")
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(500)
        print(f"{OK} admin signed in")

        spaces_resp = await api.get("http://127.0.0.1:8787/api/spaces")
        spaces = json.loads(await spaces_resp.text())
        if isinstance(spaces, dict) and "items" in spaces:
            spaces = spaces["items"]
        team_space = next((s for s in spaces if s.get("kind") == "shared"), None)
        assert team_space is not None, "no team space"
        team_space_id = team_space["id"]
        print(f"{OK} team space: {team_space['name']} ({team_space_id})")

        pages_resp = await api.get(
            f"http://127.0.0.1:8787/api/pages?space={team_space_id}&limit=50"
        )
        pages = json.loads(await pages_resp.text())
        items = pages.get("items", pages) if isinstance(pages, dict) else pages
        if len(items) < 2:
            # create two test pages in team space
            for i in range(2 - len(items)):
                body = {
                    "spaceId": team_space_id,
                    "parentId": None,
                    "title": f"verify comment ux #{i+1}",
                    "contentJSON": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "..."}]}]},
                    "contentHTML": "<p>...</p>",
                }
                r = await api.post(
                    "http://127.0.0.1:8787/api/pages",
                    data=json.dumps(body),
                    headers={"content-type": "application/json"},
                )
                assert r.status == 201, await r.text()
            pages_resp = await api.get(
                f"http://127.0.0.1:8787/api/pages?space={team_space_id}&limit=50"
            )
            pages = json.loads(await pages_resp.text())
            items = pages.get("items", pages) if isinstance(pages, dict) else pages
        page_a, page_b = items[0], items[1]
        page_id_a, page_id_b = page_a["id"], page_b["id"]
        print(f"{OK} page A: {page_a['title']} ({page_id_a})")
        print(f"{OK} page B: {page_b['title']} ({page_id_b})")

        # post a distinct comment on each page so we can detect bleed-through
        ts = int(asyncio.get_event_loop().time() * 1000)
        marker_a = f"A-only-marker-{ts}"
        marker_b = f"B-only-marker-{ts}"
        for pid, marker in [(page_id_a, marker_a), (page_id_b, marker_b)]:
            r = await api.post(
                "http://127.0.0.1:8787/api/comments",
                data=json.dumps({"pageId": pid, "contentMd": marker}),
                headers={"content-type": "application/json"},
            )
            assert r.status in (200, 201), await r.text()
        print(f"{OK} posted distinct markers to A and B")

        # ---- navigate to page A ----
        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id_a}")
        await page.wait_for_selector(".comments-section", timeout=10000)
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(SHOTS / "comment_ux_page_a.png"), full_page=False)

        # ---- check 1: no avatar in list ----
        a_items = await page.query_selector_all(".comments-section .comment-item")
        if not a_items:
            print(f"{NO} no comment items rendered on page A")
            return
        avatar_in_list = await page.query_selector(".comment-item .ci-avatar")
        avatar_in_composer = await page.query_selector(".comment-composer .cc-avatar")
        avatar_in_user_menu = await page.query_selector(".user-menu .cc-avatar")
        if avatar_in_list:
            print(f"{NO} .ci-avatar still in list — should be removed")
        else:
            print(f"{OK} no .ci-avatar in the list")
        if avatar_in_composer:
            print(f"{OK} composer keeps avatar ({await avatar_in_composer.evaluate('e => e.outerHTML.slice(0,80)')})")
        else:
            print(f"{NO} composer avatar missing — should be kept per spec")

        # ---- check 3: reply / delete are icon buttons ----
        # Look for icon-btn (not the old kebab / menu pattern)
        icon_btns = await page.query_selector_all(".comment-item .ci-icon-btn")
        kebabs = await page.query_selector_all(".comment-item .ci-kebab")
        menues = await page.query_selector_all(".comment-item .ci-menu")
        text_reply = await page.query_selector(".comment-item .ci-reply-btn")
        print(f"   icon_btns={len(icon_btns)}, kebabs={len(kebabs)}, menus={len(menues)}, old_reply_text={text_reply is not None}")
        if icon_btns and not kebabs and not menues and not text_reply:
            print(f"{OK} reply/delete are direct icon buttons (no kebab menu)")
        else:
            print(f"{NO} still has kebab/menu/text-reply alongside icons")
        # also check the icon is material-symbols-outlined
        for ib in icon_btns[:3]:
            html = await ib.inner_html()
            if "material-symbols-outlined" not in html:
                print(f"{NO} icon button missing material-symbols-outlined icon")
                break
        else:
            if icon_btns:
                print(f"{OK} icon buttons use material-symbols-outlined")

        # page A should show marker_a, NOT marker_b
        a_text = await page.eval_on_selector_all(
            ".comment-item .ci-text", "(els) => els.map(e => e.textContent).join('\\n')"
        )
        if marker_a in a_text:
            print(f"{OK} page A shows A-only marker (no B bleed)")
        else:
            print(f"{NO} page A does NOT show A marker. text={a_text!r}")
        if marker_b in a_text:
            print(f"{NO} page A bleeds B's marker — BUG NOT FIXED")
        else:
            print(f"{OK} page A does not bleed B's marker")

        # ---- check 2: switch to page B, comments should follow ----
        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id_b}")
        # Force a re-render by waiting for the section to mount; if the watch
        # is broken, the items from page A would still render here.
        await page.wait_for_timeout(800)
        # navigate again (router-link style) and wait for the comment list
        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id_b}")
        await page.wait_for_selector(".comments-section", timeout=10000)
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SHOTS / "comment_ux_page_b.png"), full_page=False)

        b_items = await page.query_selector_all(".comments-section .comment-item")
        b_text = await page.eval_on_selector_all(
            ".comment-item .ci-text", "(els) => els.map(e => e.textContent).join('\\n')"
        )
        if b_items:
            print(f"{OK} page B rendered {len(b_items)} comment item(s)")
        else:
            print(f"{NO} page B has no comment items rendered (might be empty initial state)")
        if marker_b in b_text:
            print(f"{OK} page B shows B-only marker")
        else:
            print(f"{NO} page B does NOT show B marker. text={b_text!r}")
        if marker_a in b_text:
            print(f"{NO} page B shows A's marker — watch did not clear/refetch")
        else:
            print(f"{OK} page B does not bleed A's marker")

        # ---- now test the icon buttons on page B (we created B's comment as admin) ----
        # The reply button should be visible (top-level) and so should delete (admin)
        # Click reply icon → composer should appear
        b_first = await page.query_selector(".comment-item")
        if b_first:
            reply_btn = await b_first.query_selector(".ci-icon-btn")
            delete_btn = await b_first.query_selector(".ci-icon-btn-danger")
            if reply_btn and delete_btn:
                print(f"{OK} both reply + delete icon buttons visible on page B")
            else:
                print(f"{NO} icon buttons missing. reply={reply_btn is not None}, delete={delete_btn is not None}")
            # click reply — composer for the reply should render
            await reply_btn.click()
            await page.wait_for_timeout(400)
            reply_composer = await page.query_selector(".comment-item .ci-reply-composer")
            if reply_composer:
                print(f"{OK} click reply icon → reply composer renders")
                await page.screenshot(
                    path=str(SHOTS / "comment_ux_reply_open.png"), full_page=False
                )
            else:
                print(f"{NO} reply composer did not appear")
            # click delete icon → custom confirm dialog should appear (no native dialog)
            confirm_fired = False
            page.once("dialog", lambda d: asyncio.create_task(_on_dialog(d, lambda: set_flag())))
            def set_flag():
                nonlocal confirm_fired
                confirm_fired = True

            # easier: just listen for native dialog and capture
            fired_box = {"fired": False}
            async def capture_dialog(d):
                fired_box["fired"] = True
                print(f"{NO} native confirm dialog: {d.message!r}")
                try:
                    await d.dismiss()
                except Exception:
                    pass
            page.on("dialog", lambda d: asyncio.create_task(capture_dialog(d)))

            # click reply again to close, then click delete
            await reply_btn.click()
            await page.wait_for_timeout(300)
            # we deleted B's comment before, so it might still be there or not
            # re-query delete button
            delete_btn2 = await page.query_selector(".comment-item .ci-icon-btn-danger")
            if delete_btn2:
                await delete_btn2.click()
                await page.wait_for_timeout(500)
                dialog = await page.query_selector(".confirm-dialog")
                if dialog:
                    title = await (await dialog.query_selector(".confirm-title")).inner_text()
                    print(f"{OK} delete icon → custom confirm dialog: {title!r}")
                else:
                    print(f"{NO} delete icon → no custom confirm dialog")
                if fired_box["fired"]:
                    print(f"{NO} native confirm dialog fired")
                else:
                    print(f"{OK} native confirm dialog NOT used")
                await page.screenshot(
                    path=str(SHOTS / "comment_ux_delete_confirm.png"), full_page=False
                )

        # ---- cleanup ----
        # delete all comments we posted
        for pid, marker in [(page_id_a, marker_a), (page_id_b, marker_b)]:
            r = await api.get(f"http://127.0.0.1:8787/api/comments?pageId={pid}")
            d = json.loads(await r.text())
            items = d.get("items", d)
            for c in items:
                if marker in c.get("contentMd", ""):
                    await api.delete(f"http://127.0.0.1:8787/api/comments/{c['id']}")

        await browser.close()


async def _on_dialog(d, cb):
    cb()


asyncio.run(main())
