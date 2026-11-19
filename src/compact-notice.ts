/**
 * 「上下文已压缩」通知的**文案判据 + 去重判据**（纯函数，供单测钉死）。
 *
 * R2667（运营者：「整理上下文压缩提示的格式，目前好像多种格式并行，有时候可能会
 * 在没有压缩时发送」）：同一场压缩会被四条探测路先后看到（宿主事件 / 自动压缩成功
 * 总线 / latestCompaction 时间戳 / ctx 骤降），旧实现各自拼标题与「怎么发现的」，
 * 且只有 180s 去重 → 实测同一场压缩在 4-6 分钟后又被 api/ctxdrop 发第二张卡，
 * 数字口径还不一样。这里统一成：
 *   · 一个标题「🗜 已压缩」（不再出现「疑似压缩」另一种卡）
 *   · 单行正文：水位 + 会话名 + 2 字来源标签（R2747 起；旧版是 4-5 行）
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

/** 通知正文的第一段（数字部分）。
 *
 * R2747（运营者：「继续缩短，压缩也可以缩短」）：这里原来用全角空格 + 整句
 * 「压缩前占/压缩后水位未知」，一张卡 4-5 行。现在压成一条水位：箭头两端
 * 直接给数字/百分比，未知端写 `?`（绝不含糊成 0B），待刷新才保留短注解。
 */
export const compactWaterLine = (before: number, after: number, win: number): string => {
  if (after <= 0) {
    // 压缩后未知：只报压缩前，未知端用 `?`。绝不写"现在只占 0B"。
    if (before <= 0) return "水位未知"
    return `${fmtK(before)}（${pctOf(before, win)}）→ ?`
  }
  if (before > 0 && after >= before) {
    // 样本尚未刷新（after 是"当前样本"而非"压缩后水位"）：绝不写成上升的箭头。
    return `${fmtK(before)}（${pctOf(before, win)}）→ 待刷新（现 ${fmtK(after)}，${pctOf(after, win)}）`
  }
  if (before > 0) return `${fmtK(before)}→${fmtK(after)}（${pctOf(before, win)}→${pctOf(after, win)}）`
  return `现 ${fmtK(after)}（${pctOf(after, win)}）`
}

/** 日志里的箭头串：未知端用 "?"，避免以后 grep 到 `->0` 或 `0B->` 误读成"真的 0"。 */
export const compactLogDelta = (before: number, after: number): string =>
  `${before > 0 ? fmtK(before) : "?"}->${after > 0 ? fmtK(after) : "?"}`

/**
 * R2667：所有压缩卡共用同一个标题。ctxdrop 是**推断**而不是另一种事件，
 * 它只体现在来源标签里（`ctx`），不再另起「疑似压缩」卡。
 * R2747：运营者要求继续缩短 —— `上下文已压缩` → `已压缩`。
 */
export const compactTitle = (_how?: CompactHow): string => "🗜 已压缩"

/** 来源标签：固定短词 + 无需时间（消息本身有发送时间），四路同一格式。
 *  R2747：旧版是整句「来源：宿主压缩事件 · 2026-…Z」，单这一行就比水位长；
 *  压缩是低频事件，来源只用于排障，缩成 2 字足够分辨四路。 */
export const compactSourceLine = (how: CompactHow, _exact?: string): string => {
  if (how === "api") return "接口"
  if (how === "event") return "事件"
  if (how === "autoc") return "自动"
  return "ctx"
}

/**
 * 通知正文：水位 + 会话名 + 来源，唯一拼装点（R2747 起单行）。
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
}): string => {
  const parts = [compactWaterLine(o.before, o.after, o.win)]
  const name = String(o.name ?? "").trim()
  if (name) parts.push(name)
  parts.push(compactSourceLine(o.how, o.exact))
  return parts.join(" · ")
}

/**
 * R2767（运营者：「压缩的正文内容为什么不发了？」）：压缩通知长期只有一行水位，
 * 摘要只在 /compaction、/replay 的专用卡片里出现。v2 把压缩改成独立消息类型后，
 * 自动路径（event/autoc/api/ctxdrop）从来没有把摘要交给推送层 —— 于是正文消失。
 *
 * 这里只做**纯判据**：这条摘要到底是不是"本次事件那一场"压缩的。
 * 时间来源不同（api=行时间；autoc/event=宿主完成/总线时间；ctxdrop=水位骤降观测，
 * 可能晚 4-6 分钟），所以允许 eventAt 之前一个窗口；但绝不允许把更早的一场压缩
 * 摘要贴到新通知上（`rowAt` 必须足够新），也不接受晚于事件的未来时间戳。
 */
export const compactSummaryMatches = (o: {
  /** 压缩行的 time.created。 */
  rowAt: number
  /** 触发本次通知的事件时间。 */
  eventAt: number
  how: CompactHow
  /** 允许比事件早多久（默认 ctxdrop 15 分钟、其余 5 分钟）。 */
  backMs?: number
}): boolean => {
  const rowAt = Number(o.rowAt)
  const eventAt = Number(o.eventAt)
  if (!(rowAt > 0) || !(eventAt > 0)) return false
  // ctxdrop 只能靠水位骤降推断，实测可晚 4-6 分钟；其余三路的事件时间
  // 就是压缩完成/落盘时间（或 api 行时间本身），5 分钟足够，且能挡住上一场。
  const back = o.backMs ?? (o.how === "ctxdrop" ? 15 * 60_000 : 5 * 60_000)
  return rowAt >= eventAt - back && rowAt <= eventAt + 2 * 60_000
}

/** 摘要正文上限：超过也只截一次并明说截了多少（不静默丢正文）。 */
export const COMPACT_SUMMARY_MAX_CHARS = 14_000

/**
 * 通知行 + 摘要正文的唯一拼装点。
 *  · 摘要为空 → 保持原样（只有一行通知，行为与 R2747 一致）；
 *  · 有摘要 → 空行分隔，正文原样跟在通知行后面（调用方负责 Markdown→HTML）；
 *  · 超长 → 截到 `maxChars` 并追加 `[已截断 N 字]`。
 */
export const compactSummaryBody = (o: {
  notice: string
  summary: string
  maxChars?: number
}): string => {
  const notice = String(o.notice ?? "").trim()
  const raw = String(o.summary ?? "").trim()
  if (!raw) return notice
  const max = Math.max(1, Number(o.maxChars) || COMPACT_SUMMARY_MAX_CHARS)
  const summary = raw.length > max ? `${raw.slice(0, max)}\n[已截断 ${raw.length - max} 字]` : raw
  return notice ? `${notice}\n\n${summary}` : summary
}

export type CompactNoticeMark = {
  at: number
  sentAt: number
  how: CompactHow
  /**
   * R2767：这条通知**已经投递过摘要**的那一场压缩的 time.created。
   * 缺省 = 还没发过摘要（例如通知发出时宿主还在写摘要）→ 迟到的 api/ctxdrop
   * 探测看到摘要后可以补发一次。落盘（cnotice），重载后不重复。
   */
  summaryAt?: number
}

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
