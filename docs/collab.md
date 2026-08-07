# 协同锁 + 协同感知 + 删除 race 收口

页面级编辑锁 + 协同 awareness(谁在看 / 谁在编辑)+ M13+ 删除 race 4 缺口收口。技术方案 + 实际 case + 文件位置索引。

**TL;DR** — 进入 EditView 自动拿 5min 锁;同页有人编辑时 ReadView byline 显示「✏️ 正在编辑」头像组;server 推 `lock_changed` / `lock_cleared` 让 client 实时响应 takeover / TTL 过期;软删 / 硬删遇到持锁页面会被 server 拒绝并通知 holder 让出锁。

---

## 1. 为什么需要这套

### 1.1 痛点

| 问题 | 现象 |
|---|---|
| **A 在改,B 不知情** | B 进 EditView,看到老内容开始改,A 的修改覆盖回来;两人互盖 |
| **A 在改,admin 想删** | admin 软删 / 硬删 A 在编辑的页面 → A 的 PATCH 开始 404,A 不知情继续编辑,内容写进已 trashed page 的 `page_yjs_state`(orphan 行)|
| **WS 不通就瞎** | server WS 断开时 client 不知道,UI 一直显示旧状态 |
| **1s 轮询 `GET /lock`** | 任何打开 ReadView / EditView 的 tab 每秒打一次 `/api/pages/:id/lock`,server 收到 N 个用户的 N×每秒请求 |

### 1.2 设计目标

1. **锁 = UI 信号,不写权限闸**。canEditPage 的用户即使没拿锁也能敲字落盘(Yjs CRDT 合并),锁只是 banner / tooltip 提示「有人在改」。
2. **WS push 优先**,polling 退化。`lock_changed` / `lock_cleared` 由 server 主动推;polling 只在 WS 断开 / TTL 兜底时跑。
3. **isMine 时 0 轮询**。自己拿锁时无需检测 takeover(server push 已覆盖),也不需要检测自己的 TTL(服务端兜底)。
4. **删除必有 holder 知情**。admin 试图删 A 在编辑的 page → server 推 `page_locked_during_delete` 给所有 holder,A 让出后 admin 才能继续。

---

## 2. 核心概念

### 2.1 锁 `page_locks`

页面级编辑锁,**5min TTL**(`acquiredAt + 5*60*1000`)。约束(沿用硬约束:无 FK):
- 锁 ≠ 写权限闸。Yjs CRDT 始终接受合法 canEditPage 用户的 update。
- 5min 自动过期,过期后下次 `acquire` 可直接覆盖(以防网抖)。
- admin 可强制接管:POST `/api/pages/:id/lock/takeover`。
- DELETE 锁保护(M13+):软删 / 硬删都在写入 `deletedAt` 之前 SELECT active lock,有 holder 则拒。

### 2.2 Awareness `awarenessStates`

`y-protocols/awareness` 的 in-memory map(server 端 Hocuspocus / client 端 BroadcastChannelProvider 同步)。每条 entry 形态:
```ts
{ user: { id, name, color, avatarKind, avatarRef, mode: 'view' | 'edit' } }
```
`mode` 字段(2026-08-06 加)区分 view / edit;PresenceAvatars 据此渲染两段头像。ReadView 永远 `view`,EditView 永远 `edit`,由 `awarenessMode?: () => AwarenessMode` 闭包注入到 `useCollabProvider`,自动 setLocalStateField。

### 2.3 Stateless push

Hocuspocus stateless 是纯 string 通道(协议层不解析),server `JSON.stringify` 后发出,client `JSON.parse`。三种 kind:

| kind | 触发时机 | 携带 | client 处理 |
|---|---|---|---|
| `lock_changed` | `acquire` / `release` / `takeover` 提交后 | `{ pageId, lock: PageLock \| null }` | `usePageLock.lock.value = lock` |
| `lock_cleared` | server 30s sweep 清过期锁 | `{ pageId, at }` | `usePageLock.lock.value = null` |
| `page_locked_during_delete` | admin DELETE 命中 active lock | `{ actorId, pageId }` | `usePageLock.pageDeleting` 挂 banner |
| `page_actually_deleted` | purge / 软删 commit 后兜底 | `{ pageId }` | `notify + router.replace('/')` |

