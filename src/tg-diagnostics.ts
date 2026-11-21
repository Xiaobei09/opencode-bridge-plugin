// R2707：诊断命令（/drops /errors /owner /logs /offset /whoami）的文案与读取从桥内上收。
// 这些命令只读不写：输出格式统一在这里，桥只负责取参数与发送。
import { readFileSync } from "node:fs"
import { redactSecrets } from "./log-safe"

export type DropEntry = { ts: number; kind: string; detail: string }
export type ErrorEntry = { ts: number; msg: string }

/** R2850：/status 的只读快照。桥负责取运行态，格式化保持纯函数可测。 */
export type BotStatusInfo = {
  bot: string
  chat: string
  offset: number
  active: string
  front: string
  pinned: boolean
  paused: boolean
  loop: { stopped: boolean; by: string; reason: string }
  sessionLoop: "on" | "off" | "halt" | "none"
  pinPending: number
  pinHeld: number
  pinInflight: number
  outQueue: number
  cards: number
  events: number
  lastPush: number
  lastInbound: number
  inbound: { total: number; command: number; text: number; dropped: number; outbound: number; outboundFail: number }
  uptimeMs: number
  ownerPath: string
  lastError?: ErrorEntry
}

/** 运行时长（紧凑格式，便于手机上单行阅读）。 */
export const formatUptime = (ms: number): string => {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

export type DiagnosticsDeps = {
  /** 时间格式：桥解析 TG_TZ 后注入（单一真源）。 */
  fmtTime: (ms: number) => string
  /** 日志脱敏：桥持有本进程 token，必须注入。 */
  sanitizeLog: (s: unknown) => string
  /** 本进程 token（/logs 原文精确抹除；空串=未配置）。 */
  token: () => string
  version: () => string
}

export const createDiagnostics = (deps: DiagnosticsDeps) => {
  const { fmtTime, sanitizeLog, token, version } = deps

  const dropsText = (ring: readonly DropEntry[]): string => {
    if (ring.length === 0) return "发送失败（0）"
    const lines = ["发送失败（最近）"]
    for (const d of ring.slice(-10)) lines.push(`· [${fmtTime(d.ts) || "?"}] ${d.kind}: ${d.detail}`.slice(0, 300))
    return lines.join("\n")
  }

  const errorsText = (ring: readonly ErrorEntry[], n: number): string => {
    if (ring.length === 0) return "错误（0）"
    const lines = ["错误（最近）"]
    for (const e of ring.slice(-n)) lines.push(`· [${fmtTime(e.ts) || "?"}] ${e.msg}`.slice(0, 300))
    return lines.join("\n")
  }

  const ownerText = (path: string): string => {
    let info = "(file missing)"
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as any
      const fmtOwn = (o: any): string => {
        if (!o || typeof o.id !== "string") return "(none)"
        const age = typeof o.ts === "number" ? `${Math.round((Date.now() - o.ts) / 1000)}s前` : "?"
        return `${o.id.slice(0, 12)}（${age}）`
      }
      info = `tg=${fmtOwn(j?.tg)} ac=${fmtOwn(j?.ac)}`
    } catch (err) {
      info = `读取失败：${sanitizeLog(err).slice(0, 100)}`
    }
    return `owner：${info}`
  }

  const offsetText = (offset: number): string => `offset=${offset}`

  const logsText = (path: string, n: number): string => {
    let lines: string[] = []
    try {
      const data = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "")
      lines = data.slice(-n)
    } catch (err) {
      return `日志读取失败：${sanitizeLog(err).slice(0, 100)}`
    }
    if (lines.length === 0) return "日志（空）"
    // R1845：/logs 读的是**宿主**插件日志（TAP_PATH）—— 里面可能夹带其它插件/undici 写的
    // 原始 fetch URL（含 bot token）或用户粘贴的密钥，这些行**没经过**本插件的 log() 出口脱敏。
    // 直接把原文发到 Telegram = 把可能泄露的密钥送到 TG 服务器。发送前统一脱敏：
    //   redactSecrets 抹 token 形态；再按本进程真实 TOKEN 精确抹除（不赌形态匹配）。
    const tok = token()
    const dump = lines.join("\n")
    const safeDump = tok.length >= 20 ? dump.split(tok).join("<TOKEN>") : dump
    return `日志（近 ${lines.length} 行）\n${redactSecrets(safeDump).slice(-3500)}`
  }

  const whoamiText = (o: { chatID: string; target?: string; pinned: boolean }): string =>
    [
      "当前身份",
      `· chat=${sanitizeLog(o.chatID)}`,
      `· 目标=${(o.target || "-").slice(0, 12)}${o.pinned ? "（已固定）" : ""}`,
      `· ver=${version()}`,
    ].join("\n")

  /** R2850（运营者：「有没有办法主动查看bot状态」）：只读总览，不改前台/队列/循环。 */
  const statusText = (o: BotStatusInfo): string => {
    const short = (sid: string): string => (sid || "-").replace(/^ses_/, "").slice(0, 12) || "-"
    const gate = o.loop.stopped
      ? `已停${o.loop.by ? `（${sanitizeLog(o.loop.by).slice(0, 12)}）` : ""}${o.loop.reason ? ` · ${sanitizeLog(o.loop.reason).slice(0, 48)}` : ""}`
      : "运行中"
    const scope =
      o.sessionLoop === "on" ? "开" : o.sessionLoop === "off" ? "关" : o.sessionLoop === "halt" ? "已停（⏹）" : "未选会话"
    const at = (ms: number): string => (ms > 0 ? fmtTime(ms) || "-" : "-")
    const lines = [
      `🩺 ${sanitizeLog(o.bot)} · ver=${version()} · 宿主 ${formatUptime(o.uptimeMs)}`,
      `· push=${sanitizeLog(o.chat) || "-"} · offset=${o.offset}`,
      `· 活动=${short(o.active)} · 前台=${short(o.front)}${o.pinned ? "（固定）" : ""}`,
      `· 循环=${gate} · 本会话=${scope} · 推送=${o.paused ? "已暂停" : "推送中"}`,
      `· 注入=${o.pinPending}${o.pinHeld > 0 ? `（挂起 ${o.pinHeld}）` : ""} · 在途=${o.pinInflight} · 外发=${o.outQueue} · 卡片=${o.cards}`,
      `· 事件=${o.events} · 最近推送=${at(o.lastPush)} · 最近入站=${at(o.lastInbound)}`,
      `· 入站=${o.inbound.total}（命令 ${o.inbound.command} · 文本 ${o.inbound.text} · 丢弃 ${o.inbound.dropped}） · 发送=${o.inbound.outbound}（失败 ${o.inbound.outboundFail}）`,
      ownerText(o.ownerPath),
    ]
    if (o.lastError) lines.push(`· 最近错误：[${fmtTime(o.lastError.ts) || "?"}] ${sanitizeLog(o.lastError.msg).slice(0, 120)}`)
    return lines.join("\n")
  }

  return { dropsText, errorsText, ownerText, offsetText, logsText, whoamiText, statusText }
}
