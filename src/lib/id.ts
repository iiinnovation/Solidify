/**
 * 客户端标识生成
 *
 * 这些 id 只用作前端 store 的键，数据库侧有自己的 UUID 主键。
 * 用 crypto.randomUUID() 保证唯一，避免 Date.now() + Math.random() 在
 * 同一毫秒内批量创建时碰撞。
 */

/**
 * 生成带前缀的唯一 id，形如 `artifact-3f2a...`
 *
 * crypto.randomUUID 需要安全上下文（https / localhost / Tauri），
 * 不可用时退回到时间戳 + 随机串。
 */
export function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