### 2.4 自适应轮询

| 状态 | interval |
|---|---|
| WS connected + lock 是自己的 | **0**(skip,server push 覆盖)|
| WS connected + lock 是他人的 / 无锁 | 5s |
| WS 断开(网络抖 / server restart) | 1s |
| Tab hidden(browser throttle background timer) | 30s |

`usePageLock.ts` 用 `setTimeout` 链(非 `setInterval`),每轮根据当前状态算 interval;`visibilitychange` listener 在 visible 时立即 refresh 一次。

---

## 3. 架构

### 3.1 数据流(server 视角)

```
EditView mount (shared mode)
  └→ POST /api/pages/:id/lock (acquire)
       └→ assertNoActiveLockForDelete helper (DELETE 软删/硬删共用)
       └→ page_locks UPSERT + broadcastLockChanged(pageId, lock)
            └→ sendStatelessToPage(pageId, {kind:'lock_changed', lock})
                 └→ Hocuspocus document.broadcastStateless(json)
                      └→ 所有连上 WS 的 client 收到 onStateless

TTL 过期
  └→ lockSweeper (30s interval, unref)
       └→ SELECT expired page_locks
       └→ DELETE + broadcastLockCleared(pageId)
            └→ 同上 broadcastStateless 路径
```

### 3.2 数据流(client 视角)

```
useCollabProvider
  └→ HocuspocusProvider / BroadcastChannelProvider
       └→ awareness.on('change') → 重新 setLocalStateField(mode)
       └→ onStateless(payload) → usePageLock.handleStateless

usePageLock
  └→ watch [pageId, collabMode] → acquire + maybeStartPoll
  └→ watch [lock.userId, isCollabConnected, currentUser.id] → 重评 poll 策略
  └→ visibilitychange → maybeStartPoll + refresh

ReadView / EditView
  └→ PresenceAvatars (byline 头像组,awarenessStates 驱动)
  └→ LockBanner (EditView,他人锁视角)
  └→ PageDeletingBanner (EditView,M13+ 删除 race)
  └→ editLockTooltip (ReadView Edit 按钮 tooltip,awareness 派生)
```

### 3.3 文件位置

| 模块 | 文件 |
|---|---|
| **Server — 锁** | `apps/api/src/routes/pageLocks.ts` |
| Server — 锁事件广播 | `apps/api/src/lib/pageLockEvents.ts` |
| Server — 30s sweep | `apps/api/src/lib/lockSweeper.ts` |
| Server — Hocuspocus stateless | `apps/api/src/collab/stateless.ts` |
| Server — 软删/硬删锁闸门 | `apps/api/src/routes/pages.ts`(`assertNoActiveLockForDelete` helper)|
| Server — Y.Doc 持久化 deletedAt 守卫 | `apps/api/src/collab/hooks.ts` |
| Server — schema | `apps/api/src/db/schema.ts`(`pageLocks` / `pageYjsState`)|
| Server — migrations | `apps/api/src/db/migrations/0035_collab.sql` / `0036_page_locks.sql` / `0037_m13_delete_lock_comment.sql` |
| **Client — composables** | `apps/web/src/composables/usePageLock.ts` |
| Client — auto-save not_found 区分 | `apps/web/src/composables/usePageAutoSave.ts` |
| Client — store not_found 区分 | `apps/web/src/stores/pages.ts` |
| Client — Hocuspocus 封装 | `apps/web/src/editor/collab/useCollabProvider.ts` |
| Client — BroadcastChannel(个人空间)| `apps/web/src/editor/collab/broadcastChannelProvider.ts` |
| Client — 编辑器 collab 扩展装配 | `apps/web/src/editor/buildExtensions.ts` |
| Client — 锁横幅 | `apps/web/src/components/page/LockBanner.vue` |
| Client — 删除 race 横幅 | `apps/web/src/components/page/PageDeletingBanner.vue` |
| Client — byline 头像组 | `apps/web/src/components/page/PresenceAvatars.vue` |
| Client — 倒计时工具 | `apps/web/src/lib/formatLockExpiry.ts` |
| Client — REST client | `apps/web/src/lib/api.ts`(`api.pageLock.*`)|
| Client — EditView | `apps/web/src/views/EditView.vue` |
| Client — ReadView | `apps/web/src/views/ReadView.vue` |

