/**
 * R2778（运营者：「有没有办法让我看到会话 tg429 期间的消息…结束后给我一个
 * 期间的会话文件」）：把一个时间窗内的会话正文渲染成可下载的 Markdown 文件。
 *
 * 边界：
 *   · 纯函数，不读 DB、不触网、不写盘 —— 桥负责取消息与上传；
 *   · R2787 起按时间堆叠用户消息、注入提示、思考、助手正文/错误、压缩摘要与
 *     工具名称/状态；工具入参/结果与命令回复不导出（避免泄露内部载荷）；
 *   · 硬上限按“条数 + 字节”双重限制，并在文件尾部明确写出被截断，绝不假装完整。
 *
 * 为什么单独一个模块：这段逻辑既被自动恢复（floodWatchTick）使用，也被手动
 * `/export` 使用；如果各写一份，时间窗过滤/前缀清洗/截断规则必然会漂移。
 */

export type TranscriptOptions = {
  sessionID: string
  title?: string
  from: number
  to: number
  messages: readonly any[]
  /** 与桥一致的 `MM-DD HH:mm:ss` 格式化（time-format.ts）。 */
  fmtTime: (ms: unknown) => string
  heading?: string
  generatedAt?: number
  maxMessages?: number
  maxBytes?: number
  /** R2779：多会话合并文件用稳定的窗口名，而不是某一个会话 ID。 */
  filenameID?: string
}

export type TranscriptFile = {
  filename: string
  text: string
  count: number
  truncated: boolean
  from: number
  to: number
  /** R2781/R2787：文件实际覆盖的会话数（多会话堆叠模式才有意义）。 */
  sessions?: number
}

export const TRANSCRIPT_MAX_MESSAGES = 2000
export const TRANSCRIPT_MAX_BYTES = 1_500_000
const MAX_MESSAGE_CHARS = 20_000

const asMs = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const clip = (s: string, max: number): { text: string; clipped: boolean } => {
  if (s.length <= max) return { text: s, clipped: false }
  // 不切在代理对中间：Array.from 按码点切。
  return { text: Array.from(s).slice(0, max).join(""), clipped: true }
}

const stripTgPrefix = (s: string): string => s.replace(/^\[TG [^\]]*\]\s*/, "")

const errorText = (e: any): string => {
  if (!e) return ""
  if (typeof e === "string") return e
  try {
    return String(e.message ?? e.name ?? JSON.stringify(e))
  } catch {
    return ""
  }
}

const textOf = (m: any): string => {
  const parts: any[] = Array.isArray(m?.parts) ? m.parts : Array.isArray(m?.info?.parts) ? m.info.parts : []
  return parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p?.text ?? ""))
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .trim()
}

const loopInjected = (m: any): boolean => {
  const meta = m?.info?.metadata
  return Boolean(meta && typeof meta === "object" && typeof meta.loopInject === "string")
}

const messageTime = (m: any): { created: number; completed: number } => ({
  created: asMs(m?.info?.time?.created ?? m?.time?.created),
  completed: asMs(m?.info?.time?.completed ?? m?.time?.completed),
})

const inWindow = (m: any, from: number, to: number): boolean => {
  const t = messageTime(m)
  if (!t.created && !t.completed) return false
  // 覆盖三种情况：窗口内开始、窗口内结束、跨整个窗口的长回合。
  return (
    (t.created >= from && t.created <= to) ||
    (t.completed >= from && t.completed <= to) ||
    (t.created <= from && t.completed >= to)
  )
}

