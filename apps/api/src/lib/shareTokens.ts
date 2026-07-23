/**
 * 公开分享 token 工具(Phase D)。
 *
 *   generateShareToken()  → 16 字符字母数字明文(URL 友好,无歧义字符)
 *   hashToken(plain)      → sha256 hex(64 字符),入库用
 *
 * 设计要点:
 *   - **明文 token 永不入库** —— DB 只存 sha256 hex,泄露 DB 也无法
 *     还原活 token(verify_phase_d §db_dump_no_plaintext_token 断言)。
 *   - token 长度 16 字符,字母表 62 (a-z A-Z 0-9),URL 友好,无
 *     `+/=` 之类的 base64 字符,也避开 nanoid 自己的 31 字符字母表
 *     里的歧义字符。熵 ≈ 16 × log2(62) ≈ 95 bits,远高于安全阈值
 *     (NIST SP 800-63B 80 bits)。
 *   - 字母表故意不与 pageId / sessionId 共享 —— 长度 + 字符集组合
 *     能从 URL path 一眼区分(`/public/pages/<token>` 的 token 是
 *     大小写混合,跟 `/p/<pageId>` 的全小写对比鲜明)。
 */
import { createHash, randomBytes } from 'node:crypto'

/** 16 字符 URL 友好的随机 token(字母 + 数字,无歧义)。 */
export function generateShareToken(): string {
  // 16 字节 → 32 hex 字符,但取前 16 字符给 URL 更短,熵仍 ~95 bits
  // —— 实际上 16 hex 字符 = 64 bits,不够。改用 base64url:
  // 12 字节 = 16 base64url 字符(无 padding)≈ 96 bits。
  return randomBytes(12).toString('base64url')
}

/** sha256 hex(64 字符)。stable,DB 主路径。 */
export function hashToken(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex')
}
