"""Verify TOC appears in EditView with editor headings."""
import asyncio
import json
import sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).parent
SHOTS = ROOT / "screenshots"
SHOTS.mkdir(exist_ok=True)

# ASCII-only output for Windows console
OK = "[OK]"
NO = "[FAIL]"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 2560, "height": 1440})
        page = await ctx.new_page()

        # 1. login
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "admin@power-wiki.local")
        await page.fill("input[type=password]", "admin123")
        await page.click("button[type=submit]")
        # hash router: wait for URL to change off /login
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(500)
        print(f"{OK} logged in (now at {page.url})")

        # 2. find a page in default space cgpquwn63u and open it for edit
        api = page.request
        pages_resp = await api.get("http://127.0.0.1:8787/api/pages?space=cgpquwn63u")
        raw = await pages_resp.text()
        print(f"API status={pages_resp.status} body[:200]={raw[:200]}")
        body_data = json.loads(raw)
        pages = body_data.get("items", body_data) if isinstance(body_data, dict) else body_data
        target = None
        for pg in pages:
            if isinstance(pg, dict) and pg.get("title") == "color-test":
                target = pg
                break
        if not target:
            # create one with 3 headings
            body = {
                "spaceId": "cgpquwn63u",
                "title": "toc-test",
                "parentId": None,
                "contentHTML": "<h2>First heading</h2><p>x</p><h2>Second heading</h2><h3>Third heading</h3>",
                "contentJSON": {
                    "type": "doc",
                    "content": [
                        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "First heading"}]},
                        {"type": "paragraph", "content": [{"type": "text", "text": "x"}]},
                        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Second heading"}]},
                        {"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "Third heading"}]},
                    ],
                },
            }
            create = await api.post("http://127.0.0.1:8787/api/pages", data=json.dumps(body), headers={"content-type": "application/json"})
            target = await create.json()
        page_id = target["id"]
        print(f"[OK] target page: {target['title']} (id={page_id})")

        # 2b. PATCH additional headings so we can verify TOC updates
        patch_body = {
            "contentHTML": "<h2>First heading</h2><p>x</p><h2>Second heading</h2><h3>Third heading</h3>",
            "contentJSON": {
                "type": "doc",
                "content": [
                    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "First heading"}]},
                    {"type": "paragraph", "content": [{"type": "text", "text": "x"}]},
                    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Second heading"}]},
                    {"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "Third heading"}]},
                ],
            },
        }
        patch = await api.patch(f"http://127.0.0.1:8787/api/pages/{page_id}", data=json.dumps(patch_body), headers={"content-type": "application/json"})
        patch_text = await patch.text()
        print(f"[OK] PATCH status={patch.status} body[:300]={patch_text[:300]}")

        # verify GET shows new content
        get_after = await api.get(f"http://127.0.0.1:8787/api/pages/{page_id}")
        after = json.loads(await get_after.text())
        print(f"[debug] after PATCH, contentHTML[:200]={after.get('contentHTML','')[:200]}")

        # 3. open edit view — but first reload the page so the in-memory
        # pages store re-fetches from the API (raw HTTP PATCH above
        # bypassed the store)
        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id}/edit")
        await page.reload()
        await page.wait_for_selector(".ProseMirror", timeout=10000)
        # let the editor settle
        await page.wait_for_timeout(2000)

        # 4. check TOC items
        toc_items = await page.query_selector_all(".toc-item")
        print(f"TOC items: {len(toc_items)}")
        for it in toc_items:
            text = (await it.inner_text()).strip()
            cls = await it.get_attribute("class")
            print(f"  - {text!r} class={cls}")

        # 5. screenshot
        await page.screenshot(path=str(SHOTS / "edit_toc.png"), full_page=False)
        print(f"[OK] saved {SHOTS / 'edit_toc.png'}")

        # 6. test click on TOC item scrolls/activates
        if len(toc_items) >= 2:
            await toc_items[1].click()
            await page.wait_for_timeout(500)
            active = await page.query_selector(".toc-item.active")
            if active:
                active_text = (await active.inner_text()).strip()
                print(f"[OK] click activated: {active_text!r}")
            else:
                print("[FAIL] no active item after click")
            await page.screenshot(path=str(SHOTS / "edit_toc_clicked.png"), full_page=False)
        else:
            print("[FAIL] not enough TOC items to test click")

        # 7. dynamic update test: type a new heading in the editor and check TOC adds it
        editor = await page.query_selector(".ProseMirror")
        if editor:
            await editor.click()
            # move to end of document
            await page.keyboard.press("Control+End")
            await page.keyboard.press("Enter")
            # type ## at start to convert paragraph to h2
            await page.keyboard.type("## Dynamic heading")
            await page.wait_for_timeout(1500)
            new_toc = await page.query_selector_all(".toc-item")
            texts = [(await it.inner_text()).strip() for it in new_toc]
            print(f"TOC after dynamic edit: {texts}")
            if "Dynamic heading" in texts:
                print("[OK] TOC picked up new heading dynamically")
            else:
                print(f"[FAIL] Dynamic heading not in TOC; got {texts}")
            await page.screenshot(path=str(SHOTS / "edit_toc_dynamic.png"), full_page=False)

        await browser.close()


asyncio.run(main())
