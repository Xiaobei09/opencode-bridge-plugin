/**
 * R2691（运营者：「分模块化设计…不改表现」）：Bot API 调用的主/备通道编排。
 *
 * 从 tg-bridge.ts 的 tgFetch 闭包抽出。被抽出的不是“网络怎么发”（那是 tg-api），
 * 而是**决策**：这次该走主通道还是备用通道、本地闸门是否直接 429、每次 429 如何
 * 记账、日志何时该节流。此前它和桥的 30 多个局部变量混在一起，只能靠字符串断言；
 * 现在依赖全部显式注入，可用脚本化假客户端逐分支回归。
 *
 * 依赖注入而不是 import 桥内状态，原因：
 *   · fallbackApiBase / BOT_ID 是**运行时可重算**的（/reload、多 Bot 装配），
 *     必须每调用取一次，不能在建厂时快照；
 *   · shared gate 同步、日志、共享标记写入是桥的组合根职责，模块不反向 import 桥。
 *
 * 行为与抽取前逐字节一致：
 *   · preferFallback 的编辑优先走备用通道，失败再回主通道；
 *   · 备用通道发送 sendMessage/editMessageText 时去掉按钮（callback 只回主 Bot）；
 *   · 主通道 429 且备用成功 → 只清备用 streak，不记主通道 429（原逻辑即如此）；
 *   · 主通道 429 才写共享标记 + 节流日志（10s 一条）；
 *   · 异常转成 status 0，desc 由调用方的 sanitize 生成。
 */
import { fallbackBody, type TelegramResult } from "./tg-transport"
import {
  notePrimaryFlood,
  noteFallbackFlood,
  markPrimaryHealthy,
  markFallbackHealthy,
  FLOOD_WAIT_CAP_S,
  type FloodGateState,
} from "./tg-flood-gate"

export type TgFetchDeps = {
  /** 主通道 base（含 bot token）；每次调用读取，兼容运行时重装配。 */
  getApiBase: () => string
  /** 备用通道 base；空串 = 未配置备用 Bot。 */
  getFallbackApiBase: () => string
  /** 本实例 bot id（写共享 429 标记时使用）。 */
  getBotID: () => string
  /** 实例级闸门/streak 状态（与桥共用同一个对象）。 */
  gate: FloodGateState
  /** 采纳兄弟实例刚写入的共享闸门（桥负责限频与日志）。 */
  syncSharedGate: (now: number) => void
  /** 桥的统一日志出口。 */
  log: (level: "info" | "warn" | "error", message: string) => Promise<void> | void
  /** 桥的日志脱敏（token/会话 ID/控制字符）。 */
  sanitize: (err: unknown) => string
  /** 写入跨 Bot 共享的限流标记（tg-flood.markSelfFlooded）。 */
  markFlooded: (botID: string, until: number) => void
  /** 唯一 HTTP 客户端（桥内为 callTelegram → tg-api）。 */
  call: (base: string, method: string, body: Record<string, unknown>) => Promise<TelegramResult>
}

