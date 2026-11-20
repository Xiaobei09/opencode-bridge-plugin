/**
 * R2843（运营者：「当前数据结构有没有可以优化的地方？不要环境还原失败！」）：
 * 状态文件里的「已发送去重」与「已扒键」两个集合只用于**成员判断**，却按原文
 * 持久化完整 key（`ses_…:tool:…`，约 65–80 字符）。bot5/bot6 实测各 1500 条
 * hashes + 1000 条 stripkb ≈ 180KB，占状态文件 250KB 的 7 成；每次落盘都把这
 * 份纯缓存重新序列化，并随 $HOME 快照跨 run 搬运。
 *
 * 这里把集合元素换成 64 位指纹（`fp1:` + 16 位十六进制），对外仍是
 * `add/has/delete/values/size` 的 Set 行为：
 *   · 调用方继续传原始 key，无需感知指纹；
 *   · 迭代得到的已是指纹 token，落盘后下次加载原样接受（不二次哈希）；
 *   · 旧状态里的原始 key 加载时自动转成指纹 —— 向后兼容，不需要迁移脚本；
 *   · 旧代码读到新 token 只当作普通字符串（成员判断不命中），不会崩溃，
 *     也不会误判成“已发送/已处理”，因此热重载/回滚窗口是安全的。
 *
 * 为什么不用 crypto：这是每个 protoSend 都会走的热路径，纯 32 位运算实现
 * 两个独立 FNV-1a 混合成 64 位，避免引入哈希对象的分配；2500 条状态加载
 * 与每次发送一两次查询的开销都可以忽略。碰撞概率按 64 位生日界计算
 * （n=2500 时约 1.7e-13），远低于原去重键里本来就有的 32 位正文哈希。
 */

const FINGERPRINT_PREFIX = "fp1:"
const FINGERPRINT_RE = /^fp1:[0-9a-f]{16}$/

/** 32 位 FNV-1a；seed 让同一字符串得到两个独立混合值。 */
const fnv1a32 = (s: string, seed: number): number => {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** 稳定、可落盘的 64 位 key 指纹（16 位小写十六进制，带版本前缀）。 */
export const keyFingerprint = (key: string): string => {
  const a = fnv1a32(key, 0x811c9dc5).toString(16).padStart(8, "0")
  const b = fnv1a32(key, 0x9e3779b9).toString(16).padStart(8, "0")
  return `${FINGERPRINT_PREFIX}${a}${b}`
}

/** 是否是本模块已经算好的 token（用于加载时避免二次哈希）。 */
export const isKeyFingerprint = (value: string): boolean => FINGERPRINT_RE.test(value)

/**
 * Set<string> 的指纹化替身：调用方按原始 key 操作，内部只存指纹。
 *
 * `add/delete/has` 对两种输入都安全：
 *   · 原始 key → 先算指纹；
 *   · `fp1:…` token（来自落盘状态或 GC 迭代）→ 原样使用。
 * 这样持久化加载、trim 删除、热重载迁移可以共用同一套方法，不必在各处
 * 记得“这里要哈希、那里不要”。
 */
export class FingerprintSet implements Iterable<string> {
  readonly #items = new Set<string>()

  add(key: string): this {
    this.#items.add(isKeyFingerprint(key) ? key : keyFingerprint(key))
    return this
  }

  has(key: string): boolean {
    return this.#items.has(isKeyFingerprint(key) ? key : keyFingerprint(key))
  }

  delete(key: string): boolean {
    return this.#items.delete(isKeyFingerprint(key) ? key : keyFingerprint(key))
  }

  get size(): number {
    return this.#items.size
  }

  clear(): void {
    this.#items.clear()
  }

  values(): IterableIterator<string> {
    return this.#items.values()
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.#items.values()
  }
}