---

## 4. Case(实际场景)

### Case 1 — Alice 在改,Bob 进 EditView

| 步骤 | 现象 |
|---|---|
| 1. Alice 进 EditView | `POST /api/pages/X/lock` → 200 `{ lock: {userId: Alice, expiresAt: now+5min} }`,server `broadcastLockChanged` 推 `lock_changed` 给所有 client |
| 2. Bob 进 EditView | `POST /api/pages/X/lock` → 409 `page_locked`,holder = Alice(awarenessStates 解析 Alice.name / color)|
| 3. Bob 的 EditView | 顶部显示 LockBanner:**Alice · 正在编辑此页 · 还剩 4:30** + 「强制接管」按钮(若 Bob 是 admin)|
| 4. Bob 敲字 | Yjs CRDT 照常 merge,内容正常落盘(Bob 没拿锁也能写)|
| 5. Alice 让出(关闭 tab) | `DELETE /api/pages/X/lock` → 204,server `broadcastLockChanged(pageId, null)` 推 `lock_cleared`,LockBanner 自动消失 |

**没有 race**:Alice / Bob 都在写同一份 Yjs doc,字符级 CRDT 合并不会丢字;锁只是 UI 信号让双方知道对方在改。

### Case 2 — A 在 EditView,admin 软删

| 步骤 | 现象 |
|---|---|
| 1. A 在 EditView,锁 = A | page_locks 有 A 一行 |
| 2. admin `DELETE /api/pages/X` | server `assertNoActiveLockForDelete` 查 active lock → 命中 A → 推 `page_locked_during_delete` 给 A + 返 409 `page_locked` |
| 3. A 端 PageDeletingBanner 升起 | 「admin 正在尝试删除此页面 · 删除会拒绝,直到你离开编辑器」 + 「我知道了,让出」按钮 |
| 4. A 点「让出」 / 关闭 tab | `DELETE /api/pages/X/lock` → 204,server `broadcastLockChanged(pageId, null)` |
| 5. admin 重试 DELETE | 无 active lock,正常 204 + `pages.deletedAt` 写入 + page_event `trashed` |

### Case 3 — A 在 EditView,server 网络抖

| 步骤 | 现象 |
|---|---|
| 1. A 进 EditView,锁 = A | usePageLock.isMine = true → `shouldSkipPoll()` 返 true → **0 轮询** |
| 2. WS 断开 | `useCollabProvider.isConnected` 翻 false,但 lock 是自己的,`shouldSkipPoll` 仍 true → 仍 0 轮询(server push 走不了,但 A 自己知道连接断了)|
| 3. WS 重连 | HocuspocusProvider 自动 reconnect,`isConnected` 翻 true,`maybeStartPoll` 重评 → 仍 skip |

WS 期间即使 A 不知道 takeover 是否发生,server TTL 5min + 30s sweep 后也会清锁,A 重新连上时 `lock_cleared` 会补发(A 的 ydoc destroy 时 client 重连触发)。

### Case 4 — A 看 ReadView,B 改

