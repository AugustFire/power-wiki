/**
 * 匿名主体 — Phase D 公开分享场景。
 *
 * 公开链接是匿名访问:没有 pw_session cookie,走 `/api/public/pages/:token`
 * 路由(挂在全局 requireAuth 之前)。但要复用现有 canReadSpace / canReadPage
 * 路径,需要一个「主体」参与 SQL —— 我们把匿名主体作为 users 表里
 * 一行 sentinel('anon', status='disabled' 永远不可登录),通过
 * `Principal{kind: 'anonymous', id: 'anon', isAdmin: false}` 复用
 * user-kind 路径。
 *
 * 这个文件只负责「构造 Principal」,sentinel 的 INSERT 在 migration
 * 0025_phase_d_anonymous_principal.sql 里幂等执行。
 */
import type { Principal } from '../lib/permissions'

/** 匿名 sentinel user id —— 与 migration 0025 写入的固定行 id 一致。 */
export const ANONYMOUS_USER_ID = 'anon'

/** 唯一来源:任何「匿名主语」都走这个工厂。 */
export function getAnonymousPrincipal(): Principal {
  return { kind: 'anonymous', id: ANONYMOUS_USER_ID, isAdmin: false }
}