export const transcriptFilename = (sessionID: string, from: number, to: number): string => {
  const safeID = String(sessionID ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "session"
  const stamp = (ms: number): string => {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return "0"
    try {
      return new Date(n).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
    } catch {
      return "0"
    }
  }
  return `session-${safeID}-${stamp(from)}-${stamp(to)}.md`
}

export const buildTranscript = (o: TranscriptOptions): TranscriptFile => {
  const from = Math.min(asMs(o.from), asMs(o.to))
  const to = Math.max(asMs(o.from), asMs(o.to))
  const maxMessages = Math.min(10_000, Math.max(1, Math.floor(Number(o.maxMessages) || TRANSCRIPT_MAX_MESSAGES)))
  const maxBytes = Math.max(4096, Math.floor(Number(o.maxBytes) || TRANSCRIPT_MAX_BYTES))
  const fmt = (ms: number): string => {
    const s = o.fmtTime(ms)
    if (s) return s
    try {
      return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z")
    } catch {
      return "?"
    }
  }
  // R2787：单会话导出与 429 多会话导出共用同一套分类/堆叠规则，避免两个渲染器漂移。
  const items = collectInboundStack({
    from,
    to,
    sessions: [{ sessionID: String(o.sessionID ?? ""), title: o.title, messages: o.messages }],
  })

  const blocks: string[] = []
  let bytes = 0
  let truncated = items.length > maxMessages
  for (const x of items) {
    if (blocks.length >= maxMessages) {
      truncated = true
      break
    }
    const block = `## ${fmt(x.ts)} · ${x.label}\n\n${x.text}`
    const blockBytes = new TextEncoder().encode(block).length
    // 至少保留第一条：否则“有消息但文件为空”更难解释。
    if (blocks.length > 0 && bytes + blockBytes > maxBytes) {
      truncated = true
      break
    }
    blocks.push(block)
    bytes += blockBytes
  }

  const heading = String(o.heading ?? "会话记录").trim() || "会话记录"
  const generatedAt = asMs(o.generatedAt) || Date.now()
  const filenameID = String(o.filenameID ?? "").trim() || o.sessionID
  const count = blocks.length
  if (count === 0) {
    return { filename: transcriptFilename(filenameID, from, to), text: "", count: 0, truncated, from, to }
  }
  const header = [
    `# ${heading}`,
    "",
    `- 会话：${String(o.sessionID ?? "")}`,
    o.title ? `- 标题：${String(o.title)}` : "",
    `- 区间：${fmt(from)} – ${fmt(to)}`,
    `- 记录：${count} 条${truncated ? "（已截断）" : ""}`,
    `- 生成：${fmt(generatedAt)}`,
    "- 说明：按时间堆叠用户消息、注入提示、思考、助手正文/错误、压缩摘要与工具名称；工具入参/结果与命令回复未导出。",
  ]
    .filter(Boolean)
    .join("\n")
  const tail = truncated ? `\n\n---\n\n……（已截断：仅保留前 ${count} 条 / ${bytes} 字节）\n` : "\n"
  return {
    filename: transcriptFilename(filenameID, from, to),
    text: `${header}\n\n---\n\n${blocks.join("\n\n---\n\n")}${tail}`,
    count,
    truncated,
    from,
    to,
  }
}

/**
 * R2787（运营者：「会话的文件应该包含所有本来应该发到这个会话的信息（提示，思考....，
 * 注意堆叠，命令回复不用)和用户的信息」）：
 * 429 窗口/`/export` 的会话文件不再只导出用户消息，而是按时间**全局堆叠**：
 *   · 用户消息（TG/TUI，含排队中的待注入项）
 *   · 注入提示（自动循环/恢复/换会话/CI 恢复）
 *   · 助手正文、错误、思考（reasoning）
 *   · 压缩摘要
 *   · 工具名称/状态（不导出入参/结果，避免把内部载荷写进用户文件）
 * 命令回复不是会话内容（只存在于 TG 聊天），因此不会被导出。
 *
 * 判据：
 *   · `[TG …]` 前缀 = 真实 TG 用户消息；
 *   · `metadata.loopInject` 或循环提示固定前缀 = 自动循环提示；
 *   · 换会话/CI 恢复提示有固定开头；
 *   · 其余 synthetic 行 = 系统提示；其余 user 行 = TUI/宿主真实用户。
 */
export type InboundSession = {
  sessionID: string
  title?: string
  messages: readonly any[]
}

export type InboundPendingItem = {
  id?: string
  sid?: string
  ts: number
  text: string
  ctx?: string
  /** 正在注入（pininflight）而不是单纯排队。 */
  inflight?: boolean
  title?: string
}

export type InboundStackKind = "user" | "prompt" | "assistant" | "reasoning" | "error" | "compaction" | "tool"

export type InboundStackItem = {
  ts: number
  text: string
  sid: string
  title?: string
  pending?: boolean
  inflight?: boolean
  kind: InboundStackKind
  label: string
  /** 同一时间戳内的稳定顺序（消息顺序 / part 顺序）。 */
  order: number
}

export type InboundTranscriptOptions = {
  from: number
  to: number
  sessions: readonly InboundSession[]
  pending?: readonly InboundPendingItem[]
  fmtTime: (ms: unknown) => string
  heading?: string
  generatedAt?: number
  maxMessages?: number
  maxBytes?: number
  filenameID?: string
  botLabel?: string
}

const TG_INBOUND_RE = /^\[TG [^\]]*\]\s*/