| 步骤 | 现象 |
|---|---|
| 1. A 打开 `/p/X`(ReadView)| `useCollabProvider.awarenessMode='view'`,连接 Hocuspocus |
| 2. B 进 EditView | awareness.user.mode='edit' 广播给 A |
| 3. A 端 | byline 显示「✏️ 正在编辑 · B 的头像」(PresenceAvatars 编辑段);Edit 按钮 tooltip「B 正在编辑此页」 |
| 4. A 切到其他页 | awarenessStates 切页时清空;byline 上头像组消失 |
| 5. B 离开 EditView | B 的 awareness.mode 翻 'view' 或 awarenessStates 移除;byline 上头像组消失 |

**A 端不轮询 `GET /lock`** —— presence 完全由 awareness 实时驱动(`awareness.on('change')` 触发 reload)。

### Case 5 — Personal space 多 Tab 同步(Alice 自己)

| 步骤 | 现象 |
|---|---|
| 1. Alice 在 Tab A 打开 personal space /p/X | `useCollabProvider` 走 `BroadcastChannelProvider`(`mode='personal'`),不上 server |
| 2. Alice 开 Tab B 打开同页 | Tab B 启动后发 `sync_request`,Tab A 收到后回 `sync_response(state)`,Tab B apply → 内容同步 |
| 3. Alice 在 Tab A 敲字 | Y.Doc 'update' → 广播 `update` 消息 → Tab B apply |
| 4. Tab A 关闭 | channel close + Y.Doc destroy,Tab B 不受影响(继续编辑)|

**不拿锁** —— personal space 是单用户多 Tab,锁没语义;`usePageLock.acquire` 看 `collabMode.value !== 'shared'` 直接 return。

### Case 6 — A 在改,B admin takeover

| 步骤 | 现象 |
|---|---|
| 1. A 在 EditView,锁 = A | (同 Case 1) |
| 2. B(admin)`POST /api/pages/X/lock/takeover` | server 删 A 的锁,插 B 的锁,推 `lock_changed` 给所有 client |
| 3. A 端 | usePageLock 收到 `lock_changed` → `lock.value = B's lock`;LockBanner 现在显示「B · 正在编辑 · 还剩 4:55」+ **「强制接管」按钮** —— 但 B 是 admin,A 不是 admin,不该让 A 看到接管按钮。这里是已知 UX bug,留给后续 ticket |
| 4. B 端 EditView mount | acquire → 409 → `refresh()` 拉 server → `lock.value = B's lock` → EditView 正常工作 |

---

## 5. 边界场景 FAQ

**Q1 — Yjs CRDT 不保证 A / B 不会覆盖彼此的修改吗?**
CRDT 保证最终一致,但不保证单点顺序。A 删了一段,B 改了同一段,合并结果是「保留两个变更 + merge 顺序由 clientID 决定」。锁的存在意义是 UI 提示「别同时改」,降低冲突概率,不是数据一致性闸门。

**Q2 — 个人空间为什么用 BroadcastChannel 而不接 server?**
个人空间是单人工作区,跨设备同步靠 Postgres `pages.contentJson` 兜底(每次 mount hydrate),同浏览器多 Tab 才是协同需求,BroadcastChannel 覆盖这个场景,不占 server 端 `page_yjs_state`。**关闭最后 Tab 时不写回 server** —— 这是已知限制,Phase 5 之后的 server-side personal doc snapshot 收口项。

**Q3 — `assertNoActiveLockForDelete` 跟 `page_locked_during_delete` 顺序?**
server 先 SELECT active lock,有 holder → `sendStatelessToPage` 推 `page_locked_during_delete` → 返 409。顺序保证 holder 收到通知,即使 client 没正确处理通知,DELETE 也已经拒绝。

**Q4 — 为什么 delete `page_yjs_state` 在 purge 路径而软删不清?**
软删保留恢复能力,restore 时不需要重新 hydrate Yjs state(走 `contentJson` 即可)。硬删是不可逆,清掉所有相关行防 orphan。详见 `routes/pages.ts` `purge` 分支注释。

