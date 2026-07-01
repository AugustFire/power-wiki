"""Verify the mention popover UX:
  1. No ugly "black border" — the tippy-box chrome is clean
  2. Search input is present, auto-focused, prefilled with the @-query
  3. Typing in the search input filters the candidate list
  4. Enter selects and inserts the mention chip
  5. Esc closes the popover

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

        # ---- setup: sign in as admin, find a personal page to edit ----
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "admin@power-wiki.local")
        await page.fill("input[type=password]", "admin123")
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(500)
        print(f"{OK} admin signed in")

        # Use admin's personal space (admin can read but not write — they need
        # a team-space page to edit, or any space they can write to). Actually
        # the personalSpaceGuard blocks admin from writing personal space. So
        # we need a team/shared page. Let's find one in the default space.
        spaces_resp = await api.get("http://127.0.0.1:8787/api/spaces")
        spaces = json.loads(await spaces_resp.text())
        if isinstance(spaces, dict) and "items" in spaces:
            spaces = spaces["items"]
        # Find a non-personal space (admin can write team spaces? actually admin
        # can write anywhere except personal). Let's check the page list.
        pages_resp = await api.get("http://127.0.0.1:8787/api/pages?limit=10")
        d = json.loads(await pages_resp.text())
        items = d.get("items", d) if isinstance(d, dict) else d
        # Pick the first page; we'll test in its edit view
        target = items[0]
        page_id = target["id"]
        print(f"{OK} picked page: {target['title']} ({page_id})")

        # Go to edit mode
        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id}/edit")
        await page.wait_for_selector(".tiptap", timeout=10000)
        await page.wait_for_timeout(800)
        # Focus the editor and place cursor at end
        await page.click(".tiptap")
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")

        # ---- trigger @ mention ----
        await page.keyboard.type("@")
        # Wait for popover
        popover = await page.wait_for_selector(".mention-suggestion-host", timeout=5000)
        print(f"{OK} mention popover appeared after typing @")
        await page.wait_for_timeout(400)  # initial fetch settles
        await page.screenshot(path=str(SHOTS / "mention_popover_open.png"), full_page=False)

        # ---- check 1: no "black border" from tippy default theme ----
        # The tippy-box should be themed `pw-mention` and have no dark border
        tippy_box = await page.query_selector(".tippy-box[data-theme~='pw-mention']")
        tippy_default = await page.query_selector(".tippy-box:not([data-theme])")
        if tippy_box and not tippy_default:
            print(f"{OK} tippy-box uses 'pw-mention' theme (no default light-border)")
        else:
            print(f"{NO} tippy default theme still in use: pw={tippy_box is not None}, default={tippy_default is not None}")
        # Also check the popover has no `outline` or harsh border
        border_info = await page.evaluate(
            """
            () => {
                const host = document.querySelector('.mention-suggestion-host');
                if (!host) return null;
                const cs = getComputedStyle(host);
                return {
                    borderTop: cs.borderTop,
                    borderRight: cs.borderRight,
                    borderBottom: cs.borderBottom,
                    borderLeft: cs.borderLeft,
                    boxShadow: cs.boxShadow.slice(0, 80),
                    background: cs.backgroundColor,
                };
            }
            """
        )
        print(f"   popover computed: {border_info}")
        if border_info:
            # We expect a 1px solid border using --border token (#DFE1E6, light gray)
            # and a shadow, NOT a 1px #000 hard border.
            if "rgb(0, 0, 0)" in border_info["borderTop"] or "rgb(0, 0, 0)" in border_info["borderRight"]:
                print(f"{NO} popover still has BLACK border")
            elif "rgb(223, 225, 230)" in border_info["borderTop"] or "#DFE1E6" in border_info["borderTop"]:
                print(f"{OK} popover has light gray token border (#DFE1E6)")
            else:
                print(f"   popover border: {border_info['borderTop']}")

        # ---- check 2: search input present, auto-focused, pre-filled ----
        search_input = await page.query_selector(".mention-search")
        if not search_input:
            print(f"{NO} no search input in popover")
            return
        is_focused = await page.evaluate(
            "() => document.activeElement && document.activeElement.classList.contains('mention-search')"
        )
        if is_focused:
            print(f"{OK} search input is auto-focused")
        else:
            print(f"{NO} search input is NOT focused (activeElement is {await page.evaluate('() => document.activeElement?.tagName + (document.activeElement?.className ? \".\" + document.activeElement.className : \"\")')})")
        # The prefill should be empty (we just typed @)
        value = await search_input.input_value()
        print(f"   search input value: {value!r}")

        # ---- check 3: typing filters the list ----
        # First capture the initial list
        initial_rows = await page.query_selector_all(".mention-suggestion-list .mention-row")
        print(f"   initial candidate count: {len(initial_rows)}")
        if initial_rows:
            for r in initial_rows[:3]:
                name = await r.query_selector(".name")
                if name:
                    print(f"     - {(await name.inner_text())!r}")
        # Type a query to filter
        await page.keyboard.type("ad")  # should match "Admin"
        await page.wait_for_timeout(400)  # debounced fetch + re-render
        filtered_rows = await page.query_selector_all(".mention-suggestion-list .mention-row")
        filtered_empty = await page.query_selector(".mention-suggestion-list .mention-empty")
        print(f"   after typing 'ad': {len(filtered_rows)} row(s) (empty msg: {filtered_empty is not None})")
        if filtered_rows:
            for r in filtered_rows[:5]:
                name = await r.query_selector(".name")
                if name:
                    print(f"     - {(await name.inner_text())!r}")
        await page.screenshot(path=str(SHOTS / "mention_popover_search.png"), full_page=False)

        # Filter to something that should give zero matches
        await page.keyboard.type("xyzzy_nomatch")
        await page.wait_for_timeout(400)
        empty = await page.query_selector(".mention-suggestion-list .mention-empty")
        if empty:
            print(f"{OK} empty state shown when no matches")
        else:
            print(f"{NO} no empty state for unmatched query")
        await page.screenshot(path=str(SHOTS / "mention_popover_empty.png"), full_page=False)

        # ---- check 4: Esc closes the popover ----
        # Clear search first
        await page.keyboard.press("Backspace")
        for _ in range(15):
            await page.keyboard.press("Backspace")
        await page.wait_for_timeout(300)
        # type something valid
        await page.keyboard.type("ad")
        await page.wait_for_timeout(400)
        # press Enter to select the first row
        # The active row should be the first match. We need to find the active row.
        active_row = await page.query_selector(".mention-row.is-active")
        if not active_row:
            # Sometimes index 0 isn't applied yet; force arrow down to set
            await page.keyboard.press("ArrowDown")
            await page.wait_for_timeout(100)
            active_row = await page.query_selector(".mention-row.is-active")
        if active_row:
            name = await (await active_row.query_selector(".name")).inner_text()
            print(f"   active row before Enter: {name!r}")
        # Press Enter
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(500)
        # Popover should be gone
        still_open = await page.query_selector(".mention-suggestion-host")
        if still_open:
            print(f"{NO} popover still open after Enter")
        else:
            print(f"{OK} popover closed after Enter")
        # Mention chip should be in the editor
        chip = await page.query_selector(".tiptap .mention-chip")
        if chip:
            print(f"{OK} mention chip inserted: '{(await chip.inner_text())!r}'")
        else:
            print(f"{NO} no mention chip in editor after Enter")
        await page.screenshot(path=str(SHOTS / "mention_chip_inserted.png"), full_page=False)

        # ---- check 5: re-trigger and Esc closes ----
        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await page.keyboard.type("@a")
        await page.wait_for_selector(".mention-suggestion-host", timeout=5000)
        await page.wait_for_timeout(300)
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)
        still = await page.query_selector(".mention-suggestion-host")
        if still:
            print(f"{NO} popover still open after Esc")
        else:
            print(f"{OK} Esc closes the popover")

        await browser.close()


asyncio.run(main())
