/**
 * R2854（运营者：「22：43-22：49什么情况，为什么没有消息，必须修复」）：
 * 队列等待期的可见进度提示（**纯判据/文案**，桥只负责取运行态与发送）。
 *
 * 现场（2026-11-19 14:43–14:54 UTC = TG 22:43–22:54）：
 *   · 上一回合在流式生成一个大 `write` 工具调用，`session_message` 从 14:43:44
 *     到 14:50:15 没有任何新行；宿主也没发 part 事件，思考卡停在原地。
 *   · 运营者 14:43:06 / 14:43:50 发的消息按设计进入 `pinqueue` 等回合结束。
 *   · 这 6 分半里聊天里只有「📌 已收到 · 本轮结束后注入」和静默的置顶卡编辑，
 *     没有一条新的 Bot 消息，看起来就像 Bot 死了。
 *
 * 这不是注入时机的问题（活回合必须等正常结束，运营者已多次强调），而是
 * **等待过程不可见**。判据只覆盖「用户消息在队列 + 回合已静默」这一种情况，
 * 正常短回合、正在产出工具卡/正文的回合、暂停/429 冷却都不会提示。
 *
 * 阈值：
 *   · 入队等待 ≥ 3 分钟；
 *   · 最近一次宿主活动/投递 ≥ 2 分钟（否则说明回合还在产出，不算静默）；
 *   · 同一会话的提示间隔 ≥ 5 分钟（长回合最多每 5 分钟一条，不刷屏）。
 *
 * 无活动基线（热重载后内存为空）时**不提示**：入队时长只能证明用户等了多久，
 * 不能证明 Bot 静默了多久。桥侧先用“本实例首次看到排队的时刻”做基线，观察
 * 满 2 分钟再提示（R2854b；04:06 实测曾把 93 分钟等待误写成 93 分钟静默）。
 */

export const QUEUE_PROGRESS_MIN_WAIT_MS = 3 * 60_000
export const QUEUE_PROGRESS_QUIET_MS = 2 * 60_000
export const QUEUE_PROGRESS_GAP_MS = 5 * 60_000

export type QueueProgressInput = {
  now: number
  /** 该会话当前还在等待的用户消息数（pinqueue + pininflight）。 */
  queued: number
  /** 最早一条等待消息的入队时刻（0 = 未知）。 */
  waitStartedAt: number
  /** 该会话最近一次宿主活动 / 可见投递时刻（0 = 无基线）。 */
  lastActivityAt: number
  /** 上一次进度提示时刻（0 = 本等待期还没提示过）。 */
  lastNoticeAt: number
  /** 运营者主动暂停推送：静默是预期，不提示。 */
  paused?: boolean
  /** 429 冷却：发不出去，提示只会添乱。 */
  flooded?: boolean
}

export type QueueProgressVerdict = {
  due: boolean
  waitedMs: number
  silentMs: number
  why: string
}

export const queueProgressDue = (o: QueueProgressInput): QueueProgressVerdict => {
  const now = Number(o.now) || 0
  const waitStartedAt = Number(o.waitStartedAt) || 0
  const lastActivityAt = Number(o.lastActivityAt) || 0
  const lastNoticeAt = Number(o.lastNoticeAt) || 0
  const waitedMs = waitStartedAt > 0 ? Math.max(0, now - waitStartedAt) : 0
  const silentMs = lastActivityAt > 0 ? Math.max(0, now - lastActivityAt) : 0
  const verdict = (due: boolean, why: string): QueueProgressVerdict => ({ due, waitedMs, silentMs, why })

  if (!(Number(o.queued) > 0)) return verdict(false, "队列为空")
  if (o.paused) return verdict(false, "推送已暂停，静默属预期")
  if (o.flooded) return verdict(false, "429 冷却中，提示发不出去")
  if (!(waitStartedAt > 0)) return verdict(false, "缺少入队时间")
  if (waitedMs < QUEUE_PROGRESS_MIN_WAIT_MS) return verdict(false, "等待未超阈值")
  // R2854b：没有活动基线就不提示。入队时长 ≠ 静默时长；热重载后内存里的
  // lastActivity 为空，若按“一直静默”处理会立刻发出“已 N 分钟没有输出”的假消息。
  if (!(lastActivityAt > 0)) return verdict(false, "缺少活动基线")
  // 活动在入队之后且仍新鲜 → 回合还在产出，压住提示。活动早于入队则说明
  // 这轮等待期间没有任何新产出，按静默处理。
  if (lastActivityAt > waitStartedAt && silentMs < QUEUE_PROGRESS_QUIET_MS) {
    return verdict(false, "回合仍在产出")
  }
  if (lastNoticeAt > 0 && now - lastNoticeAt < QUEUE_PROGRESS_GAP_MS) {
    return verdict(false, "提示节流中")
  }
  return verdict(true, "队列等待超阈值且回合静默")
}

/**
 * 进度文案。只陈述可以证实的事实：静默了多久、还有几条在等、何时注入。
 * 不猜模型在做什么，也不承诺“马上就好”。
 *
 * R2858（运营者：「你有 80 分钟没有输出了吗？必须修」）：旧文案在静默时长
 * 未知（0）时退回用**等待时长**，于是「入队 80 分钟」被写成「80 分钟没有新的
 * Bot 输出」——而 03:51 现场 Bot 正在持续产出（proto catchup / assistant 事件
 * 都在动）。等待时长不是静默时长，两者不能互相冒充：未知时只写“一段时间”，
 * 绝不编造具体分钟数。生产路径由 `queueProgressDue` 保证只有真实静默才 due，
 * 这里再做最后一道防伪。
 */
export const queueProgressText = (queued: number, silentMs = 0): string => {
  const silent = Number(silentMs) > 0 ? Number(silentMs) : 0
  const n = Math.max(1, Math.floor(Number(queued) || 0))
  const head = silent > 0
    ? `⏳ 已 ${Math.max(1, Math.round(silent / 60_000))} 分钟没有新的 Bot 输出`
    : "⏳ 已有一段时间没有新的 Bot 输出"
  return (
    `${head}\n` +
    `📥 你还有 ${n} 条消息在队列，会在当前回合正常结束后按顺序注入。\n` +
    `查看队列：/queue · 中断本回合：/stop`
  )
}
