/**
 * 「上下文已压缩」通知的**文案判据**（纯函数，供单测钉死）。
 *
 * 为什么要抽出来：这段文案里混着"真水位"和"**未知**"两种数，而未知历史上被当成 0
 * 报给用户过一次。原文的守卫写成 `how === "event" && after <= 0` —— 只护住 event 路；
 * 可 `api` 路同样会拿到未知值（`uNow ? ctxTotal(uNow) : 0`，拿不到 usage 时就是 0），
 * 那时文案会走"现在只占 0B"分支，**正是这段代码自己注释里说"绝不能编造"的假数据**。
 *
 * 语义约定（全部由 compactNoticeBody 一处实现，别在别处再拼一次）：
 *   · after <= 0  = **压缩后水位未知**（不是 0B）→ 只报压缩前，并明说未知
 *   · before > 0 且 after > 0 → 报箭头 + 两个百分比
 *   · before <= 0 且 after > 0 → 压缩前未知，只报当前水位
 *   · 两者都 <= 0 → 只说发生过压缩，不给数字
 *
 * 另：百分比一律经 pctOf(window) 算，window 未知时给 "?"，不给 0%。
 */

export type CompactHow = "api" | "ctxdrop" | "event"

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
  if (before > 0) return `${fmtK(before)} → ${fmtK(after)}　（${pctOf(before, win)} → ${pctOf(after, win)}）`
  return `现在只占 ${fmtK(after)}　（${pctOf(after, win)}）`
}

/** 日志里的箭头串：未知端用 "?"，避免以后 grep 到 `->0` 误读成"真的降到 0"。 */
export const compactLogDelta = (before: number, after: number): string =>
  `${fmtK(before)}->${after > 0 ? fmtK(after) : "?"}`

/** 第二段：这条压缩是怎么发现的（决定用户该信多少）。 */
export const compactHowLine = (how: CompactHow, exact: string): string => {
  if (how === "api") return `压缩接口报告的时间：${exact}`
  if (how === "event") return `<i>宿主直接报告了压缩事件（最可靠的信号）—— 压缩后的水位由下一条回复重建。</i>`
  return `<i>这次是靠 ctx 骤降发现的 —— 压缩接口没报这个事件（已记进日志，属接口漏报）。</i>`
}

export const compactTitle = (how: CompactHow): string =>
  how === "ctxdrop" ? "🗜 上下文骤降（疑似压缩）" : "🗜 上下文已压缩"
