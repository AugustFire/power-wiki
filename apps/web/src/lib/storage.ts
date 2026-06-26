export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const parsed = JSON.parse(raw)
    return parsed as T
  } catch (err) {
    console.warn(`[storage] failed to read key "${key}", falling back`, err)
    return fallback
  }
}

/**
 * 写入 localStorage,返回是否成功。
 *
 * 失败时不再静默吞错 —— 调用方应该感知 quota 超限 / 隐私模式 / 序列化失败等场景,
 * 给用户提示(参见 pagesStore 的 watch → EditView 的 saveState)。
 */
export function writeJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    console.warn(`[storage] failed to write key "${key}"`, err)
    return false
  }
}

export function hasKey(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null
  } catch {
    return false
  }
}