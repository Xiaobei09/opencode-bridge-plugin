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
