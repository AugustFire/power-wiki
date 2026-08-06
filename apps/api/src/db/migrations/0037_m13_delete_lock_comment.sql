-- 0037_m13_delete_lock_comment.sql
--
-- M13+ 协同删除 race 收口(2026-08-06):同步 schema.ts JSDoc 与 pg_description
-- (CLAUDE.md §10 硬约束,drift 视为 bug)。本文件不修改 schema(列 / 约束 /
-- 索引),只更新 page_locks / page_yjs_state 两条表的 COMMENT ON TABLE。
--
-- drizzle-kit 不跟踪 COMMENT 的 content_hash,更新 comment 不会让 drizzle
-- "re-apply" 也不会被认为有改动。手动跑:psql -f 本文件。同款规则见 0023
-- update_avatar_ref_comment.sql / 0033 space_homepage.sql。
--
-- 与 0033 同款 — 纯 SQL migration 偶发 silently skip。失败处置:
--   docker exec power-wiki-postgres psql -U power_wiki -d power_wiki -f \
--     apps/api/src/db/migrations/0037_m13_delete_lock_comment.sql
-- 或 DELETE FROM drizzle.__drizzle_migrations WHERE id = 37; 后重启 dev。

COMMENT ON TABLE "page_locks" IS
  '页面编辑锁(Phase A 实时协同 Phase 4 / 2026-08-05 落地)。一行 = 一个 page
   当前被锁住的快照。锁的唯一作用是 UI 提示(避免「Alice 大改时 Bob 乱入」),
   **不是**写权限闸 — Yjs CRDT 始终接受合法 canEditPage 用户的 update,
   没拿锁的 user 照常能编辑,只是 banner / tooltip 告知「有人正在改」。

   5 分钟自动过期:expiresAt = acquiredAt + 5*60*1000。前端每秒轮询一次
   /api/pages/:id/lock 算倒计时;server 端 acquire 时先 SELECT 一次,若现有
   锁 expiresAt < now() 则视为过期可覆盖(防网抖期间两个 user 同时拿锁)。

   强制接管:admin 可 POST /api/pages/:id/lock/takeover,server 端会用
   Hocuspocus stateless 给原 holder 发 lock_takeover 消息 + close conn(4410),
   同时 UPSERT 本表 user_id = admin;holder 端 uiStore 弹 lock_taken toast。

   DELETE 锁保护(M13+ 协同删除 race 收口 / 2026-08-06):DELETE /api/pages/:id
   软删与 ?purge=true 硬删在写入 deletedAt 之前**都**先 SELECT 本表当前 active
   lock(expiresAt > now);若有 → 返 409 `page_locked` + holders,同时推
   stateless `page_locked_during_delete` 给所有 holder,client 端 usePageLock
   收到后挂 PageDeletingBanner 让出锁,B 才能继续删。Phase 4 lock 5min TTL 是
   兜底(spoove lock 自然过期后重试 DELETE 就过得去)。

   No FK(项目硬约束,CLAUDE.md 第 7 条):page hard-delete 时由 pages.ts DELETE
   ?purge=true 在同事务内显式 sweep 本表;admin 接管 / 自然过期由各自路径
   覆盖或 DELETE 本行。';--> statement-breakpoint

COMMENT ON TABLE "page_yjs_state" IS
  'Yjs 协同编辑状态持久化(Phase A 实时协同 / 2026-08-05 落地)。一行 = 一个 page 的 Y.Doc
   状态。Hocuspocus server 的 onStoreDocument 钩子在 2s debounce 合并后把
   Y.encodeStateAsUpdate(doc) 落库;onLoadDocument 启动时拉回 bytea 应用
   到 Y.Doc。冷启动 hydration(Phase 2):首次连接且本表无 state 时从
   pages.contentJson 用 prosemirrorJSONToYDoc 重建;本表暂不立刻回写,
   留待首次 client edit 触发 onStoreDocument 再持久化。

   byte_size 是运维告警位(>1MB 触发拆分 / 归档);不上 CHECK(允许 0 = 刚
   INSERT 但还没 flush 过 state 的中间态)。不做 version 列:30s idle
   snapshot(Phase 5 收口)+ lock boundary 只写 page_versions + 本表,不在
   本表叠加历史。

   No FK(项目硬约束,CLAUDE.md 第 7 条):page hard-delete 时由 pages.ts
   DELETE ?purge=true 在同事务内显式 sweep 本表;page soft-delete (deletedAt)
   不动本表 —— restore 后协作文档状态仍在。

   M13+ zombie 守卫(2026-08-06):Hocuspocus hooks.ts 的 persistYDoc 在写入
   前 SELECT pages.deletedAt,若 page 已被软删/硬删(client 端的
   onAuthenticate 早于 DELETE 提交,Yjs 仍在 sync),跳过写入 + 主动 destroy
   server 端持有的 Y.Doc,让 Hocuspocus 自然 GC。否则 B 拿到锁后立即删页
   会让 A 端继续写 page_yjs_state 留 orphan 行。';
