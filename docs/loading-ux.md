# Loading UX 规约(Stage B.3)

**这是网络面板 / 用户体验的硬性约束,任何新视图、新组件、新路由都要遵守。**

下面是 16 条:前 9 条是数据获取(去重 + 不预先拉 + 后端聚合),后 7 条是 Loading UX(无空白 flash + chrome 不消失 + 顺滑过渡)。

## 数据获取(去重 + 不预先拉 + 后端聚合)

1. **不重复拉** — 同一份数据如果已经被 store / composable / 父组件拉过,子组件不要再发同一个请求。判断标准:`useXxxStore` 已有 / composable 单例已 populate / props 已在手。**绝不允许**「父子组件各自拉一份同样的列表」。

2. **跨视图共享数据走 module-level composable** — 不允许在 view 的 `onMounted` 里起一个组件级 `ref + load()`,这天然不能跨路由复用。典型例子:`apps/web/src/composables/useManagerStats.ts` 持有全局 `users` / `groups` reactive refs,`ensureUsersLoaded()` / `ensureGroupsLoaded()` 用 **promise cache**(in-flight promise 复用)让并发调用方共享一次网络往返。多个 view 引用同一份 `stats.users.value`。

3. **不预先拉用户看不到的内容** — tab 切换器没激活的 tab、dropdown 没打开就不发请求;只在 `watch(activeTab)` 触发 + 该 tab 没拉过时补一次。trash 视图的下拉框 / 过滤器的全部用户名单改 `@focus="ensureAllUsersLoaded"` + 首次聚焦才发。**禁止** `onMounted` 里把所有可能用到的东西一次性全拉。

4. **列表端点必须返聚合,不强迫前端 N+1** — 后端 list 路径要返 `memberCount` / `ownerName` / `pageCount` 这类聚合字段(LEFT JOIN + `GROUP BY` + `COUNT(*)`),不让前端为了拿一个 count 跑 `Promise.all(items.map(getDetail))`。`:id` 详情路由才返完整 `memberIds[]`。DTO 在 `packages/shared/src/schemas.ts` + `types.ts` 加字段,后端 mapper 同步。

5. **限制 `limit`** — admin / 全量列表用 `?limit=200`(经验值,真实团队 < 200 人 / 组)。**禁止**无 limit 拉全表。pagination 改用 `usePaginatedList` 的 `loadMore` + `hasMore`,不靠「一次拉完」。

6. **CRUD 写后必须 sync store / composable** — 新增 / 更新 / 删除后调 `upsertUser` / `upsertGroup` / `removeXxx` 同步 module-level 单例,而不是 `store.value.push(...)` 后让别处自己 refetch。

7. **登入 / 登出时清缓存** — module-level 单例在 `auth.signIn` / `signOut` 时调 `invalidate()`,避免跨用户泄漏。已实现于 `useManagerStats.invalidate()`。

8. **dead context panel 删** — 永远没引用的 Vue 组件(0 import)直接删,不留在仓库里。

9. **批量写回必须按当前用户写权限过滤;能本地算就不要写回** — `Promise.all(items.map(api.update))` 这种「全部跑一遍」的批量回放在 admin 上必踩坑:admin 看得到他人 personal space 页,但 PATCH 会被 `assertAdminNotWritingPersonalSpace` 返 403 `personal_space_readonly`,服务永远收不到,下个冷启动又重跑一批(实测:admin 冷启动 10+ 个 403 PATCH `/api/pages/:id`)。规则:
   - 任何批量写回必须先按 `useAuthStore.user.role` + `space.kind` 过滤,只对当前用户**能写**的页面发起请求。
   - 「省得下次重算」的优化型写回,优先评估**完全不写回**是否可接受 —— 本地幂等计算(如 HTML → JSON migration)比重启后再算一次的代价低,根本不值得 N 个 RTT 的代价。

## Loading UX(无空白 flash + chrome 不消失 + 顺滑过渡)

10. **Chrome 永远不消失** — topbar / breadcrumb / 侧边导航 / 子导航在 `loading` 时**不能**放进 `v-if="data"` 分支。breadcrumb + header 永远在外层,只有 form body / list body 用 `<Skeleton>` 占位。修改任何「加载中…」的视图都要遵守。

11. **首次加载用 Skeleton,不用「加载中…」文本** — `apps/web/src/components/ui/Skeleton.vue` 接受 `width` / `height` / `radius` / `count` props,shimmer 1.4s 循环。颜色复用 `tokens.css` 的灰度,**禁止**自造十六进制色值。表头 skeleton 行保证表格高度不塌。

12. **新页面 / 新记录 URL 即刻跳** — EditView / Sidebar / HomeView 的「新建页面」按钮:**客户端先 `newId()` → `router.push('/p/<id>/edit')` → 后台 `await createPage` 异步**。URL 立刻稳定,编辑器立刻可写,不等 200-500ms 的 POST round-trip。后端返回的 id 若不一致再 `router.replace` 一次,失败回滚到 `/`。

13. **`refetch` 不清空列表** — `usePaginatedList.reset()` **禁止**先 `items.value = []` 再 fetch,会让用户看到「列表消失 → 重新出现」的 flash。改用 `refreshing` ref + 保留旧数据,fetch 完成后用新数据替换。视觉上显示顶部 2px sticky 细进度条(`var(--accent)` + `progress` keyframe)即可。

14. **路由切换有 fade 过渡** — `App.vue` + `ManagerLayout.vue` 都有 `<transition name="fade" mode="out-in">`,但**必须有对应 CSS**(`.fade-enter-active` / `.fade-leave-active { transition: opacity 120ms }`)。改 CSS 别把这条 transition 干掉。

15. **刷新按钮 disable + 图标旋转** — 表格视图的「刷新」按钮在 `loading` 时 `disabled`,图标加 `class="is-loading"` 触发 `transform: rotate(360deg)` 动画,不要让用户能连点。

16. **404 / 错误保留 chrome** — 任何「未找到 / 加载失败」分支都至少保留 topbar + 返回上级路径,不白屏。

## 验收标准(改任何 view 都要跑这个)

- `pnpm typecheck` 三 workspace 全过
- `py -3.13 scripts/verify_b3_efficiency.py` — admin 视图 mount 请求数:`/manager/people` ≤ 5,`/manager/spaces` ≤ 6,`/manager/trash` ≤ 4,个人空间详情 0 个 `users/:id`,chrome-during-load 可见,edit-new-url-instant URL 在 2s 内变 `/p/<id>/edit`
- `py -3.13 scripts/verify_n_plus_1.py` — admin 跨 view 切换 0 个 `pages?space=` 重复请求
- 视觉变化附 screenshot(存 `screenshots/`,已在 `.gitignore`)

**记忆点**:打开 Network 面板,如果看到一个 view mount 时有 ≥ 2 个相同 endpoint 的重复请求,或者看到 chrome 闪烁 / 空白 flash,就是这条规约被违反了,必须改。