export const isTgInboundText = (text: string): boolean => TG_INBOUND_RE.test(String(text ?? "").trimStart())

// 宿主把回复引用拼在 TG 前缀后面（`[TG user message] (回复引用：…) 正文`），
// 待注入条目则把引用放在 ctx 字段。比较去重与显示时都先归一掉它。
const stripReplyCtx = (s: string): string => s.replace(/^\(回复引用：[^)]*\)\s*/, "")
const inboundBody = (s: string): string => stripReplyCtx(stripTgPrefix(String(s ?? "").trim())).trim()

const LOOP_PROMPT_RE = /^(继续自动筛查循环|上一轮自动筛查应答因可恢复错误中断)/
const ROLLOVER_PROMPT_RE = /^阅读（ses_[^）]+）对话历史，继续任务/
const CI_RECOVERY_RE = /^CI 在上一回合/
const SHELL_NOTICE_RE = /<shell\b/i

const classifyUser = (m: any, raw: string): { kind: InboundStackKind; label: string; text: string } | null => {
  const info: any = m?.info ?? m
  const tg = isTgInboundText(raw)
  const synthetic = info?.synthetic === true || info?.type === "synthetic" || String(info?.role ?? "") === "synthetic"
  if (tg) return { kind: "user", label: "用户", text: inboundBody(raw) }
  if (loopInjected(m) || LOOP_PROMPT_RE.test(raw.trimStart())) {
    return { kind: "prompt", label: "提示（自动循环）", text: raw.trim() }
  }
  if (ROLLOVER_PROMPT_RE.test(raw.trimStart())) {
    return { kind: "prompt", label: "提示（换会话）", text: raw.trim() }
  }
  if (CI_RECOVERY_RE.test(raw.trimStart())) {
    return { kind: "prompt", label: "提示（CI 恢复）", text: raw.trim() }
  }
  if (SHELL_NOTICE_RE.test(raw)) return { kind: "prompt", label: "系统（后台命令）", text: raw.trim() }
  if (synthetic) return { kind: "prompt", label: "提示", text: raw.trim() }
  return { kind: "user", label: "用户", text: raw.trim() }
}

