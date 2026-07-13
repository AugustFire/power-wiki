"""
verify_md_import.py — 新功能验收:从 Markdown 导入成新页。

覆盖(全 API 层面,前端 modal 走 Playwright 在 verify_md_import_ui.py
另测,这里只测后端契约):
  1. paste 模式基本落地:返回 created 不为空 + 标题 = H1 解析值
  2. 标题 fallback:无 H1 时用 filename 去后缀
  3. duplicate_title:同 (spaceId, parentId, title) 二次提交 → skipped
  4. empty:trim 后空字符串 → skipped.reason = 'empty'
  5. image 清洗:`![alt](url)` 不进 contentJSON,alt 文字保留为可读 content
  6. markdown 块结构:# / paragraph / list 都能正确解析
  7. parentId 不为空时落到指定 sibling 组末尾(基于 sortOrder MAX+1)
  8. admin 写 personal space → 403 (依赖既有 assertAdminNotWritingPersonalSpace)

Setup:用 happy@gmail.com(非 admin,避免个人空间 403 路径)登录,
在 personal space 下做所有 case。每次创建用唯一前缀防止重名。
"""
from __future__ import annotations

import json
import http.cookiejar
import urllib.request
import urllib.error
import sys
import time
from typing import Any

BASE = "http://127.0.0.1:5173"
API = "http://127.0.0.1:8787"
USER_EMAIL = "happy@gmail.com"
USER_PASSWORD = "happy123"

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    mark = "OK  " if ok else "FAIL"
    print(f"  [{mark}] {name}{(': ' + detail) if detail else ''}")


