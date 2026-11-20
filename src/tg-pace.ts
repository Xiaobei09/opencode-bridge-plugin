/**
 * R2697（运营者：「代码的复用情况如何，精简，整理，优化，模块融合，分模块化设计」）：
 * 同一 chat **新消息**发送的最小间隔削峰（原 tg-bridge 内的 paceSend 闭包）。
 *
 * 边界：只管“这条新消息现在能不能发、还要等多久”。HTTP/重试/分段仍在
 * tg-send-text；主备通道/429 记账在 tg-send；限流闸门在 tg-flood-gate。
 * 状态是每 chat 的最后发送墙钟，进程内存在；不读写磁盘，不反向 import 桥。
 *
 * 行为与抽取前逐字节一致：
 *   · minGapMs <= 0 直接关闭；
 *   · 等待上限 5s（防止一次 pace 把回合拖死）；
 *   · 等待 >= 2s 才记一条 info，避免正常节流刷日志；
 *   · 等待结束后用**实际时间**刷新基线，而不是计划时间。
 */
export type PaceSendDeps = {
  /** 同一 chat 两条新消息之间的最小墙钟间隔；<=0 关闭。 */
  minGapMs: number
  /** 桥的统一日志出口。 */
  log: (level: "info" | "warn" | "error", message: string) => Promise<void> | void
  /** 日志脱敏（chat id 也可能带敏感上下文）。 */
  sanitize: (value: unknown) => string
  /** 测试注入：墙钟。 */
  now?: () => number
  /** 测试注入：等待。 */
  sleep?: (ms: number) => Promise<void>
  /** 单次等待上限，默认 5000ms（与原实现一致）。 */
  maxWaitMs?: number
}

export const createPaceSend = (deps: PaceSendDeps): ((chatID: string) => Promise<void>) => {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxWaitMs = Number.isFinite(deps.maxWaitMs) ? Math.max(0, Number(deps.maxWaitMs)) : 5_000
  const minGapMs = Number.isFinite(deps.minGapMs) ? Math.max(0, deps.minGapMs) : 0
  const lastSendWallByChat = new Map<string, number>()

  return async (chatID: string): Promise<void> => {
    if (minGapMs <= 0) return
    const key = String(chatID)
    const wait = (lastSendWallByChat.get(key) ?? 0) + minGapMs - now()
    if (wait > 0) {
      if (wait >= 2_000) {
        await deps.log("info", `send paced (chat=${deps.sanitize(key)} waited=${Math.round(wait)}ms)`)
      }
      await sleep(Math.min(wait, maxWaitMs))
    }
    lastSendWallByChat.set(key, now())
  }
}
