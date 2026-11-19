/**
 * R2828（运营者：「增加一个token速度/使用量显示」）：回合结束提示里的 token 速度/用量口径。
 *
 * 数据来源 = 宿主 assistant 行的 `tokens` 与 `time`（DB 行与事件映射都带）：
 *   · tokens.output + tokens.reasoning = 本轮真正生成的 token；
 *   · time.firstToken → time.streamed = 生成窗口（streamed 是最后一个 token 的时刻；
 *     completed 之后还要跑工具，用它会把工具耗时算进生成速度）；
 *   · time.streamed 缺失才退回 completed。
 *
 * 为什么速度要按步加权汇总：一轮可能有多个 assistant 步骤（工具调用前后各一步），
 * 只取最后一步会漏掉前面的生成；对每步速度做简单平均又会让短步骤权重过高。
 * `Σ生成token / Σ生成时长` 才是整轮的平均吞吐。
 *
 * 为什么上下文只取最后一步：每一步的 input/cache 都是**完整上下文**，求和会把同一段
 * 上下文重复计数（实测一轮几十步、单步十几万缓存，求和会变成几百万）。最后一步的
 * 五字段之和才是"本轮结束时上下文有多大"，与卡片标题 ctx 百分比同源。
 *
 * 纯函数：不碰 I/O，方便单测把边界钉死（无 timing、错误步、缓存缺失、旧行）。
 */
import { parseTokenUsage, type ParsedTokenUsage } from "./ctx-usage"

export type TurnTokenStats = {
  /** 带有效 tokens 的 assistant 步数 */
  steps: number
  /** 有有效生成窗口（firstToken → streamed/completed）的步数 */
  timedSteps: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** 本轮生成 token = output + reasoning（所有可读步） */
  generated: number
  /** 有效生成窗口总和（毫秒） */
  windowMs: number
  /** 整轮平均生成速度（tok/s）；无有效窗口/样本不足 → null */
  speed: number | null
  /** 最后一步的五字段总和（与 ctx % 同一分子） */
  contextTokens: number
  /** 最后一步的缓存量（cache.read + cache.write） */
  cacheTokens: number
}

const rowInfo = (m: any): any => m?.info ?? m
const rowTokens = (m: any): unknown => {
  const info = rowInfo(m)
  return info?.tokens ?? m?.tokens
}
const rowTime = (m: any): any => {
  const info = rowInfo(m)
  return info?.time ?? m?.time ?? {}
}
const positive = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0

/**
 * 汇总一个回合的 assistant 行。
 *
 * `rows` 应为**同一回合**的 assistant 消息（调用方用 turnEarlierAssistantRows + 终态行），
 * 不要传整会话：会话级 tokens_* 是生命周期累计，不是本轮用量。
 */
export const turnTokenStats = (rows: unknown): TurnTokenStats | null => {
  const arr = Array.isArray(rows) ? rows : []
  let steps = 0
  let timedSteps = 0
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let windowMs = 0
  let timedGenerated = 0
  let lastUsage: ParsedTokenUsage | null = null
  for (const row of arr) {
    const info = rowInfo(row)
    const role = String(info?.role ?? "")
    const typ = String(info?.type ?? (row as any)?.type ?? "")
    if (role !== "assistant" && typ !== "assistant") continue
    const u = parseTokenUsage(rowTokens(row))
    if (!u.present || u.total <= 0) continue
    steps++
    input += u.input
    output += u.output
    reasoning += u.reasoning
    cacheRead += u.cacheRead
    cacheWrite += u.cacheWrite
    lastUsage = u
    const t = rowTime(row)
    const start = positive(t?.firstToken)
    // streamed 才是最后一个生成 token 的时刻；completed 之后可能还要跑工具。
    const end = positive(t?.streamed) || positive(t?.completed)
    if (start > 0 && end > start) {
      const dur = end - start
      // <100ms 多半是同一毫秒内落盘的小步骤，速度会被量化误差放大；只计 token 不计速度。
      if (dur >= 100) {
        windowMs += dur
        timedGenerated += u.output + u.reasoning
        timedSteps++
      }
    }
  }
  if (steps === 0) return null
  const generated = output + reasoning
  const speed =
    timedSteps > 0 && windowMs > 0 && timedGenerated > 0
      ? timedGenerated / (windowMs / 1000)
      : null
  return {
    steps,
    timedSteps,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    generated,
    windowMs,
    speed,
    contextTokens: lastUsage ? lastUsage.total : 0,
    cacheTokens: lastUsage ? lastUsage.cacheRead + lastUsage.cacheWrite : 0,
  }
}

/** 紧凑 token 数：999 → 999、1234 → 1.2k、12345 → 12k、1234567 → 1.2m。 */
export const fmtTokenCount = (n: number): string => {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  const scaled = (x: number): string => {
    const s = x >= 10 ? String(Math.round(x)) : x.toFixed(1)
    return s.endsWith(".0") ? s.slice(0, -2) : s
  }
  if (v >= 999_500) return `${scaled(v / 1_000_000)}m`
  if (v >= 1_000) return `${scaled(v / 1_000)}k`
  return String(Math.round(v))
}

/** 速度：≥100 取整，<100 保留一位小数（98.4、7.2）。 */
export const fmtSpeed = (v: number): string => {
  const n = Number.isFinite(v) && v > 0 ? v : 0
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}

/**
 * 回合结束提示的附加行；没有可读样本时返回空串（调用方不要输出空行）。
 *
 * 文案：`📊 ⚡ 40.9 tok/s · 本轮 ↓45 · ctx ↑4.1k（缓存 2.1k）`
 *   · ↓ = 本轮生成 token（output + reasoning）；
 *   · ctx ↑ = 最后一步五字段总和，与卡片标题的 ctx 百分比同一分子；
 *   · 缓存 = 最后一步 cache.read + cache.write（缺失时不显示）。
 */
export const tokenStatsLine = (s: TurnTokenStats | null | undefined): string => {
  if (!s || s.steps <= 0) return ""
  const parts: string[] = []
  if (s.speed != null) parts.push(`⚡ ${fmtSpeed(s.speed)} tok/s`)
  if (s.generated > 0) parts.push(`本轮 ↓${fmtTokenCount(s.generated)}`)
  if (s.contextTokens > 0) {
    const cache = s.cacheTokens > 0 ? `（缓存 ${fmtTokenCount(s.cacheTokens)}）` : ""
    parts.push(`ctx ↑${fmtTokenCount(s.contextTokens)}${cache}`)
  }
  return parts.length > 0 ? `📊 ${parts.join(" · ")}` : ""
}
