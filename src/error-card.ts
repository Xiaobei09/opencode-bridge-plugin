/**
 * R2845（运营者：「又出现连续两次429，必须修复」）：连续同类型错误卡合并。
 *
 * 2026-11-19 15:28:48 实测：一个工具步完成后，下一次模型请求撞上
 * `provider.free-limit`（429，零正文）；紧接着排队中的用户消息被注入，
 * 331ms 后又撞同一个 429。TG 上因此出现**两张一模一样的错误卡**（72131/72132）。
 *
 * 错误卡本身必须保留（运营者明确要看到失败原因），但同一个会话、同一个错误
 * 类型、在短窗口内的连续失败只应更新同一张卡，并在标题标注「连续第 N 次」。
 * 成功回合会调用 `clear`，下一次失败重新开一张新卡。
 *
 * 本模块只做纯决策（不 import 业务模块），便于单测与复用。
 */

export type ErrorCardChain = {
  /** 首次发卡时用的 proto 键；后续同类错误编辑同一张卡。 */
  key: string
  /** 首次/最近一次错误时刻（窗口按最近一次滚动）。 */
  at: number
  type: string
  count: number
  /** 最近一次已计入的错误消息键；同一消息重复推送不得重复计数。 */
  lastMsgKey?: string
  /** R2847：额度窗口的 provider 重置时刻（epoch ms）；仅额度卡使用。 */
  resetAt?: number
}

export type ErrorCardPlan = {
  key: string
  count: number
  chain: ErrorCardChain
}

const MAX_COUNT = 99

/**
 * 决定这张错误卡是「新发」还是「编辑上一张」。
 *
 * @param prev 该会话上一张错误卡的链信息（无则 undefined）
 * @param args.type 规范化后的错误类型（空类型按 `unknown`，同类才合并）
 * @param args.windowMs 合并窗口；<=0 表示不合并
 */
export const planErrorCard = (
  prev: ErrorCardChain | undefined,
  args: { sid: string; msgKey: string; type: string; now: number; windowMs: number },
): ErrorCardPlan => {
  const type = args.type || "unknown"
  const now = Number(args.now) || Date.now()
  const windowMs = Number(args.windowMs) || 0
  if (
    prev &&
    windowMs > 0 &&
    prev.type === type &&
    Number.isFinite(prev.at) &&
    now - prev.at >= 0 &&
    now - prev.at <= windowMs
  ) {
    // 同一条错误消息可能被事件路径/补扫重复推送；只编辑，不重复累加次数。
    if (prev.lastMsgKey === args.msgKey) {
      return { key: prev.key, count: Number(prev.count) || 1, chain: prev }
    }
    const count = Math.min(MAX_COUNT, (Number(prev.count) || 1) + 1)
    const chain: ErrorCardChain = { key: prev.key, at: now, type, count, lastMsgKey: args.msgKey }
    return { key: chain.key, count, chain }
  }
  const key = `${args.sid}:error:${args.msgKey}`
  const chain: ErrorCardChain = { key, at: now, type, count: 1, lastMsgKey: args.msgKey }
  return { key, count: 1, chain }
}

/** 标题只在合并时追加次数，第一张卡保持原样（运营者只要求去掉重复卡）。 */
export const errorCardTitle = (base: string, count: number): string =>
  Number(count) > 1 ? `${base}（连续第 ${Math.min(MAX_COUNT, Number(count))} 次）` : base

/**
 * R2847（运营者：「又出现连续两次429，必须修复」）：同一额度窗口的错误卡跨会话合并。
 *
 * 2026-11-19 16:18/16:35/16:52 三次 `provider.free-limit` 分属三个接力会话
 * （ses_e0baf… → ses_e0b626… → ses_e0b532…），R2845 的按会话链合并不了，
 * TG 上每轮都新发一张 `❌ 生成失败 · provider.free-limit`。CI 结束卡（R2840）
 * 已经按「同一额度窗口第 N 轮」原地编辑，桥的额度错误卡也必须同口径。
 *
 * 额度窗口锚点取**首张**卡的 `resetAt`：provider 每次 429 给的 retryAfter 会抖动
 * （实测 16:18→00:07Z、16:35→00:59Z、16:52→00:08Z，跨度 ~50min），但首张卡的
 * 重置点还没到就说明仍在同一窗口；不拿新 hint 和旧 hint 逐次比较（16:18→16:35
 * 相差 51min，逐次比较会漏合并）。窗口过了（resetAt <= now）才开新卡。
 *
 * 与 `planErrorCard` 的区别：成功回合**不清空**额度链（额度是账号级、跨会话/接力
 * 仍然耗尽）；只有额度窗口结束才重新开卡。
 */
