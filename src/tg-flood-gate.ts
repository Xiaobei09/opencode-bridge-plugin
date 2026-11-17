/**
 * R2689（运营者：「分模块化设计…不改表现」）：实例级 flood gate / 429 streak。
 *
 * 这是**进程内运行态**，不是跨进程事实源：跨 Bot 的共享冷却仍由 tg-flood.ts 的
 * bot-flood.json 承载；本模块只回答“本实例此刻还该不该触网、下一次该等多久”。
 *
 * 抽取边界：
 *   · 状态容器（floodUntil / fallbackUntil / 两条通道各自的 429 streak）；
 *   · 429 记账（指数退避 + retry_after 取大者，成功即清零）；
 *   · 不负责写共享标记、不负责日志 —— 那些仍由桥的发送编排决定。
 *
 * 行为与抽取前逐字节一致：等待秒数仍走 tg-transport.floodBackoffSeconds，
 * 时间戳仍以调用瞬间的 Date.now() 计算，主/备通道的 streak 仍各算各的。
 */
import { FLOOD_BACKOFF_CAP_S, floodBackoffSeconds } from "./tg-transport"

/** 429 日志里“已按 N 秒封顶”的展示上限；与退避默认 cap 同源。 */
export const FLOOD_WAIT_CAP_S = FLOOD_BACKOFF_CAP_S

export type FloodGateState = {
  /** 主通道本地闸门截止 ms；0 = 无闸门。 */
  floodUntil: number
  /** 备用通道本地闸门截止 ms；0 = 无闸门。 */
  fallbackUntil: number
  /** 主通道连续 429 次数（指数退避的 attempt 来源）。 */
  primary429Streak: number
  /** 备用通道连续 429 次数（与主通道分开计数）。 */
  fallback429Streak: number
}

export const createFloodGate = (): FloodGateState => ({
  floodUntil: 0,
  fallbackUntil: 0,
  primary429Streak: 0,
  fallback429Streak: 0,
})

// 限流等待：**尊重** Telegram 给的 retry_after，并叠加自己的指数退避。
// R2386：必须传 `rand`，否则 floodBackoffSeconds 的 `rand` 落到固定默认 0.5 →
// 抖动恒为 ×1.125 常量（不是随机）→ 三 Bot/多会话在同一个毫秒齐步重试。
// R2602（D3）：Telegram 的 retry_after 是硬性“不得早于”，900s 封顶只应约束
// 我们自己的指数退避。实测 rawRetryAfter=1271s 被截成 900s，提前 ~6 分钟
// 重试 → 再吃 429 且等待更长，闸门反而永不排干。这里让 cap 至少覆盖 raw。
export const floodWaitSeconds = (retryAfter?: number, attempt = 1): number =>
  floodBackoffSeconds({
    retryAfter,
    attempt,
    capSeconds: Math.max(FLOOD_BACKOFF_CAP_S, Math.ceil(Number(retryAfter) || 0)),
    rand: Math.random(),
  })

/** 主通道 429：推进 streak、延长 floodUntil，返回本次等待秒数（供日志/共享标记）。 */
export const notePrimaryFlood = (gate: FloodGateState, retryAfter?: number): number => {
  const waitSeconds = floodWaitSeconds(retryAfter, ++gate.primary429Streak)
  gate.floodUntil = Math.max(gate.floodUntil, Date.now() + (waitSeconds + 1) * 1000)
  return waitSeconds
}

/** 备用通道 429：推进 streak、设置 fallbackUntil，返回本次等待秒数。 */
export const noteFallbackFlood = (gate: FloodGateState, retryAfter?: number): number => {
  const wait = floodWaitSeconds(retryAfter, ++gate.fallback429Streak)
  gate.fallbackUntil = Date.now() + (wait + 1) * 1000
  return wait
}

/** 主通道成功：清零自己的 streak（真正恢复，而不是“等够了就再试”）。 */
export const markPrimaryHealthy = (gate: FloodGateState): void => {
  gate.primary429Streak = 0
}

/** 备用通道成功：只清备用计数，不影响主通道健康度。 */
export const markFallbackHealthy = (gate: FloodGateState): void => {
  gate.fallback429Streak = 0
}

/**
 * 采纳兄弟实例刚写入的共享闸门：只延长、不缩短。
 * 返回被采纳后的剩余秒数；无需采纳/已过期返回 null（调用方据此决定是否记日志）。
 */
export const adoptSharedFlood = (gate: FloodGateState, diskUntil: number, now: number): number | null => {
  if (diskUntil > gate.floodUntil && diskUntil > now) {
    gate.floodUntil = diskUntil
    return Math.ceil((diskUntil - now) / 1000)
  }
  return null
}
