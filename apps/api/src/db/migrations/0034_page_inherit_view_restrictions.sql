-- 0034_page_inherit_view_restrictions.sql
--
-- 与 0033 同款规则:drizzle-orm 对纯 SQL migration 偶发 silently skip。
-- 跑完如发现新列没生效,在 postgres 容器里手动重跑:
--   docker exec power-wiki-postgres psql -U power_wiki -d power_wiki -f \
--     apps/api/src/db/migrations/0034_page_inherit_view_restrictions.sql
-- 或 DELETE FROM drizzle.__drizzle_migrations WHERE id = 34; 后重启 dev。

-- 页面 view 限制继承开关(2026-08-03 P1-3 落地)。
--
-- 背景:
--   现有 page_restrictions 表已经支持 view / edit 限制,view 沿父链 BFS
--   累计 allow-list 是 Confluence 默认行为 —— 父页设 view 限制时,子页自
--   动受同样的可见性约束。本身语义合理,但缺少一个「主动断开继承」的出
--   口:有些场景下子页需要跳出父链限制(例如父页是「公司公告」限制主管
--   才可见,但子页「产品手册」希望全公司能看)。
--
-- 行为:
--   - inherit_view_restrictions = TRUE(默认):沿父链 BFS 累计 view 限制,
--     跟现有 effectivePageReadAccess / pageReadableDirectFilter 行为一致。
--   - inherit_view_restrictions = FALSE:本页 view 访问权重新计算,只看
--     本页 view allow-list;祖先 view 限制不再约束本页及其子树。
--   - edit 限制不继承,无对应开关(独立语义,Confluence 也明确不继承 edit)。
--
-- backfill:
--   所有现有 page 的 inherit_view_restrictions 默认为 TRUE(列默认
--   值),不需要 UPDATE —— 语义对齐既有行为,无破坏性变更。

-- IF NOT EXISTS:本仓库 journal 与 __drizzle_migrations 的 bookkeeping 长期
-- 不一致(见上方手动重跑说明),这条 DDL 有可能被跑第二次 —— 加守卫让重跑
-- 幂等,而不是在 dev 启动时炸「column already exists」。
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "inherit_view_restrictions" boolean NOT NULL DEFAULT TRUE;--> statement-breakpoint

COMMENT ON COLUMN "pages"."inherit_view_restrictions" IS
  '是否继承父级 view 限制(2026-08-03 P1-3 落地)。TRUE(默认)= 子页 view
   访问权沿父链 BFS 累计,任一祖先 view 限制都会收紧子页可见性;FALSE =
   本页 view 访问权只看本页 view allow-list,不再上溯祖先。edit 限制独立
   语义、不继承,无对应开关。

   列默认 TRUE 意味着存量 page 无需 backfill,既有行为对齐。设 FALSE 的
   动机:父页设 view 限制了 A,B;C,D 的子树不希望被这条规则影响 —— 跳出
   父链后子树重新计算可见性。

   路由层接入:
   - GET /api/pages/:id/restrictions:返回 inheritViewRestrictions + 当前
     用户的保护来源(global admin / space admin / page author)+ 最近的有
     效父级 view 限制来源 {pageId, title} | null(供 dialog 解释)。
   - PUT /api/pages/:id/restrictions:接受 inheritViewRestrictions 字段,
     跟 view / edit 列表在同一事务保存,审计 before / after 同时记录开关
     变化(不开新 audit kind,沿用 page_restriction_set)。
   - effectivePageReadAccess / pageReadableDirectFilter:沿父链 walk 时,
     当前 page.inherit_view_restrictions = false 则停止继续上溯。

   No FK(项目硬约束,CLAUDE.md 第 7 条)。No CHECK,因为布尔 + default 即
   覆盖所有合法形态。';