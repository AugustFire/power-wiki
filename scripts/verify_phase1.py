from playwright.sync_api import sync_playwright

errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type == 'error' else None)

    # 1. Visit home, wait for init
    page.goto('http://127.0.0.1:5173/#/', wait_until='networkidle')
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(1000)

    # 2. Check localStorage keys
    keys = page.evaluate("""
        () => ({
            pages: JSON.parse(localStorage.getItem('power-wiki:pages') || '[]'),
            expanded: JSON.parse(localStorage.getItem('power-wiki:tree-expanded') || '[]'),
            user: JSON.parse(localStorage.getItem('power-wiki:user') || 'null'),
        })
    """)
    print('pages count:', len(keys['pages']))
    print('pages titles:', [p['title'] for p in keys['pages']])
    print('expanded:', keys['expanded'])
    print('user:', keys['user'])

    # 3. Take screenshot of home
    page.screenshot(path='C:/Users/Administrator/Desktop/power-wiki/phase1-home.png')

    # 4. Navigate to a real page
    first_id = keys['pages'][0]['id']
    page.goto(f'http://127.0.0.1:5173/#/p/{first_id}', wait_until='networkidle')
    page.wait_for_timeout(800)
    page.screenshot(path='C:/Users/Administrator/Desktop/power-wiki/phase1-read.png')

    # 5. Navigate to edit
    page.goto(f'http://127.0.0.1:5173/#/p/{first_id}/edit', wait_until='networkidle')
    page.wait_for_timeout(800)
    page.screenshot(path='C:/Users/Administrator/Desktop/power-wiki/phase1-edit.png')

    # 6. Navigate to new page
    page.goto('http://127.0.0.1:5173/#/new', wait_until='networkidle')
    page.wait_for_timeout(800)
    page.screenshot(path='C:/Users/Administrator/Desktop/power-wiki/phase1-new.png')

    # 7. Navigate to not found
    page.goto('http://127.0.0.1:5173/#/non-existent-route', wait_until='networkidle')
    page.wait_for_timeout(800)
    page.screenshot(path='C:/Users/Administrator/Desktop/power-wiki/phase1-notfound.png')

    # 8. Verify localStorage still intact after refresh
    page.goto('http://127.0.0.1:5173/#/', wait_until='networkidle')
    page.wait_for_timeout(800)
    keys_after = page.evaluate("""
        () => JSON.parse(localStorage.getItem('power-wiki:pages') || '[]').length
    """)
    print('pages count after refresh:', keys_after)
    print('Errors:', errors if errors else 'none')

    browser.close()