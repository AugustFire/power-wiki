"""Verify the two UX fixes:

  1. Read-mode TOC entries have no leading `#` (was leaking the heading
     anchor's textContent).
  2. Logout handoff shows the auth-boot spinner instead of flashing a
     blank page (authStore.transitioning is set during the handoff and
     App.vue's showBoot is now gated only on `transitioning`, not also
     on `isAuthed`).

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

        # ---- setup: sign in as admin ----
        await page.goto("http://127.0.0.1:5173/#/login")
        await page.wait_for_selector("input[type=email]", timeout=10000)
        await page.fill("input[type=email]", "admin@power-wiki.local")
        await page.fill("input[type=password]", "admin123")
        await page.click("button[type=submit]")
        await page.wait_for_function("() => !location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(500)
        print(f"{OK} admin signed in")

        # ---- part 1: TOC # check ----
        # find a page with multiple h2/h3 headings
        spaces_resp = await api.get("http://127.0.0.1:8787/api/spaces")
        spaces = json.loads(await spaces_resp.text())
        if isinstance(spaces, dict) and "items" in spaces:
            spaces = spaces["items"]
        # Prefer "默认空间" (cgpquwn63u) which has many seed pages with headings
        team = next((s for s in spaces if s.get("id") == "cgpquwn63u"), None) or next(
            (s for s in spaces if s.get("kind") == "shared"), None
        )
        assert team is not None, "no team space"
        pages_resp = await api.get(
            f"http://127.0.0.1:8787/api/pages?space={team['id']}&limit=50"
        )
        pages = json.loads(await pages_resp.text())
        items = pages.get("items", pages) if isinstance(pages, dict) else pages
        # pick the first page that has h2/h3 in its contentHTML
        target = None
        for p_meta in items:
            html = p_meta.get("contentHTML", "") or ""
            if "<h2" in html or "<h3" in html:
                target = p_meta
                break
        if not target:
            print(f"{NO} no page with h2/h3 found in default space")
            return
        page_id = target["id"]
        print(f"{OK} picked page with headings: {target['title']} ({page_id})")

        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id}")
        await page.wait_for_selector(".toc-panel", timeout=10000)
        # wait for headings to be collected
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SHOTS / "toc_no_hash.png"), full_page=False)

        toc_items = await page.query_selector_all(".toc-panel .toc-item")
        if not toc_items:
            # TOC may be empty if no h2/h3 in saved HTML. Check.
            empty = await page.query_selector(".toc-empty")
            if empty:
                print(f"{NO} TOC is empty: {(await empty.inner_text())!r}")
            else:
                print(f"{NO} no TOC items rendered")
            return
        print(f"   {len(toc_items)} TOC entries:")
        bad = []
        for it in toc_items:
            txt = (await it.inner_text()).strip()
            level = await it.get_attribute("class")
            print(f"     {level}: {txt!r}")
            if txt.startswith("#"):
                bad.append(txt)
        if bad:
            print(f"{NO} TOC entries still start with #: {bad}")
        else:
            print(f"{OK} all {len(toc_items)} TOC entries are clean (no leading #)")

        # Also confirm the in-page headings still have the # anchor (for copy-on-click),
        # and that it's only visible on hover (we won't check the hover state here,
        # just verify the anchor exists).
        anchor_count = await page.eval_on_selector_all(
            ".read-content a.heading-anchor",
            "(els) => els.length",
        )
        if anchor_count > 0:
            print(f"{OK} page body still has {anchor_count} heading anchor(s) (copy-link works)")
        else:
            print(f"[WARN] no heading anchors found in read-content — addHeadingAnchors may not have run")

        # ---- part 2: logout flash check ----
        # Navigate to a page with content so we have an "authed view" to
        # potentially flash blank from.
        await page.goto(f"http://127.0.0.1:5173/#/p/{page_id}")
        await page.wait_for_selector(".toc-panel", timeout=10000)
        await page.wait_for_timeout(800)

        # Open the user menu and click 登出. We sample DOM state during the
        # handoff to verify the boot overlay is shown, not a blank page.
        print(f"\n{OK} starting logout sequence")

        # Pre-open the user menu
        await page.click(".um-trigger")
        await page.wait_for_selector(".um-popover", timeout=3000)

        # Listen for DOM mutations to capture state transitions
        observed_states = []
        async def on_console(msg):
            if msg.type == "log":
                observed_states.append(msg.text)
        page.on("console", on_console)

        # Install a small probe to record the visible state of the app
        # shell at each animation frame during the handoff.
        await page.evaluate(
            """
            window.__logoutFrames = [];
            let stop = false;
            function tick() {
                if (stop) return;
                const boot = document.querySelector('.auth-boot');
                const shell = document.querySelector('.app-shell');
                const login = document.querySelector('.login-page, .reset-page');
                const root = document.querySelector('.tiptap, .read-content, .home-view, .page-tree');
                window.__logoutFrames.push({
                    ts: performance.now(),
                    boot: !!boot,
                    shell: !!shell,
                    login: !!login,
                    content: !!root,
                });
                requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
            window.__stopProbe = () => { stop = true; };
            """
        )

        # Click 登出
        logout_btn = await page.query_selector(".um-item.danger")
        if not logout_btn:
            print(f"{NO} logout button missing")
            return
        await logout_btn.click()
        # Wait until the route settles to /login
        await page.wait_for_function("() => location.hash.startsWith('#/login')", timeout=10000)
        await page.wait_for_timeout(300)
        # Stop the probe
        await page.evaluate("() => window.__stopProbe()")
        frames = await page.evaluate("() => window.__logoutFrames")
        print(f"   captured {len(frames)} frames during logout handoff")

        # Analyze: we want to see the auth-boot was visible at some point
        # during the handoff (after the authed shell unmounts and before
        # LoginView mounts). We tolerate LoginView appearing at the tail.
        shell_visible_after_boot = 0
        boot_visible_count = 0
        blank_count = 0
        for f in frames:
            if f["shell"]:
                shell_visible_after_boot += 1
            if f["boot"]:
                boot_visible_count += 1
            # "blank" = no boot, no shell, no login, no authed content
            if not f["boot"] and not f["shell"] and not f["login"] and not f["content"]:
                blank_count += 1

        # Find the frames during the actual handoff: from when the user
        # clicked (shell was visible) to when login settled (login is
        # visible, no shell). We expect the boot to be visible somewhere
        # in that window.
        handoff_start = None
        for i, f in enumerate(frames):
            if f["shell"] and not f["boot"]:
                handoff_start = i
                break
        handoff_end = None
        for i, f in enumerate(frames):
            if f["login"] and not f["shell"]:
                handoff_end = i
                break
        if handoff_start is None or handoff_end is None:
            print(f"[WARN] could not pinpoint handoff window (shell→login)")
            print(f"   first frame: {frames[0] if frames else None}")
            print(f"   last  frame: {frames[-1] if frames else None}")
        else:
            print(f"   handoff window: frames {handoff_start}..{handoff_end}")
            in_window = frames[handoff_start:handoff_end + 1]
            boot_in_window = sum(1 for f in in_window if f["boot"])
            blank_in_window = sum(
                1 for f in in_window
                if not f["boot"] and not f["shell"] and not f["login"] and not f["content"]
            )
            print(f"   boot visible in {boot_in_window}/{len(in_window)} frames")
            print(f"   blank in {blank_in_window}/{len(in_window)} frames")
            if boot_in_window > 0 and blank_in_window == 0:
                print(f"{OK} logout handoff shows auth-boot spinner, no blank frame")
            elif blank_in_window == 0:
                print(f"{OK} no blank frame (boot may have been too fast to sample)")
            else:
                print(f"{NO} blank frame(s) observed during logout handoff")

        # Final state
        cur = await page.evaluate(
            "() => ({ url: location.href, hasLogin: !!document.querySelector('.login-page'), hasBoot: !!document.querySelector('.auth-boot') })"
        )
        print(f"   final state: {cur}")
        if cur["hasLogin"] and "/login" in cur["url"]:
            print(f"{OK} ended on /login with LoginView visible")
        else:
            print(f"{NO} did not end on /login")

        await page.screenshot(path=str(SHOTS / "logout_final.png"), full_page=False)

        await browser.close()


asyncio.run(main())
