/**
 * R2874（运营者：「22：55：34的重复消息来源深度探测，并且修复」）：
 * 卡片去重指纹必须包含标题里的生产钟。
 *
 * 现场（bot6 / ses_e06936a97… / msg_1f973871d…）：
 *   · reasoning.completed = 14:55:34.678 → 🧠 思考标题 22:55:34；
 *   · text part 没有 time，流式/补扫首推时 productionClock 只能退回
 *     msg.time.created（14:54:20）→ 💬 回复标题 22:54:20；
 *   · 消息完成后 msg.time.completed 可用，标题本应刷新为 22:55:34，
 *     但正文文本一字未变，旧去重只比文本 → 这一拍被吞。
 * 用户侧于是同时看到同一条消息的两张卡钟点不一致（22:55:34 / 22:54:20）。
 *
 * 语义：无时钟的卡完全沿用旧行为；有时钟的卡把时钟并进去重值。
 * key 不变 → protoMap 命中 prev → 走 editTextRaw 只改标题，不会新发一张卡。
 */
import { titleClockOf } from "./title-clock"

/** 从渲染后的卡片文本里取参与去重的生产钟；状态卡等非刷新时钟返回空串。 */
export const sendStamp = (text: unknown): string => titleClockOf(text)

/** 去重值：无时钟时就是原文；有时钟时拼接 NUL 分隔的时钟。 */
export const dedupValue = (text: string, stamp: string): string =>
  stamp ? `${text}\u0000${stamp}` : text

/** 上一次落地的值是否与本次相同（true = 跳过；false = 发送/编辑）。 */
export const dedupEqual = (prev: string | undefined, text: string, stamp: string): boolean =>
  prev === dedupValue(text, stamp)
