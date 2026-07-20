/**
 * Postgres 错误码 → HTTP 状态映射。
 *
 * 中心化在 app.onError 里调用,覆盖所有路由 —— 好过在每条写路径手包 try/catch。
 *
 * 只处理 23505(unique_violation):正常业务流里唯一会冒泡的 SQLSTATE
 * (注册撞 `users.email`、并发打 snapshot 撞 `page_versions_page_version_uq`)。
 * 23503(foreign_key_violation)在本项目**不可能触发** —— schema 硬约束无外键
 * (见 CLAUDE.md),级联删除全在应用层显式做,故不映射。
 *
 * 注意:不回传 pg error 的 `detail`,它含冲突的具体列值(如 email 明文),会泄漏。
 * `constraint` 名是 schema 元数据、非用户数据,回传以便客户端区分冲突来源。
 */
interface PgError {
  code?: string
  constraint?: string
}

const UNIQUE_VIOLATION = '23505'

export function mapPgError(
  err: unknown,
): { status: 409; body: { error: string; constraint?: string } } | null {
  const e = err as PgError | null
  if (e?.code === UNIQUE_VIOLATION) {
    return { status: 409, body: { error: 'conflict', constraint: e.constraint } }
  }
  return null
}
