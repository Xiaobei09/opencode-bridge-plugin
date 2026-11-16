/**
 * 上下文用量口径的唯一实现（纯函数，tg-bridge / auto-continue / _v2compat / 单测共用）。
 *
 * 为什么要有这个文件：2026-11-16 之前“最近一次请求的窗口用量”在四处各算各的：
 *   · tg-bridge.noteUsage / ctxTotal（五字段）
 *   · tg-bridge 回填扫描（自己再判一次 lifetime / cache）
 *   · auto-continue.tokenSumOf（五字段）
 *   · _v2compat 的事件映射（只透传 input，cache/output/reasoning 丢掉）
 * 结果是同一会话在卡片、压缩判断、事件缩略样本里可以是三个不同的数字；而且
 * “cache 字段缺失”和“cache 字段存在但为 0”都被当成 `noCache`，把精确值标成下界。
 *
 * 宿主 opencode v2.3.0 的真实口径（从二进制内嵌源码核对，非猜测）：
 *   function jr(messages, revertID) {
 *     // 取最近一次 completed compaction 之后、revert 点之前的最后一条
 *     // type === "assistant" && tokens !== undefined 的消息
 *   }
 *   function HZ(messages, models, revertID) {
 *     const m = jr(messages, revertID)
 *     const total = m.tokens.input + m.tokens.output + m.tokens.reasoning
 *                 + m.tokens.cache.read + m.tokens.cache.write
 *     return { tokens: total, percent: Math.round(total / model.limit.context * 100) }
 *   }
 *   → 分子就是五字段之和，分母是模型 limit.context，百分比四舍五入。
 *
 * 本文件只负责“给定一份 tokens 对象，算出同样的五字段”，不碰 I/O、不碰 UI。
 */

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type ParsedTokenUsage = TokenUsage & {
  /** 五字段之和（宿主 HZ 的分子）。 */
  total: number
  /** tokens 对象里至少有一个字段是有限非负数。 */
  present: boolean
  /** `tokens.cache.read` 是数字（哪怕是 0）。 */
  cacheReadKnown: boolean
  /** `tokens.cache.write` 是数字（哪怕是 0）。 */
  cacheWriteKnown: boolean
  /**
   * 两个 cache 字段都真实存在（哪怕是 0）。
   *
   * 只有 `cacheKnown === false` 时，`total` 才是**下界**（缺了缓存前缀）；
   * `cacheKnown === true && cacheRead + cacheWrite === 0` 是**精确值**，
   * 不能再标“无缓存计数 / ≥”。这是本次修正的核心语义。
   */
  cacheKnown: boolean
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null

/** tokens → 五字段 + 字段是否存在。不抛错；缺失字段按 0 参与求和。 */
export const parseTokenUsage = (tokens: unknown): ParsedTokenUsage => {
  const t = tokens as any
  const cache = t?.cache
  const input = numOrNull(t?.input)
  const output = numOrNull(t?.output)
  const reasoning = numOrNull(t?.reasoning)
  const cacheRead = numOrNull(cache?.read)
  const cacheWrite = numOrNull(cache?.write)
  const total =
    (input ?? 0) + (output ?? 0) + (reasoning ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning: reasoning ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    total,
    present: [t?.input, t?.output, t?.reasoning, cache?.read, cache?.write].some(
      (v) => numOrNull(v) !== null,
    ),
    cacheReadKnown: cacheRead !== null,
    cacheWriteKnown: cacheWrite !== null,
    cacheKnown: cacheRead !== null && cacheWrite !== null,
  }
}

/** 五字段之和（宿主 HZ 口径）。任何路径需要“窗口占用”时都走这里。 */
export const tokenTotalOf = (tokens: unknown): number => parseTokenUsage(tokens).total

/**
 * 反向构造 V1 兼容 tokens。**只保留原对象真实存在的 cache 字段** —— 否则下游
 * parseTokenUsage 会把我们补的 0 当成“宿主报了缓存”，把下界伪装成精确值。
 */
export const tokenUsagePayload = (p: ParsedTokenUsage): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    input: p.input,
    output: p.output,
    reasoning: p.reasoning,
  }
  if (p.cacheReadKnown || p.cacheWriteKnown) {
    out.cache = {
      ...(p.cacheReadKnown ? { read: p.cacheRead } : {}),
      ...(p.cacheWriteKnown ? { write: p.cacheWrite } : {}),
    }
  }
  return out
}

/**
 * 「这是会话生命周期累计值，不是本次请求的窗口占用」判据。
 *
 * 活证据：宿主偶尔把 tokens.input 报成累计（实测 f339: in=16.8m，out/rea/cache 全 0），
 * 拿它除窗口必然 100%。判据保持与历史实现一致，避免放宽后把真正的超大 prompt 丢掉：
 *   · input 本身超过模型窗口 → 单次请求不可能；
 *   · input 超过 4 MiB 且其余字段全 0 → 真实调用不会只有输入没有输出/缓存。
 */
export const isLifetimeUsage = (p: ParsedTokenUsage, window: number): boolean => {
  if (!(p.input > 0)) return false
  if (p.input > window) return true
  const others = p.output + p.reasoning + p.cacheRead + p.cacheWrite
  return p.input > 4 * 1024 * 1024 && others === 0
}

/** 宿主 HZ 的百分比：四舍五入。窗口未知/为 0 时返回 null（不编 0%）。 */
export const ctxPercent = (total: number, window: number): number | null => {
  if (!(window > 0) || !(total > 0)) return null
  return Math.round((total / window) * 100)
}
