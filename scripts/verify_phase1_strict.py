"""严格 Phase 1 自验收 — 验证数据层、路由、持久化、TypeScript"""
from playwright.sync_api import sync_playwright
import json
import sys

PASS = '[OK]'
FAIL = '[FAIL]'
results = []

def check(label, ok, detail=''):
    sym = PASS if ok else FAIL
    results.append((sym, label, detail))
    print(f'{sym} {label}: {detail}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = context.new_page()

    errors = []
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type == 'error' else None)

    # === 路由验证 ===
    routes_to_test = [
        ('/#/', 'home', '我的知识库'),
        ('/#/p/test-id-that-doesnt-exist', 'read (404 state)', '页面不存在'),
        ('/#/p/test-id/edit', 'edit (404 state)', '未找到页面'),
        ('/#/new', 'new', '新建页面'),
        ('/#/random-unknown', 'not-found', '页面不存在'),
    ]
    for url, name, expected_text in routes_to_test:
        page.goto(f'http://127.0.0.1:5173{url}', wait_until='networkidle')
        page.wait_for_timeout(500)
        body_text = page.locator('body').text_content() or ''
        ok = expected_text in body_text
        check(f'route {url} → {name}', ok, f'expected text "{expected_text}" {"found" if ok else "MISSING"}')

    # === localStorage 验证 ===
    page.goto('http://127.0.0.1:5173/#/', wait_until='networkidle')
    page.wait_for_timeout(800)
    ls = page.evaluate("""
        () => ({
            pages: localStorage.getItem('power-wiki:pages'),
            expanded: localStorage.getItem('power-wiki:tree-expanded'),
            user: localStorage.getItem('power-wiki:user'),
        })
    """)
    check('localStorage has 3 keys', all(v is not None for v in ls.values()),
          f'pages={"yes" if ls["pages"] else "NO"}, expanded={"yes" if ls["expanded"] else "NO"}, user={"yes" if ls["user"] else "NO"}')

    pages = json.loads(ls['pages']) if ls['pages'] else []
    user = json.loads(ls['user']) if ls['user'] else {}

    check('seed pages count = 4', len(pages) == 4, f'actual: {len(pages)}')
    check('all pages have id', all('id' in p and len(p['id']) == 10 for p in pages))
    check('all pages have parentId', all('parentId' in p for p in pages))
    check('has nested structure', any(p['parentId'] is not None for p in pages),
          f'roots: {sum(1 for p in pages if p["parentId"] is None)}, children: {sum(1 for p in pages if p["parentId"])}')
    check('user record correct', user.get('id') == 'me' and user.get('name') == '我', f'actual: {user}')

    # === 持久化验证 ===
    before = json.loads(ls['pages'])
    page.reload(wait_until='networkidle')
    page.wait_for_timeout(800)
    after = page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
    check('data persists after reload', len(before) == len(after), f'before: {len(before)}, after: {len(after)}')

    # === 创建页面验证（通过控制台调用 store API） ===
    created = page.evaluate("""
        () => {
            // 通过 Pinia store 创建新页面
            const app = document.querySelector('#app').__vue_app__
            const pinia = app.config.globalProperties.$pinia
            const stores = pinia._s
            const pagesStore = stores.get('pages')
            const newPage = pagesStore.createPage({ parentId: null, title: '测试页面 A' })
            return { id: newPage.id, title: newPage.title, parentId: newPage.parentId, count: pagesStore.pages.length }
        }
    """)
    check('createPage() works', 'id' in created and len(created.get('id', '')) == 10, f'created: {created}')

    # 验证新页面已经持久化
    after_create = page.evaluate("JSON.parse(localStorage.getItem('power-wiki:pages') || '[]')")
    check('new page persisted', len(after_create) == 5, f'count: {len(after_create)}')

    # === 删除页面验证 ===
    deleted = page.evaluate(f"""
        () => {{
            const app = document.querySelector('#app').__vue_app__
            const pinia = app.config.globalProperties.$pinia
            const pagesStore = pinia._s.get('pages')
            pagesStore.deletePage('{created["id"]}')
            return pagesStore.pages.length
        }}
    """)
    check('deletePage() works', deleted == 4, f'after delete: {deleted}')

    # === 重命名验证 ===
    renamed = page.evaluate(f"""
        () => {{
            const app = document.querySelector('#app').__vue_app__
            const pinia = app.config.globalProperties.$pinia
            const pagesStore = pinia._s.get('pages')
            const firstPage = pagesStore.pages[0]
            pagesStore.renamePage(firstPage.id, '重命名测试')
            return pagesStore.getPage(firstPage.id).title
        }}
    """)
    check('renamePage() works', renamed == '重命名测试', f'after rename: {renamed}')

    # === getTree() 验证 ===
    tree = page.evaluate("""
        () => {
            const app = document.querySelector('#app').__vue_app__
            const pinia = app.config.globalProperties.$pinia
            const pagesStore = pinia._s.get('pages')
            return pagesStore.getTree()
        }
    """)
    check('getTree() returns nested structure', isinstance(tree, list) and len(tree) >= 2,
          f'root count: {len(tree) if isinstance(tree, list) else "NOT LIST"}')
    # 验证至少有一个根有子节点
    has_children = any(len(t.get('children', [])) > 0 for t in tree) if isinstance(tree, list) else False
    check('tree has nested children', has_children, f'tree[0].children: {tree[0].get("children", []) if tree else "empty"}')

    # === 控制台错误 ===
    real_errors = [e for e in errors if 'devtools' not in e.lower()]
    check('no console errors (except Vue DevTools)', len(real_errors) == 0,
          f'{len(real_errors)} errors: {real_errors[:3]}')

    browser.close()

print()
passed = sum(1 for s, _, _ in results if s == PASS)
total = len(results)
print(f'═══ {passed}/{total} checks passed ═══')
if passed != total:
    sys.exit(1)