def login_cookie() -> dict:
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    req = urllib.request.Request(
        f"{API}/api/auth/sign-in",
        data=json.dumps({"email": USER_EMAIL, "password": USER_PASSWORD}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    opener.open(req).read()
    return {"Cookie": "; ".join(f"{c.name}={c.value}" for c in cj)}


def request_json(method: str, path: str, headers: dict, body: Any = None) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        headers={**headers, "content-type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def get_default_space(headers: dict) -> str:
    """取用户的 personal space id(默认 active)。"""
    code, data = request_json("GET", "/api/spaces?active=1", headers)
    assert code == 200, f"GET /spaces: {code} {data}"
    for sp in data.get("items", []):
        if sp.get("kind") == "personal":
            return sp["id"]
    raise RuntimeError("no personal space found")


def import_page(headers: dict, payload: dict) -> tuple[int, Any]:
    return request_json("POST", "/api/pages/import", headers, payload)


def delete_page(headers: dict, page_id: str) -> None:
    """删除创建出来的页,保证 rerun 不污染。"""
    request_json("DELETE", f"/api/pages/{page_id}", headers)


def main() -> int:
    headers = login_cookie()
    space_id = get_default_space(headers)
    prefix = f"verify-md-import-{int(time.time())}"

    # ─── 1. paste + H1 → 标题 = H1 ───
    title1 = f"{prefix}-h1"
    payload = {
        "source": "paste",
        "text": f"# {title1}\n\nHello world body.",
        "spaceId": space_id,
    }
    code, body = import_page(headers, payload)
    ok = code == 201 and body.get("created") and body["created"]["title"] == title1
    record(
        "1. paste + H1 → title from H1",
        ok,
        f"code={code} title={body.get('created', {}).get('title') if body.get('created') else None}",
    )
    if body.get("created"):
        delete_page(headers, body["created"]["id"])

    # ─── 2. 无 H1,filename fallback ───
    title2 = f"{prefix}-filename"
    payload = {
        "source": "file",
        "text": "body without h1\n\njust paragraphs.",
        "spaceId": space_id,
        "filename": f"{title2}.md",
    }
    code, body = import_page(headers, payload)
    ok = code == 201 and body.get("created") and body["created"]["title"] == title2
    record(
        "2. no H1 + filename → title from filename (stripped .md)",
        ok,
        f"code={code} title={body.get('created', {}).get('title') if body.get('created') else None}",
    )
    if body.get("created"):
        delete_page(headers, body["created"]["id"])

    # ─── 3. duplicate_title → skipped ───
    dup_title = f"{prefix}-dup"
    payload = {
        "source": "paste",
        "text": f"# {dup_title}\n\nfirst body",
        "spaceId": space_id,
    }
    code1, body1 = import_page(headers, payload)
    # 第二次同标题
    payload2 = {
        "source": "paste",
        "text": f"# {dup_title}\n\nsecond body",
        "spaceId": space_id,
    }
    code2, body2 = import_page(headers, payload2)
    ok = (
        code1 == 201
        and code2 == 201
        and body1.get("created")
        and body2.get("skipped")
        and body2["skipped"]["reason"] == "duplicate_title"
    )
    record(
        "3. duplicate title → skipped reason='duplicate_title'",
        ok,
        f"first created={bool(body1.get('created'))} second skipped.reason={body2.get('skipped', {}).get('reason')}",
    )
    if body1.get("created"):
        delete_page(headers, body1["created"]["id"])

    # ─── 4. empty text → skipped reason='empty' ───
    empty_title = f"{prefix}-empty"
    payload = {
        "source": "paste",
        "text": "   \n\n   ",
        "spaceId": space_id,
        "filename": empty_title,
    }
    code, body = import_page(headers, payload)
    ok = code == 201 and body.get("skipped") and body["skipped"]["reason"] == "empty"
    record(
        "4. empty trimmed text → skipped reason='empty'",
        ok,
        f"code={code} skipped.reason={body.get('skipped', {}).get('reason')}",
    )

    # ─── 5. image stripping ───
    img_title = f"{prefix}-img"
    payload = {
        "source": "paste",
        "text": f"# {img_title}\n\nbefore ![Alt Text](http://x.com/1.png) after\n\n![](http://x.com/no-alt.png)\n\nmore body.",
        "spaceId": space_id,
    }
    code, body = import_page(headers, payload)
    created = body.get("created")
    ok = False
    detail = ""
    if code == 201 and created:
        # 校验 contentJSON 中没有 type='image' 节点
        content = created.get("contentJSON", {})
        has_image = False
        has_alt_text = False
        def walk(node: Any) -> None:
            nonlocal has_image, has_alt_text
            if isinstance(node, dict):
                if node.get("type") == "image":
                    has_image = True
                # 检查 inline text 是否含 "Alt Text"(剥离后变 *Alt Text*)
                for c in node.get("content", []) or []:
                    if isinstance(c, dict) and isinstance(c.get("text"), str):
                        if "Alt Text" in c["text"]:
                            has_alt_text = True
                for c in node.get("content", []) or []:
                    walk(c)
            elif isinstance(node, list):
                for x in node:
                    walk(x)
        walk(content)
        ok = (not has_image) and has_alt_text
        detail = f"has_image={has_image} has_alt_text={has_alt_text}"
    record("5. image syntax stripped, alt preserved as text", ok, detail)
    if created:
        delete_page(headers, created["id"])

    # ─── 6. markdown block structures (h1 + paragraph + list) ───
    struct_title = f"{prefix}-struct"
    payload = {
        "source": "paste",
        "text": f"# {struct_title}\n\nintro paragraph.\n\n- item one\n- item two\n- item three\n\n```js\nconst x = 1\n```\n",
        "spaceId": space_id,
    }
    code, body = import_page(headers, payload)
    ok = False
    detail = ""
    if code == 201 and body.get("created"):
        tiptap = body["created"].get("contentJSON", {})
        # 简单检查 doc.content 含有 heading / paragraph / bulletList 节点
        types = set()
        def collect_types(node: Any) -> None:
            if isinstance(node, dict):
                t = node.get("type")
                if t:
                    types.add(t)
                for c in node.get("content", []) or []:
                    collect_types(c)
            elif isinstance(node, list):
                for x in node:
                    collect_types(x)
        collect_types(tiptap)
        ok = {"heading", "paragraph", "bulletList", "codeBlock"}.issubset(types)
        detail = f"types={sorted(types)}"
        # 同步校验 contentHTML 是真 HTML(不是 raw MD),ReadView 才认
        html = body["created"]["contentHTML"] if body.get("created") else ""
        html_ok = (
            "<h1>" in html
            and "<p>" in html
            and "<ul>" in html
            and "<li>" in html
            and "<pre><code" in html
            and "**" not in html  # raw MD 残留检查
        )
        ok = ok and html_ok
        detail += f" html_ok={html_ok}"
    record("6. h1 + paragraph + list + code block all parsed", ok, detail)
    if body.get("created"):
        delete_page(headers, body["created"]["id"])

    # ─── 8. GFM 表格 — contentJSON 含 table/tableRow/tableCell + contentHTML 有 <table> ───
    table_md = (
        f"# {prefix}-table\n\n"
        "前置文本。\n\n"
        "| # | Method | Old | New |\n"
        "|---|---|---|---|\n"
        "| 1 | GET | `/api/old/a` | `/api/new/a` |\n"
        "| 2 | POST | `/api/old/b` | `/api/new/b` |\n\n"
        "后置文本。\n"
    )
    payload = {"source": "paste", "text": table_md, "spaceId": space_id}
    code, body = import_page(headers, payload)
    ok = False
    detail = ""
    if code == 201 and body.get("created"):
        tiptap = body["created"].get("contentJSON", {})
        types = set()
        def collect_types(n: Any) -> None:
            if isinstance(n, dict):
                if n.get("type"):
                    types.add(n["type"])
                for c in n.get("content", []) or []:
                    collect_types(c)
            elif isinstance(n, list):
                for x in n:
                    collect_types(x)
        collect_types(tiptap)
        has_table_types = {"table", "tableRow", "tableHeader", "tableCell"}.issubset(types)
        html = body["created"].get("contentHTML", "")
        has_table_html = (
            "<table>" in html
            and "<thead>" in html
            and "<tbody>" in html
            and html.count("<tr>") == 3  # 1 thead + 2 tbody rows
            and html.count("<th>") == 4
            and html.count("<td>") == 8
            # 前后文本未被吞
            and "前置文本" in html
            and "后置文本" in html
            # placeholder 已替换,不再出现
            and "[PW-TABLE:" not in html
        )
        ok = has_table_types and has_table_html
        detail = f"types_ok={has_table_types} html_ok={has_table_html}"
    record("8. GFM table parsed: JSON has table nodes + HTML has <table>", ok, detail)
    if body.get("created"):
        delete_page(headers, body["created"]["id"])

    # ─── 7. parentId 落 sibling group 末尾 ───
    # 先创建一个父页 + 一个子页,再 import 一个新的子页,验证新页 sortOrder 最大
    parent_title = f"{prefix}-parent"
    payload = {
        "source": "paste",
        "text": f"# {parent_title}\n\nparent body",
        "spaceId": space_id,
    }
    code, body = import_page(headers, payload)
    parent_id = body.get("created", {}).get("id") if body.get("created") else None
    ok_parent = bool(parent_id)

    if ok_parent:
        # 子页 1
        child1_title = f"{prefix}-child1"
        code1, body1 = import_page(headers, {
            "source": "paste",
            "text": f"# {child1_title}\n\nchild1 body",
            "spaceId": space_id,
            "parentId": parent_id,
        })
        child1_id = body1.get("created", {}).get("id") if body1.get("created") else None
        # 子页 2
        child2_title = f"{prefix}-child2"
        code2, body2 = import_page(headers, {
            "source": "paste",
            "text": f"# {child2_title}\n\nchild2 body",
            "spaceId": space_id,
            "parentId": parent_id,
        })
        child2_id = body2.get("created", {}).get("id") if body2.get("created") else None
        # 验证 order
        if child1_id and child2_id:
            # 拉一次 children 列表查 order(parentId 过滤走 GET /pages)
            code3, body3 = request_json(
                "GET", f"/api/pages?parentId={parent_id}&space={space_id}", headers
            )
            items = body3.get("items", []) if isinstance(body3, dict) else []
            orders = {it["id"]: it.get("order") for it in items if it.get("id") in (child1_id, child2_id)}
            ok = (
                code1 == 201
                and code2 == 201
                and orders.get(child1_id) is not None
                and orders.get(child2_id) is not None
                and orders[child2_id] > orders[child1_id]
            )
            detail = f"child1.order={orders.get(child1_id)} child2.order={orders.get(child2_id)}"
        else:
            ok = False
            detail = "child creation failed"
        record("7. parentId + sibling group: new child lands after siblings", ok, detail)
        # cleanup
        for cid in (child1_id, child2_id, parent_id):
            if cid:
                delete_page(headers, cid)
    else:
        record("7. parentId + sibling group", False, "parent creation failed")

    # ─── Summary ───
    print()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print(f"=== {passed}/{total} passed ===")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())