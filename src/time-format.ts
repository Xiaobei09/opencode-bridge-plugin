/**
 * R2686：用户可见时间的**唯一格式化实现**（纯函数，无业务依赖）。
 *
 * R2685 把时区统一到 Asia/Shanghai 时，tg-bridge 与 exit-proxy 各自复制了一份
 * `Intl.DateTimeFormat("en-GB", { timeZone, ... })`。行为虽然相同，但这是最容易
 * 再次漂移的一类代码：卡片显示 `MM-DD HH:mm:ss`、出口面板只要时间、日志要
 * `HH:mm:ss`，任何一处漏改就会重新出现“同一屏两个地区”。
 *
 * 设计：
 *   · `createTimeFormats(tz)` 返回一组的格式化函数，tz 由调用方决定来源
 *     （tg-bridge 支持 tg.env 的 TG_TZ；exit-proxy 只读进程环境）；
 *   · 非法/缺失毫秒返回空串，非法 ISO 返回原文（调用方可用 `|| "?"` 兜底）；
 *   · 时区非法时 Intl 抛错被吞掉并返回空串 —— 展示层永不因格式化崩溃。
 */
export const DEFAULT_TZ = "Asia/Shanghai"

export type TimeFormats = {
  /** `HH:mm:ss`，用于工具卡标题/日志。 */
  fmtClock: (ms: unknown) => string
  /** `MM-DD HH:mm:ss`，用于循环卡、注入提示、压缩卡、守卫等用户可见时间。 */
  fmtTime: (ms: unknown) => string
  /** 把 ISO/日期字符串转成 `MM-DD HH:mm:ss`；无法解析时原样返回。 */
  fmtIsoTime: (iso: unknown) => string
}

export const createTimeFormats = (tz: string): TimeFormats => {
  const zone = String(tz ?? "").trim() || DEFAULT_TZ

  const partsOf = (ms: unknown, opts: Intl.DateTimeFormatOptions): Record<string, string> | null => {
    const t = Number(ms)
    if (!Number.isFinite(t) || t <= 0) return null
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour12: false,
        ...opts,
      }).formatToParts(new Date(t))
      const out: Record<string, string> = {}
      for (const p of parts) if (p.type !== "literal") out[p.type] = p.value
      return out
    } catch {
      return null
    }
  }

  const fmtClock = (ms: unknown): string => {
    const p = partsOf(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    return p ? `${p.hour}:${p.minute}:${p.second}` : ""
  }

  const fmtTime = (ms: unknown): string => {
    const p = partsOf(ms, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    return p ? `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : ""
  }

  const fmtIsoTime = (iso: unknown): string => {
    const raw = String(iso ?? "")
    const t = Date.parse(raw)
    const out = Number.isFinite(t) && t > 0 ? fmtTime(t) : ""
    // 时区非法等情况 fmtTime 会返回空串；此时保留原始时间串比显示空更像诊断信息。
    return out || raw
  }

  return { fmtClock, fmtTime, fmtIsoTime }
}
