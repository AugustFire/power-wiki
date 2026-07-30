-- 0033_space_homepage.sql
--
-- 与 0032 同款规则:drizzle-orm 对纯 SQL migration 偶发 silently skip。
-- 跑完如发现新列没生效,在 postgres 容器里手动重跑:
--   docker exec power-wiki-postgres psql -U power_wiki -d power_wiki -f \
--     apps/api/src/db/migrations/0033_space_homepage.sql
-- 或 DELETE FROM drizzle.__drizzle_migrations WHERE id = 33; 后重启 dev。

-- 团队空间可写主页:Confluence space homepage 的同构能力。
-- 背景:
--   此前团队空间 `/` 路由(SpaceHomeView)只有系统生成的仪表盘:描述、统
--   计、快捷操作、根页面卡片。Confluence 的 space homepage 是团队 onboarding
--   的核心入口 —— 写一段「欢迎来到 XX 组 / 我们做什么 / 怎么上手」,新人
--   落地即读。power-wiki 缺这个能力,团队只能把首页内容塞进一篇普通根页
--   面,然后在描述里 link 过去。
--
-- 本迁移加一列 homepage_page_id(可空,text),指向 pages.id:
--   - null = 未配置,`/` 继续走仪表盘模板(向下兼容,无需 backfill);
--   - 非 null = `/` 路由 redirect 到 /p/:homepagePageId,复用 ReadView 全
--     套渲染(sanitize / 标题 / byline / 评论 / 关注 / TOC / 历史 等)。
--
-- 为什么没有 FK:
--   项目硬约束(CLAUDE.md 第 7 条)Drizzle schema 不写 .references(),所有
--   级联由应用代码显式完成。本列的无主情况处理:
--     (a) soft-delete (page 进 trash):不主动清字段 —— admin 进入空间设置
--         仍能看到原主页已 trash,可手动换掉或恢复页面;
--     (b) hard-delete (page purge):pages.ts 的 purge transaction 已经扫
--         所有 spaces 行,把 homepage_page_id = 该 pageId 的清为 null,避
--         免悬挂引用。两条路径的清理都在迁移后端代码里覆盖。
--
-- 为什么 kind='personal' 永远为 null:
--   个人空间语义由 owner 自治,`/` 渲染其 root 页面树 + 仪表盘,没必要
--   再叠一层「主页」抽象。PATCH /api/spaces/:id 与 adminSpaces.ts:224
--   都已 kind !== 'shared' 短路,所以不必再加 CHECK。

-- IF NOT EXISTS:本仓库 journal 与 __drizzle_migrations 的 bookkeeping 长期
-- 不一致(见上方手动重跑说明),这条 DDL 有可能被跑第二次 —— 加守卫让重跑
-- 幂等,而不是在 dev 启动时炸「column already exists」。
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "homepage_page_id" text;--> statement-breakpoint

COMMENT ON COLUMN "spaces"."homepage_page_id" IS
  '团队空间主页,指向本空间内一篇 page 的 id。null = 未配置,`/` 路由继续渲染
   SpaceHomeView 仪表盘模板;非 null = `/` 自动 redirect 到 /p/:homepagePageId,
   复用 ReadView 全套渲染(sanitize / byline / 评论 / TOC / 历史 等)。

   No FK(项目硬约束)。悬挂处理:
   - soft-delete(page 进 trash):不主动清,admin 仍可在空间设置看到原主页已
     trash,可手动换掉或 restore。
   - hard-delete(page purge):apps/api/src/routes/pages.ts 的 purge transaction
     同事务扫 spaces 行清空 homepage_page_id = 该 pageId,避免悬挂。

   写入校验在 PATCH /api/spaces/:id 路由:homepagePageId 非 null 时,目标 page
   必须 (a) 存在 (b) space_id = 本空间 (c) deleted_at IS NULL,否则 400。

   仅 kind=''shared'' 空间有意义 —— personal space 永远 null(路由层面拒绝)。';