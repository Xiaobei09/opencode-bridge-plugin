/**
 * R2841（运营者：「奇怪，思考的时间不刷新吗，改回会刷新的」）：
 * 撤销 R2836 的标题时钟冻结，思考卡标题随最新内容刷新。
 *
 * 背景：`ptitle` 用 `productionClock(p,m)`（part.completed 优先）。R2836 曾把
 * 同一 message_id 的后续编辑冻结到首次发送时钟，避免标题时间晚于 Telegram
 * 显示的发送时刻；运营者现在反馈思考卡时间不刷新，要求改回会刷新的行为。
 *
 * 语义：标题时钟 = 本次内容的生产时刻，同一 message_id 的编辑也允许前进；
 * 重新堆叠仍是新消息，使用新的生产时刻。`clock` 字段继续持久化，但只记录
 * **最近一次显示**的时钟，不再用于覆盖标题。
 *
 * 只认标题里的第一个 ` · HH:MM:SS`；工具卡的「开始 HH:MM:SS」、状态卡的
 * `MM-DD HH:mm:ss` 和「（补发 …）」括注都不动。
 */
const TITLE_CLOCK_RE = /( · )(\d{2}:\d{2}:\d{2})(?= · |（|<\/b>|$)/

/** 取标题里第一个可刷新的时钟；没有返回空串。 */
export const titleClockOf = (text: unknown): string => {
  const m = TITLE_CLOCK_RE.exec(String(text ?? ""))
  return m?.[2] ?? ""
}
