/**
 * 「上下文已压缩」通知的**文案判据 + 去重判据**（纯函数，供单测钉死）。
 *
 * R2667（运营者：「整理上下文压缩提示的格式，目前好像多种格式并行，有时候可能会
 * 在没有压缩时发送」）：同一场压缩会被四条探测路先后看到（宿主事件 / 自动压缩成功
 * 总线 / latestCompaction 时间戳 / ctx 骤降），旧实现各自拼标题与「怎么发现的」，
 * 且只有 180s 去重 → 实测同一场压缩在 4-6 分钟后又被 api/ctxdrop 发第二张卡，
 * 数字口径还不一样。这里统一成：
 *   · 一个标题「🗜 上下文已压缩」（不再出现「疑似压缩」另一种卡）
 *   · 一行水位 + 一行固定前缀「来源：…」
 *   · compactNoticeVerdict() 统一判「这次到底该不该发」：
 *     - api 时间戳过旧 / 不晚于已通知事件 → 是同一场压缩的迟到观测，不发
 *     - 已确认来源（event/autoc/api）刚报过 → ctx 骤降只是同一场的迟到证据，不发
 *     - 最近 180s 内任何来源 → 不发
 *
 * 语义约定（水位段仍由 compactWaterLine 一处实现，别在别处再拼一次）：
 *   · after <= 0  = **压缩后水位未知**（不是 0B）→ 只报压缩前，并明说未知
 *   · before > 0 且 after > 0 且 after < before → 报箭头 + 两个百分比
 *   · before > 0 且 after >= before → **不是压缩后水位**（样本未刷新）→ 明说"待刷新"
 *   · before <= 0 且 after > 0 → 压缩前未知，只报当前水位
 *   · 两者都 <= 0 → 只说发生过压缩，不给数字
 *
 * 另：百分比一律经 pctOf(window) 算，window 未知时给 "?"，不给 0%。
 */

export type CompactHow = "api" | "ctxdrop" | "event" | "autoc"

export const fmtK = (n: number): string => {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return `${Math.round(v)}B`
}

/** 百分比：窗口未知或数值为 0 时一律 "?" —— 拿不准就说拿不准，不编 0%。 */
export const pctOf = (n: number, win: number): string =>
  win > 0 && n > 0 ? `${Math.round((n / win) * 100)}%` : "?"

/** 通知正文的第一段（数字部分）。 */
export const compactWaterLine = (before: number, after: number, win: number): string => {
  if (after <= 0) {
    // 压缩后未知：只报压缩前，并**明说未知**。绝不写"现在只占 0B"。
    const head = before > 0 ? `压缩前占 ${fmtK(before)}　（${pctOf(before, win)}）` : "压缩前水位未知"
    return `${head}　· 压缩后水位未知`
  }
  if (before > 0 && after >= before) {
    // 样本尚未刷新（after 是"当前样本"而非"压缩后水位"）：绝不写成上升的箭头。
    return (
      `压缩前占 ${fmtK(before)}　（${pctOf(before, win)}）` +
      `　· 压缩后水位待刷新（当前样本 ${fmtK(after)}，${pctOf(after, win)}）`
    )
  }
  if (before > 0) return `${fmtK(before)} → ${fmtK(after)}　（${pctOf(before, win)} → ${pctOf(after, win)}）`
  return `现在只占 ${fmtK(after)}　（${pctOf(after, win)}）`
}

/** 日志里的箭头串：未知端用 "?"，避免以后 grep 到 `->0` 或 `0B->` 误读成"真的 0"。 */
export const compactLogDelta = (before: number, after: number): string =>
  `${before > 0 ? fmtK(before) : "?"}->${after > 0 ? fmtK(after) : "?"}`

/**
 * R2667：所有压缩卡共用同一个标题。ctxdrop 是**推断**而不是另一种事件，
 * 它只体现在来源行里（「来源：ctx 骤降推断」），不再另起「疑似压缩」卡。
 */
export const compactTitle = (_how?: CompactHow): string => "🗜 上下文已压缩"

/** 来源行：固定前缀 + 来源名 + 时间，四路同一格式。 */
export const compactSourceLine = (how: CompactHow, exact: string): string => {
  const when = exact || "刚刚"
  if (how === "api") return `来源：压缩接口 · ${when}`
  if (how === "event") return `来源：宿主压缩事件 · ${when}`
  if (how === "autoc") return `来源：自动压缩 · ${when}`
  return `来源：ctx 骤降推断 · ${when}`
}

/**
 * 通知正文：会话名 + 水位 + 来源，唯一拼装点。
 * 会话名**不要**在这里 htmlEsc —— 外层 protoBlock/renderProtoBlock 会统一转义一次；
 * 旧代码先 htmlEsc 再交给 protoBlock，名字里带 & 会被二次转义成 `&amp;amp;`。
 */
export const compactNoticeBody = (o: {
  name: string
  before: number
  after: number
  win: number
  how: CompactHow
  exact: string
}): string =>
  [`会话 ${o.name}`, "", compactWaterLine(o.before, o.after, o.win), compactSourceLine(o.how, o.exact)].join("\n")

export type CompactNoticeMark = { at: number; sentAt: number; how: CompactHow }

/**
 * R2667：这场压缩到底该不该发一条新卡？
 *
 * 观测到的真实重复（2026-11-16）：
 *   · bot6 event 05:43:30 已发，api 05:49:31 又拿 05:42:59 的同一时间戳发第二张
 *   · bot5 autoc 05:45:32 已发，ctxdrop 05:49:31 又把同一场压缩当新事件
 * 判据：
 *   · api 没有时间戳 / 时间戳超过 apiMaxAgeMs → 迟到观测，不发
 *   · at <= prev.at → 同一场（或更旧）压缩，不发
 *   · 距上次通知 < dedupeMs → 立即重复，不发
 *   · ctxdrop 且上次是已确认来源、还在 confirmedWindowMs 内 → 同一场的迟到证据，不发
 */
export const compactNoticeVerdict = (o: {
  how: CompactHow
  at: number
  now: number
  prev?: CompactNoticeMark | null
  dedupeMs: number
  confirmedWindowMs: number
  apiMaxAgeMs: number
}): { send: boolean; why: string } => {
  if (o.how === "api") {
    if (!(o.at > 0)) return { send: false, why: "api-no-time" }
    if (o.now - o.at > o.apiMaxAgeMs) return { send: false, why: "api-stale" }
  }
  const prev = o.prev
  if (prev) {
    if (o.at > 0 && o.at <= prev.at) return { send: false, why: "same-or-older-event" }
    if (o.now - prev.sentAt < o.dedupeMs) return { send: false, why: "dedupe" }
    if (o.how === "ctxdrop" && prev.how !== "ctxdrop" && o.now - prev.sentAt < o.confirmedWindowMs) {
      return { send: false, why: "confirmed-recent" }
    }
  }
  return { send: true, why: "send" }
}