**Q5 — `shouldSkipPoll` 为什么 lock isMine 时不管 WS 状态都跳过?**
- 我的锁的 takeover 由 `lock_changed` WS push 通知,不需要 polling 检测
- 我自己的 TTL 客户端无需检测(server 5min + 30s sweep 兜底)
- WS 断开时不轮询避免 server 不可达时反复打 GET 5xx 增加日志噪音

**Q6 — 个人 space 的 personal space id 怎么来?**
`ensurePersonalSpace.ts` 在 signup 时为每个 user 自动创建 personal space,`users.id` 唯一对应一个 personal space id(server 端 bootstrap 路径)。`/api/auth/session` 返回 `personalSpaceId`,client 拿来当默认 `spaceId` 调 `/api/pages`。

**Q7 — import / duplicate 创建的 page 为什么没有「刷新后内容消失」的问题?**
两层防御:
1. **`parseMarkdown` 表格 / inline mark 序列化正确性**:`apps/api/src/lib/mdImport.ts` 的 `inlineTokensToParagraph` 在 push 进 `activeMarks` 时用的是 `{ type: string, attrs: ... }` 普通对象,但 text token 展开 mark name 时走的是 `m.type.name`(把字符串当 `Mark` 实例读 → undefined),会产出 `{ type: undefined, attrs: {} }` 这种 broken mark,Tiptap `collabSchema.markFromJSON` 收到直接抛错。修了之后 import 出来的 `pages.contentJson` 本身就是干净的,可被 hydration 正确灌进 Y.Doc
2. **prefill `page_yjs_state`**:M13+ 之后协同主流程事实来源是 `page_yjs_state` 里的 Y.Doc 字节,`pages.contentJson` / `contentHtml` 是 mirror 列。import 端点(`POST /api/pages/import`)和 duplicate 端点(`POST /api/pages/:id/duplicate`)在写 `pages` 行之后,会立即调 `persistPageYjsState`(`apps/api/src/collab/persistPageYjsState.ts`)把 `contentJson` 灌进新 Y.Doc + UPSERT 进 `page_yjs_state`。这样 ReadView 首次 mount 时 `onLoadDocument` 命中「state 有 row」分支,跳过冷启动 hydration,`onBeforeUnloadDocument` 触发的 `mirrorYDocToPageContent` 不会再用空 Y.Doc 反向覆盖 `pages.contentJson` / `contentHtml`。冷启动 hydration 仍保留为兜底,只服务于 M13 之前落库的老 page。

---

## 6. 调试清单

| 现象 | 看哪里 |
|---|---|
| LockBanner 不显示 | `usePageLock.lock.value`(DevTools Vue devtools 看 computed);server `/api/pages/:id/lock` 直查 |
| 头像组不出现 | `useCollabProvider.awarenessStates.value` 是否非空;browser console 看 `[collab]` / `[awareness]` 日志 |
| 删除 race banner 不出现 | `usePageLock.pageDeleting.value`;server `apps/api/src/lib/pageLockEvents.ts` 的 `broadcastLockChanged` 是否被调到 |
| WS push 没收到 | browser Network → WS `/api/collab` → 看 stateless 帧;server `apps/api/src/lib/pageLockEvents.ts` 的 sendStatelessToPage 调用 |
| isMine 时还在轮询 | `usePageLock.shouldSkipPoll()` 返什么;`lock.value?.userId === currentUser.value?.id`? |
| 个人空间多 Tab 不同步 | browser DevTools → Application → BroadcastChannel 监听;确认 channel name = `power-wiki-collab:{pageId}` |

---

## 7. 验收

`scripts/verify_collab_delete_race.py` 覆盖 Case 2 / 4 / 5 + 软删对照 / purge cascade / not_found 路由跳转,共 **20/20 PASS**。

`scripts/verify_collab_delete_race_edges.py`(local-only,untracked)覆盖 TTL 过期 / takeover / personal space 三组边缘 case。**已知 flake**:`section 2 Takeover · Alice 持锁` 在 admin 软删 + Alice tab 切换之间有 timing 问题,跟本次改动无关,留给后续 ticket。