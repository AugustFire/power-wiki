-- 0008_add_column_comments.sql
--
-- 给现存 11 张表的所有字段补 SQL COMMENT(中文字面量)。
-- 对应 CLAUDE.md 硬约束第 10 条:DB 表 / 字段必须有 SQL COMMENT。
-- Schema 上的 JSDoc 是事实来源,改一处必须同步另一处。
--
-- 本次只补 0000..0007 创建 / 改过的对象。新表 / 新列必须在它们自己的
-- migration 里挂 COMMENT(不要再回来改这份)。
--
-- Drizzle 不自动生成 COMMENT ON,这是 API 协作者的责任。

/* ─────────────────────────────────────────────────────────────────
 *  users
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "users" IS '用户主体表。所有登录账号的记录、auth 凭证、个人偏好都在这里。';--> statement-breakpoint
COMMENT ON COLUMN "users"."id" IS '用户 id(nanoid,见 apps/web/src/lib/id.ts)。';--> statement-breakpoint
COMMENT ON COLUMN "users"."email" IS '登录邮箱,全局唯一。';--> statement-breakpoint
COMMENT ON COLUMN "users"."name" IS '展示名(中英文混排均可)。';--> statement-breakpoint
COMMENT ON COLUMN "users"."password_hash" IS '密码哈希(bcrypt)。登录校验用。';--> statement-breakpoint
COMMENT ON COLUMN "users"."role" IS '''admin'' 或 ''user''。admin 拥有空间 / 用户 / 组的写权限。';--> statement-breakpoint
COMMENT ON COLUMN "users"."status" IS '账号状态。''active'' / ''disabled'' / ''must_reset_password'',新建默认 must_reset_password。';--> statement-breakpoint
COMMENT ON COLUMN "users"."color" IS '头像 / 品牌色 hex(默认 #0052CC,Atlassian 蓝)。';--> statement-breakpoint
COMMENT ON COLUMN "users"."created_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "users"."updated_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "users"."last_login_at" IS 'Date.now() 毫秒;NULL 表示从未登录。';

/* ─────────────────────────────────────────────────────────────────
 *  sessions
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "sessions" IS '登录会话。一行 = 一个有效 cookie;id 即 cookie 值。';--> statement-breakpoint
COMMENT ON COLUMN "sessions"."id" IS 'nanoid(32) 会话 token,也是 HTTP-only cookie 的值。';--> statement-breakpoint
COMMENT ON COLUMN "sessions"."user_id" IS '所属用户 id。无 FK,清理在 session.ts 的 killSessionsForUser。';--> statement-breakpoint
COMMENT ON COLUMN "sessions"."expires_at" IS 'Date.now() 毫秒,过期时间。';--> statement-breakpoint
COMMENT ON COLUMN "sessions"."created_at" IS 'Date.now() 毫秒。';

/* ─────────────────────────────────────────────────────────────────
 *  user_groups
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "user_groups" IS '用户组。把用户按部门 / 权限聚合,用于空间授权(space_group_access)。';--> statement-breakpoint
COMMENT ON COLUMN "user_groups"."id" IS 'nanoid 组 id。';--> statement-breakpoint
COMMENT ON COLUMN "user_groups"."name" IS '组名。';--> statement-breakpoint
COMMENT ON COLUMN "user_groups"."description" IS '描述,可空。';--> statement-breakpoint
COMMENT ON COLUMN "user_groups"."created_at" IS 'Date.now() 毫秒。';

/* ─────────────────────────────────────────────────────────────────
 *  user_group_members
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "user_group_members" IS '用户组成员关系。复合主键 (group_id, user_id) 保证幂等加入。';--> statement-breakpoint
COMMENT ON COLUMN "user_group_members"."group_id" IS '所属组 id。无 FK,组删除时由 adminGroups DELETE 事务清理。';--> statement-breakpoint
COMMENT ON COLUMN "user_group_members"."user_id" IS '所属用户 id。无 FK,禁用用户不会自动清理成员关系。';--> statement-breakpoint
COMMENT ON COLUMN "user_group_members"."added_at" IS 'Date.now() 毫秒。';

/* ─────────────────────────────────────────────────────────────────
 *  spaces
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "spaces" IS '空间。kind=''shared'' 是团队空间,kind=''personal'' 是个人空间(owner_id 指向 users.id)。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."id" IS 'nanoid 空间 id。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."name" IS '空间名。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."description" IS '描述,可空。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."color" IS '空间品牌色 hex,默认 #0052CC。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."icon" IS 'material-symbols-outlined 字面量(如 ''home''、''star''),可空。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."kind" IS '''shared''(团队) 或 ''personal''(个人)。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."owner_id" IS '仅 personal 空间有意义,指向 users.id;团队空间为 NULL。无 FK,删用户不级联。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."created_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "spaces"."updated_at" IS 'Date.now() 毫秒。';

/* ─────────────────────────────────────────────────────────────────
 *  space_group_access
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "space_group_access" IS '空间对用户组的访问授权。复合主键 (space_id, group_id)。';--> statement-breakpoint
COMMENT ON COLUMN "space_group_access"."space_id" IS '被授权的空间 id。无 FK,adminSpaces DELETE 清理。';--> statement-breakpoint
COMMENT ON COLUMN "space_group_access"."group_id" IS '授权组 id。无 FK,adminGroups DELETE 清理。';--> statement-breakpoint
COMMENT ON COLUMN "space_group_access"."granted_at" IS 'Date.now() 毫秒。';

/* ─────────────────────────────────────────────────────────────────
 *  pages
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "pages" IS '页面树。每行 = 一页,parent_id 形成树形层级。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."id" IS 'nanoid(10) 页面 id,与前端 newId() 同源。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."parent_id" IS '父页面 id,NULL = 顶层。无 FK,子树清理走 pages.ts DELETE 递归 CTE。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."space_id" IS '所属空间 id。无 FK,空间被删后页面变孤儿(UI 兜底,admin 拒绝删非空空间)。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."title" IS '页面标题,默认空串。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."content_json" IS 'Tiptap 文档 JSON。服务端写入前必须校验 editor schema(无孤儿 mark、无空 text 节点)。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."content_html" IS 'Tiptap 渲染出的 HTML 缓存,只读视图直接渲染。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."icon" IS '页面 emoji 或 material-symbols 字面量,可空。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."sort_order" IS '同级兄弟节点的排序权重,小者靠前。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."created_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."updated_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."author_id" IS '创建者 user id,自由字符串(老 seed 可能为 ''me'')。无 FK,UI 自己渲染。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."starred" IS '是否被收藏。v0 是全局布尔位,不支持 per-user。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."deleted_at" IS 'Date.now() 毫秒,软删除时间。NULL = 活着,非 NULL = 回收站。';--> statement-breakpoint
COMMENT ON COLUMN "pages"."deleted_by" IS '执行删除操作的用户 id,可空。';

/* ─────────────────────────────────────────────────────────────────
 *  comments
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "comments" IS '页面评论与回复。v0 只支持一级嵌套(reply 不再有 reply)。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."id" IS 'nanoid 评论 id。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."page_id" IS '所属页面 id。无 FK,page purge 由递归 CTE 一起删。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."parent_id" IS '父评论 id,NULL = 顶层;非 NULL 表示某顶层评论的 reply。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."author_id" IS '评论作者 user id,自由字符串(老 seed 可能为 ''me'')。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."content_md" IS 'Markdown 正文。v0 编辑器纯 markdown,无 toolbar。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."content_text" IS '从 content_md 剥离 markdown 后的纯文本快照,通知预览直接用。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."mentioned_user_ids" IS '评论里 @mention 的 user id 数组(去重)。通知触发的唯一事实来源。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."is_edited" IS '是否被编辑过(true = PATCH 至少一次)。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."edited_at" IS '首次编辑时间,Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."created_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."updated_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."deleted_at" IS 'Date.now() 毫秒。NULL = 活着,非 NULL = 软删除。';--> statement-breakpoint
COMMENT ON COLUMN "comments"."deleted_by" IS '删除者 user id,可空。';

/* ─────────────────────────────────────────────────────────────────
 *  notifications
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "notifications" IS '用户通知。一行 = (收件人 × 事件);只对收件人自己可见。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."id" IS 'nanoid 通知 id。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."user_id" IS '收件人。通知是私有的,绝不向其他用户暴露。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."actor_id" IS '触发者 user id(LEFT JOIN users 取名 / 头像色)。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."kind" IS '事件类型。''mention'' / ''reply'' / ''comment_on_my_page''。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."page_id" IS '跳转目标页面 id。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."page_title" IS '页面标题快照。改标题不回溯改历史通知(Slack / Discord 行为)。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."comment_id" IS '跳转锚点(#comment-{id}),reply / comment_on_my_page 始终有值。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."mention_user_id" IS '仅 kind=''mention'' 时填,等于触发评论 mentioned_user_ids 之一。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."is_read" IS '是否已读。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."read_at" IS '首次标记已读时间,Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "notifications"."created_at" IS 'Date.now() 毫秒。';

/* ─────────────────────────────────────────────────────────────────
 *  page_versions
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "page_versions" IS '页面历史版本。每条 PATCH 内容变更写一行,starred-only PATCH 不写。保留最新 30 条 / 页。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."id" IS 'nanoid 版本 id。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."page_id" IS '所属页面 id。无 FK,page purge 时清掉。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."version_number" IS '页内单调递增版本号(1, 2, 3...);唯一索引保证并发安全。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."title" IS '当时页面标题。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."content_json" IS '当时 Tiptap 文档 JSON。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."content_html" IS '当时 Tiptap 渲染的 HTML。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."icon" IS '当时图标,可空。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."edited_by" IS '编辑者 user id,自由字符串。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."edited_at" IS 'Date.now() 毫秒。';--> statement-breakpoint
COMMENT ON COLUMN "page_versions"."change_note" IS '人工变更说明,可空;restore 时自动写成 "restored from v{N}"。';

/* ─────────────────────────────────────────────────────────────────
 *  page_labels
 * ───────────────────────────────────────────────────────────────── */

COMMENT ON TABLE "page_labels" IS '页面标签。Notion 风格全局自由标签,无命名空间。';--> statement-breakpoint
COMMENT ON COLUMN "page_labels"."page_id" IS '被标记的页面 id。无 FK,page purge 时清掉。';--> statement-breakpoint
COMMENT ON COLUMN "page_labels"."label" IS '标签字面量。服务端规范化:小写 + 去空格 + ≤ 32 字符。';--> statement-breakpoint
COMMENT ON COLUMN "page_labels"."author_id" IS '添加者 user id,自由字符串。';--> statement-breakpoint
COMMENT ON COLUMN "page_labels"."created_at" IS 'Date.now() 毫秒。';