export const collectInboundStack = (o: {
  from: number
  to: number
  sessions: readonly InboundSession[]
  pending?: readonly InboundPendingItem[]
}): InboundStackItem[] => {
  const from = Math.min(asMs(o.from), asMs(o.to))
  const to = Math.max(asMs(o.from), asMs(o.to))
  const out: InboundStackItem[] = []
  const seen = new Set<string>()
  const knownSids = new Set((o.sessions ?? []).map((s) => String(s?.sessionID ?? "")).filter(Boolean))
  for (const s of o.sessions ?? []) {
    const sid = String(s?.sessionID ?? "")
    const rows = Array.isArray(s?.messages) ? s.messages : []
    let order = 0
    for (const m of rows) {
      if (!inWindow(m, from, to)) continue
      const info: any = m?.info ?? m
      const role = String(info?.role ?? "")
      const t = messageTime(m)
      const msgTs = t.created || t.completed
      if (!msgTs) continue
      const id = String(info?.id ?? m?.id ?? "")
      const push = (x: Omit<InboundStackItem, "sid" | "title" | "order">): void => {
        const key = id ? `${x.kind}:${id}:${order}` : ""
        if (key) {
          if (seen.has(key)) return
          seen.add(key)
        }
        out.push({ ...x, sid, title: s?.title, order: order++ })
      }
      if (info?.compaction === true) {
        const summary = String(info?.compactionSummary ?? info?.summary ?? "").replace(/\r\n?/g, "\n").trim()
        if (summary) {
          push({ ts: msgTs, text: clip(summary, MAX_MESSAGE_CHARS).text, kind: "compaction", label: "压缩摘要" })
        }
        continue
      }
      if (role === "user" || role === "synthetic") {
        const raw = textOf(m)
        if (!raw) continue
        const c = classifyUser(m, raw)
        if (!c) continue
        const text = clip(c.text, MAX_MESSAGE_CHARS).text.trim()
        if (!text) continue
        push({ ts: msgTs, text, kind: c.kind, label: c.label })
        continue
      }
      if (role !== "assistant") continue
      const parts: any[] = Array.isArray(m?.parts) ? m.parts : []
      for (const p of parts) {
        const typ = String(p?.type ?? "")
        const pTs = asMs(p?.time?.created) || msgTs
        if (typ === "reasoning") {
          const txt = String(p?.text ?? "").trim()
          if (txt) push({ ts: pTs, text: clip(txt, MAX_MESSAGE_CHARS).text, kind: "reasoning", label: "思考" })
          continue
        }
        if (typ === "text") {
          const txt = String(p?.text ?? "").trim()
          if (txt) push({ ts: pTs, text: clip(txt, MAX_MESSAGE_CHARS).text, kind: "assistant", label: "助手" })
          continue
        }
        if (typ === "tool") {
          const name = String(p?.tool ?? p?.name ?? "?").trim() || "?"
          const status = String(p?.state?.status ?? p?.status ?? "").trim()
          push({
            ts: pTs,
            text: `工具：${name}${status ? `（${status}）` : ""}`,
            kind: "tool",
            label: "工具",
          })
        }
      }
      const err = errorText(info?.error)
      if (err) push({ ts: msgTs, text: clip(err, MAX_MESSAGE_CHARS).text, kind: "error", label: "助手（错误）" })
    }
  }
  for (const p of o.pending ?? []) {
    const ts = asMs(p?.ts)
    if (!ts || ts < from || ts > to) continue
    const sid = String(p?.sid ?? "")
    // 只并入本次导出会话的待注入项；调用方没给会话时（纯队列导出）才全收。
    if (knownSids.size > 0 && !knownSids.has(sid)) continue
    const text = clip(inboundBody(String(p?.text ?? "")), MAX_MESSAGE_CHARS).text.trim()
    if (!text) continue
    const id = String(p?.id ?? "")
    const key = id ? `pending:${id}` : ""
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    // 刚送达的条目可能同时出现在会话行与 pininflight 里（泵在 promptAsync
    // 前后各落一次盘）。同会话、同正文、2 分钟内只保留会话行。
    const dup = out.some(
      (x) => !x.pending && x.kind !== "assistant" && x.kind !== "reasoning" && x.sid === sid && x.text === text && Math.abs(x.ts - ts) <= 120_000,
    )
    if (dup) continue
    out.push({
      ts,
      text,
      sid,
      title: p?.title,
      pending: true,
      inflight: p?.inflight === true,
      kind: "user",
      label: "用户",
      order: 1_000_000 + out.length,
    })
  }
  // 跨会话**全局**按时间排序；同一时间戳内保持会话内的消息/part 顺序。
  out.sort((a, b) => a.ts - b.ts || a.order - b.order || a.sid.localeCompare(b.sid))
  return out
}

