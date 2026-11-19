/**
 * R2836（运营者：「🧠 思考· 14:22:43 … 这条消息是14：19分发的，怎么可能14：22」）：
 * 卡片标题时钟在**第一次发送**时冻结。
 *
 * 背景：`ptitle` 用 `productionClock(p,m)`（part.completed 优先）。流式卡每来一个
 * chunk 就重算标题并 edit 同一条 TG 消息，时钟随最新 chunk 往后走；合并链更是每
 * 合并一条就换成新 part 的时间。结果：用户在 14:19 看到的那条消息，标题最终写着
 * 14:22:43 —— 与 Telegram 自己显示的发送时刻（14:19）矛盾。
 *
 * 语义：标题时钟 = 这张卡**首次出现在聊天里的生产时刻**。同一 message_id 的后续
 * 编辑不再改时钟；重新堆叠会发新消息，新消息用新的生产时刻。R2673 的「时间标记
 * 为最后时间」只保留给**新消息**（restack），不再改写已存在消息的时钟。
 *
 * 只认标题里的第一个 ` · HH:MM:SS`；工具卡的「开始 HH:MM:SS」、状态卡的
 * `MM-DD HH:mm:ss` 和「（补发 …）」括注都不动。
 */
const TITLE_CLOCK_RE = /( · )(\d{2}:\d{2}:\d{2})(?= · |（|<\/b>|$)/

/** 取标题里第一个可冻结的时钟；没有返回空串。 */
export const titleClockOf = (text: unknown): string => {
  const m = TITLE_CLOCK_RE.exec(String(text ?? ""))
  return m?.[2] ?? ""
}

/** 把标题里的第一个可冻结时钟替换成 clock；clock 缺失/非法时原样返回。 */
export const freezeTitleClock = (text: unknown, clock: unknown): string => {
  const src = String(text ?? "")
  const c = String(clock ?? "").trim()
  if (!/^\d{2}:\d{2}:\d{2}$/.test(c)) return src
  return src.replace(TITLE_CLOCK_RE, `$1${c}`)
}
