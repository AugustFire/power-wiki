/**
 * Hocuspocus stateless broadcast helper —— 给 route 层一个「给某 page
 * 所有连接的客户端发 stateless 消息」的能力。
 *
 * 典型用途(Phase 4 页面编辑锁 / 强制接管):
 *   admin 调 POST /api/pages/:id/lock/takeover → 这里给原 holder 发
 *   { kind: 'lock_takeover', fromUserId, toUserId, pageId, expiresAt }
 *   → holder 端 provider.on('stateless') 接住 → 弹 lock_taken toast。
 *
 * 设计要点:
 *   - **找不到 page 不报错**:如果当前没有客户端在编辑这个 page(Hocuspocus
 *     没创建 Document 实例,或在 idle timeout 后已被卸载),takeover 仍合法
 *     成功 —— stateless 消息只是 UI 信号,没人接收就 silent no-op。
 *   - **找不到 Hocuspocus singleton 也不报错**:collab server 启动失败时
 *     HTTP 主服务仍可工作(协同是 progressive enhancement);route 层要容错。
 *   - **消息格式**:Hocuspocus 协议 stateless 通道是纯字符串负载(server 不
 *     解析),统一用 JSON.stringify,client 端 JSON.parse 即可。客户端在
 *     provider.on('stateless', ({ payload }) => ...) 收到 string。
 *
 * **协议层 Hocuspocus 自带消息种类**(不需要我们发):
 *   - sync / awareness / auth / queryAwareness / update
 *
 * 我们发的 stateless 字符串是「opaque event」,Hocuspocus 不解析,只负责
 * 转发给该 Document 所有连接。
 */
import { getCollabHocuspocus } from './server'

/**
 * 给当前打开了指定 page 的所有连接的客户端发 stateless 消息。
 *
 * @param pageId  pages.id(Hocuspocus documentName)
 * @param message 任意 JSON-serializable 对象,会 JSON.stringify 后发出
 *                (协议层只承载 string)。
 * @returns       true = 发出成功;false = 没人接收(no-op)。
 */
export async function sendStatelessToPage(
  pageId: string,
  message: unknown,
): Promise<boolean> {
  const hocuspocus = getCollabHocuspocus()
  if (!hocuspocus) return false
  const doc = hocuspocus.documents.get(pageId)
  if (!doc) return false
  doc.broadcastStateless(JSON.stringify(message))
  return true
}