export const buildInboundTranscript = (o: InboundTranscriptOptions): TranscriptFile => {
  const from = Math.min(asMs(o.from), asMs(o.to))
  const to = Math.max(asMs(o.from), asMs(o.to))
  const maxMessages = Math.min(10_000, Math.max(1, Math.floor(Number(o.maxMessages) || TRANSCRIPT_MAX_MESSAGES)))
  const maxBytes = Math.max(4096, Math.floor(Number(o.maxBytes) || TRANSCRIPT_MAX_BYTES))
  const fmt = (ms: number): string => {
    const s = o.fmtTime(ms)
    if (s) return s
    try {
      return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z")
    } catch {
      return "?"
    }
  }
  const sessions = Array.isArray(o.sessions) ? o.sessions : []
  const items = collectInboundStack({ from, to, sessions, pending: o.pending })
  const sids = [...new Set(items.map((x) => x.sid).filter(Boolean))]
  const multi = sids.length > 1
  const titleOf = new Map<string, string>()
  for (const s of sessions) titleOf.set(String(s?.sessionID ?? ""), String(s?.title ?? "").trim())
  const labelFor = (x: InboundStackItem): string => {
    const t = String(x.title ?? titleOf.get(x.sid) ?? "").trim()
    return t ? clip(t, 32).text : String(x.sid ?? "").slice(0, 12)
  }

  const blocks: string[] = []
  let bytes = 0
  let truncated = items.length > maxMessages
  for (const x of items) {
    if (blocks.length >= maxMessages) {
      truncated = true
      break
    }
    const tag = `${x.pending ? `用户（${x.inflight ? "正在注入" : "待注入"}）` : x.label}${multi ? ` · ${labelFor(x)}` : ""}`
    const block = `## ${fmt(x.ts)} · ${tag}\n\n${x.text}`
    const blockBytes = new TextEncoder().encode(block).length
    if (blocks.length > 0 && bytes + blockBytes > maxBytes) {
      truncated = true
      break
    }
    blocks.push(block)
    bytes += blockBytes
  }

  const heading = String(o.heading ?? "TG 429 期间会话记录").trim() || "TG 429 期间会话记录"
  const generatedAt = asMs(o.generatedAt) || Date.now()
  const filenameID = String(o.filenameID ?? "").trim() || "session"
  const count = blocks.length
  const filename = transcriptFilename(filenameID, from, to)
  if (count === 0) return { filename, text: "", count: 0, truncated, from, to, sessions: 0 }
  const header = [
    `# ${heading}`,
    "",
    o.botLabel ? `- Bot：${String(o.botLabel)}` : "",
    multi ? `- 会话：${sids.length} 个` : `- 会话：${sids[0] ?? ""}`,
    `- 区间：${fmt(from)} – ${fmt(to)}`,
    `- 记录：${count} 条${truncated ? "（已截断）" : ""}`,
    `- 生成：${fmt(generatedAt)}`,
    "- 说明：按时间堆叠窗口内的用户消息、注入提示（自动循环/恢复/换会话/CI 恢复）、思考、助手正文/错误、压缩摘要与工具名称；工具入参/结果与命令回复未导出。「待注入」是导出时仍在队列里的消息。",
  ]
    .filter(Boolean)
    .join("\n")
  const tail = truncated ? `\n\n---\n\n……（已截断：仅保留前 ${count} 条 / ${bytes} 字节）\n` : "\n"
  return {
    filename,
    text: `${header}\n\n---\n\n${blocks.join("\n\n---\n\n")}${tail}`,
    count,
    truncated,
    from,
    to,
    sessions: sids.length,
  }
}