export const createTgFetch = (
  deps: TgFetchDeps,
): ((method: string, body: Record<string, unknown>, preferFallback?: boolean) => Promise<TelegramResult>) => {
  // 429 日志节流：硬限流期间每次触网都刷一条会把日志冲爆（实测 15s 一拍）。
  let lastFloodLogAt = 0

  return async (method, body, preferFallback = false): Promise<TelegramResult> => {
    const fallbackApiBase = deps.getFallbackApiBase()
    const apiBase = deps.getApiBase()
    const floodGate = deps.gate
    try {
      const canFallback =
        Boolean(fallbackApiBase) &&
        (method === "sendMessage" ||
          method === "sendDocument" ||
          method === "pinChatMessage" ||
          method === "unpinChatMessage" ||
          (preferFallback && method === "editMessageText"))
      const fbBody = method === "sendMessage" || method === "editMessageText" ? fallbackBody(body) : body
      const now = Date.now()
      // R2608（D3）：发送/编辑前采纳兄弟实例刚写入的共享闸门，避免过期本地状态触网。
      deps.syncSharedGate(now)
      if (preferFallback && fallbackApiBase && method === "editMessageText") {
        if (now < floodGate.fallbackUntil) return { ok: false, status: 429, desc: "local fallback flood gate active" }
        const direct = await deps.call(fallbackApiBase, method, fbBody)
        if (direct.ok) {
          markFallbackHealthy(floodGate)
          return { ...direct, viaFallback: true }
        }
        if (direct.status === 429) {
          noteFallbackFlood(floodGate, direct.retryAfter)
          return { ok: false, status: direct.status, desc: direct.desc, retryAfter: direct.retryAfter, viaFallback: true }
        }
        // 所有权标记不准确时再尝试主 Bot，避免把可编辑消息永久卡住。
      }
      if (now < floodGate.floodUntil && !canFallback) return { ok: false, status: 429, desc: "local flood gate active" }
      if (canFallback && now < floodGate.fallbackUntil) return { ok: false, status: 429, desc: "local fallback flood gate active" }

      let primary: TelegramResult
      if (now < floodGate.floodUntil && canFallback) {
        primary = await deps.call(fallbackApiBase, method, fbBody)
        if (primary.ok) {
          markFallbackHealthy(floodGate)
          return { ...primary, viaFallback: true }
        }
        if (primary.status === 429) {
          noteFallbackFlood(floodGate, primary.retryAfter)
        }
        return { ok: false, status: primary.status, desc: primary.desc, retryAfter: primary.retryAfter, viaFallback: true }
      }

      primary = await deps.call(apiBase, method, body)
      if (primary.ok) {
        markPrimaryHealthy(floodGate)
        return primary
      }
      if (primary.status === 429 && canFallback) {
        const secondary = await deps.call(fallbackApiBase, method, fbBody)
        if (secondary.ok) {
          markFallbackHealthy(floodGate)
          return { ...secondary, viaFallback: true }
        }
        if (secondary.status === 429) {
          noteFallbackFlood(floodGate, secondary.retryAfter)
        }
      }
      if (primary.status === 429) {
        const waitSeconds = notePrimaryFlood(floodGate, primary.retryAfter)
        // R1895：进闸即写共享标记 —— 自己此刻起发不出任何消息，只有别的 Bot 能替我说。
        // 每次 429 都写（合并语义：until 取 max、since 保留同次起点），不额外去抖：
        // 这是一次文件写 + rename，且只在 429 分支（受本地闸门保护，不会每拍都走）。
        deps.markFlooded(deps.getBotID(), floodGate.floodUntil)
        if (Date.now() - lastFloodLogAt > 10_000) {
          lastFloodLogAt = Date.now()
          const rawRa = Number(primary.retryAfter ?? 0)
          const capped =
            Number.isFinite(rawRa) && rawRa > FLOOD_WAIT_CAP_S ? ` (已按 ${FLOOD_WAIT_CAP_S}s 封顶，原始 ${rawRa}s)` : ""
          await deps.log(
            "info",
            `telegram 429 cooldown=${waitSeconds}s rawRetryAfter=${primary.retryAfter || "none"}${capped} fallback=${canFallback ? "yes" : "no"} streak=${floodGate.primary429Streak}`,
          )
        }
      }
      return { ok: false, status: primary.status, desc: primary.desc, retryAfter: primary.retryAfter }
    } catch (err) {
      // ⚠️ 此前这里 `return { ok: false }` —— **把异常整个丢掉**：调用方拿不到 status、
      // 也拿不到原因，只能记成 `status=?`（实测 12 条一模一样的"神秘失败"）。
      // 现在把原因带回来：status 0 = 网络层未拿到响应（下游已按可重试处理）。
      return { ok: false, status: 0, desc: deps.sanitize(err).slice(0, 160) || "network exception" }
    }
  }
}