export const planQuotaErrorCard = (
  prev: ErrorCardChain | undefined,
  args: { sid: string; msgKey: string; type: string; now: number; resetAt: number },
): ErrorCardPlan => {
  const type = args.type || "unknown"
  const now = Number(args.now) || Date.now()
  const resetAt = Number(args.resetAt) || 0
  const prevReset = Number(prev?.resetAt ?? 0)
  if (
    prev &&
    prev.type === type &&
    resetAt > 0 &&
    prevReset > now &&
    Number.isFinite(prev.at) &&
    now - prev.at >= 0
  ) {
    // 同一条错误消息可能被事件路径/补扫重复推送；只编辑，不重复累加次数。
    if (prev.lastMsgKey === args.msgKey) {
      return { key: prev.key, count: Number(prev.count) || 1, chain: prev }
    }
    const count = Math.min(MAX_COUNT, (Number(prev.count) || 1) + 1)
    // 保留首张卡的 resetAt：整个窗口显示一个稳定的锚点，不跟着 provider 抖动。
    const chain: ErrorCardChain = { ...prev, at: now, type, count, lastMsgKey: args.msgKey }
    return { key: chain.key, count, chain }
  }
  const key = `${args.sid}:error:${args.msgKey}`
  const chain: ErrorCardChain = { key, at: now, type, count: 1, lastMsgKey: args.msgKey, resetAt }
  return { key, count: 1, chain }
}

/** R2847：额度卡标题标注同一窗口的累计次数（与 CI 结束卡的「第 N 轮」同口径）。 */
export const quotaCardTitle = (base: string, count: number): string =>
  Number(count) > 1 ? `${base}（同一额度窗口第 ${Math.min(MAX_COUNT, Number(count))} 次）` : base

/**
 * R2847：额度链的落盘形状 `[key, at, type, count, lastMsgKey, resetAt, chat]`。
 * 持久化是为了跨热重载继续编辑同一张卡（16:44:55 热重载 → 16:52 多发一张实证）。
 * 加载侧只认未过期且不超过 `maxMs` 的锚点；其余一律当作没有链，下一次 429 重开卡。
 */
export const quotaCardState = (chain: ErrorCardChain | undefined, chat = ""): unknown[] | null =>
  chain
    ? [chain.key, chain.at, chain.type, chain.count, chain.lastMsgKey ?? "", chain.resetAt ?? 0, chat]
    : null

export const restoreQuotaCard = (
  raw: unknown,
  now: number,
  maxMs = 24 * 3600_000,
): { chain: ErrorCardChain; chat: string } | undefined => {
  if (!Array.isArray(raw) || typeof raw[0] !== "string" || !raw[0]) return undefined
  const at = Number(raw[1])
  const type = String(raw[2] ?? "")
  const count = Number(raw[3])
  const lastMsgKey = typeof raw[4] === "string" ? raw[4] : ""
  const resetAt = Number(raw[5])
  const chat = typeof raw[6] === "string" ? raw[6] : ""
  const nowMs = Number(now) || Date.now()
  if (
    !Number.isFinite(at) ||
    at <= 0 ||
    !type ||
    !Number.isInteger(count) ||
    count <= 0 ||
    !Number.isFinite(resetAt) ||
    resetAt <= nowMs ||
    resetAt > nowMs + Math.max(0, Number(maxMs) || 0)
  ) {
    return undefined
  }
  return {
    chain: { key: raw[0], at, type, count: Math.min(MAX_COUNT, count), lastMsgKey, resetAt },
    chat,
  }
}
