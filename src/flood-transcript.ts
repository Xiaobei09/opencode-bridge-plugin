/**
 * R2778（运营者：「有没有办法让我看到会话 tg429 期间的消息…结束后给我一个
 * 期间的会话文件」）：把一个时间窗内的会话正文渲染成可下载的 Markdown 文件。
 *
 * 边界：
 *   · 纯函数，不读 DB、不触网、不写盘 —— 桥负责取消息与上传；
 *   · R2787 起按时间堆叠用户消息、注入提示、思考、助手正文/错误、压缩摘要与
 *     工具卡片；命令回复不导出（只存在于 TG 聊天）；
 *   · R2852 起默认 `mode="tg"`：只渲染当前 TG 推送过滤下真正会出现在聊天里的
 *     内容（用户消息、助手正文、错误、压缩；回复/思考/工具/完成按档位取舍），
 *     并像 TG 一样用「💬 回复 / 🧠 思考 / 🔧 工具 / ✅ 完成」标题；
 *     `mode="full"` 保留旧的全量记录（含内部注入提示）。
 *   · R2852 起默认不截断：不按条数/字节/单条字符数丢内容。显式传入
 *     `maxMessages`/`maxBytes` 时仍截断（只用于测试或调用方明确要求）。
 *     超过 Telegram 单文件上限时由桥按 40MB 分卷上传，内容本身不丢。
 *
 * 为什么单独一个模块：这段逻辑既被自动恢复（floodWatchTick）使用，也被手动
 * `/export` 使用；如果各写一份，时间窗过滤/前缀清洗/截断规则必然会漂移。
 */

export type TranscriptMode = "tg" | "full"

/** R2852：与桥的四类推送过滤同口径（0=隐去，1=仅标题，2=全部）。 */
export type TranscriptFilters = {
  reply: number
  think: number
  tool: number
  status: number
}

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
  /** R2852：默认模拟 TG；`full` = 全量会话记录。 */
  mode?: TranscriptMode
  /** R2852：当前 Bot 的推送过滤档位；缺省按全开。 */
  filters?: Partial<TranscriptFilters>
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

/** R2852：默认不限制；仅当调用方显式传 maxMessages/maxBytes 时截断。 */
export const TRANSCRIPT_MAX_MESSAGES = Number.POSITIVE_INFINITY
export const TRANSCRIPT_MAX_BYTES = Number.POSITIVE_INFINITY
/** R2852：Telegram 单文件上限 50MB；留余量后按 40MB 分卷，绝不截断内容。 */
export const TRANSCRIPT_UPLOAD_PART_BYTES = 40 * 1024 * 1024

const asMs = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const clip = (s: string, max: number): { text: string; clipped: boolean } => {
  if (s.length <= max) return { text: s, clipped: false }
  // 不切在代理对中间：Array.from 按码点切。
  return { text: Array.from(s).slice(0, max).join(""), clipped: true }
}

/** R2852：过滤档位只认 0/1/2，非法值按“全部”处理（与桥的 filt 同口径）。 */
const filterLevel = (v: unknown): 0 | 1 | 2 => {
  const n = Number(v)
  return n === 0 ? 0 : n === 1 ? 1 : 2
}

const FILTER_STATE_LABEL = ["隐去", "仅标题", "全部"] as const

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

const jsonText = (v: any): string => {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    try {
      return String(v)
    } catch {
      return ""
    }
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

/** R2852：文件名的后缀必须区分模式，下载后才不会把模拟 TG 当成完整记录。 */
export const transcriptFilename = (sessionID: string, from: number, to: number, mode?: TranscriptMode): string => {
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
  const suffix = mode === "full" ? "-full" : mode === "tg" ? "-tg" : ""
  return `session-${safeID}-${stamp(from)}-${stamp(to)}${suffix}.md`
}

export const buildTranscript = (o: TranscriptOptions): TranscriptFile => {
  // R2852：单会话/多会话共用同一个渲染器，避免过滤与截断规则再次分叉。
  return buildInboundTranscript({
    from: o.from,
    to: o.to,
    sessions: [{ sessionID: String(o.sessionID ?? ""), title: o.title, messages: o.messages }],
    fmtTime: o.fmtTime,
    heading: o.heading ?? "会话记录",
    generatedAt: o.generatedAt,
    maxMessages: o.maxMessages,
    maxBytes: o.maxBytes,
    filenameID: o.filenameID ?? o.sessionID,
    mode: o.mode,
    filters: o.filters,
  })
}

/**
 * R2787（运营者：「会话的文件应该包含所有本来应该发到这个会话的信息（提示，思考....，
 * 注意堆叠，命令回复不用)和用户的信息」）：
 * 429 窗口/`/export` 的会话文件不再只导出用户消息，而是按时间**全局堆叠**：
 *   · 用户消息（TG/TUI，含排队中的待注入项）
 *   · 注入提示（自动循环/恢复/换会话/CI 恢复）
 *   · 助手正文、错误、思考（reasoning）
 *   · 压缩摘要
 *   · 工具卡片（名称/状态/入参/结果，与 TG 卡片同源）
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

export type InboundStackKind = "user" | "prompt" | "assistant" | "reasoning" | "error" | "compaction" | "tool" | "status"

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
  /** R2852：工具名（模拟 TG 标题要写「🔧 Shell 执行」）。 */
  toolName?: string
  /** R2852：question 工具在桥上任何过滤档位都必须送达，文件里也不能被过滤掉。 */
  force?: boolean
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
  /** R2852：默认模拟 TG；`full` = 全量会话记录。 */
  mode?: TranscriptMode
  /** R2852：当前 Bot 的推送过滤档位；缺省按全开。 */
  filters?: Partial<TranscriptFilters>
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

/** R2852：与 turn-end-note.extractRound 同口径，用于「✅ 完成」卡的 round 行。 */
const roundOf = (text: string): string => {
  const m = String(text ?? "").match(/\[ROUND\s*(?:R\s*)?(\d+)\]/i)
  return m ? m[1]! : ""
}

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

/** R2852：工具卡正文与桥实际推送的内容对齐（状态/入参/结果/错误），不丢载荷。 */
const toolCardText = (p: any): string => {
  const st: any = p?.state ?? {}
  const name = String(p?.tool ?? p?.name ?? "?").trim() || "?"
  const status = String(st.status ?? p?.status ?? "").trim()
  const title = String(st.title ?? "").trim()
  const lines = [`工具：${name}`]
  if (status) lines.push(`状态：${status}`)
  if (title) lines.push(`标题：${title}`)
  const input = st.input ?? st.input_text ?? st.arguments ?? st.args
  if (input != null && (typeof input !== "string" || input.trim() !== "")) {
    lines.push(`输入：\n${jsonText(input).trimEnd()}`)
  }
  if (st.output != null && (typeof st.output !== "string" || st.output.trim() !== "")) {
    lines.push(`输出：\n${jsonText(st.output).trimEnd()}`)
  }
  const err = st.error != null && String(st.error) !== "" ? String(st.error) : ""
  if (err) lines.push(`错误：${err}`)
  if (status === "running" || status === "pending") lines.push("⏳ 执行中…")
  return lines.join("\n")
}

/** R2852：「✅ 完成」卡正文与桥一致（reason/round/step/tokens/cost/status）。 */
const statusCardText = (p: any, round: string): string => {
  const st: any = p?.state ?? {}
  const reason = String(st.reason ?? p?.reason ?? "completed").trim() || "completed"
  const stepN = String(st.step ?? p?.step ?? "").trim()
  const toks = st.tokens ?? p?.tokens
  const cost = st.cost ?? p?.cost
  const lines = [`reason: ${reason}`]
  if (round) lines.push(`round: ${round}`)
  if (stepN && stepN !== "undefined") lines.push(`step: ${stepN}`)
  if (typeof toks === "number") {
    const tin = st.tin
    const tout = st.tout
    const trea = st.trea
    lines.push(
      typeof tin === "number" && typeof tout === "number"
        ? `tokens: ${toks} (in ${tin}/out ${tout}/rea ${typeof trea === "number" ? trea : 0})`
        : `tokens: ${toks}`,
    )
  }
  if (typeof cost === "number") lines.push(`cost: $${cost.toFixed(4)}`)
  lines.push("status: ✅")
  return lines.join("\n")
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
    let lastRound = ""
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
          // R2852：不再按单条字符数截断；用户明确要求“不要截断”。
          push({ ts: msgTs, text: summary, kind: "compaction", label: "压缩摘要" })
        }
        continue
      }
      if (role === "user" || role === "synthetic") {
        const raw = textOf(m)
        if (!raw) continue
        const c = classifyUser(m, raw)
        if (!c) continue
        const text = c.text.trim()
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
          if (txt) push({ ts: pTs, text: txt, kind: "reasoning", label: "思考" })
          continue
        }
        if (typ === "text") {
          const txt = String(p?.text ?? "").trim()
          if (txt) {
            const rnd = roundOf(txt)
            if (rnd) lastRound = rnd
            push({ ts: pTs, text: txt, kind: "assistant", label: "助手" })
          }
          continue
        }
        if (typ === "tool") {
          const name = String(p?.tool ?? p?.name ?? "?").trim() || "?"
          push({
            ts: pTs,
            text: toolCardText(p),
            kind: "tool",
            label: "工具",
            toolName: name,
            force: name === "question",
          })
          continue
        }
        // R2852：TG 的「✅ 完成」卡片来自 step-finish part；模拟 TG 时必须一并收集，
        // 否则当前过滤为“全部”时文件里会缺掉聊天里明明有的一条。
        if (typ === "step-finish" || typ === "step_finish") {
          push({ ts: pTs, text: statusCardText(p, lastRound), kind: "status", label: "完成" })
        }
      }
      const err = errorText(info?.error)
      if (err) push({ ts: msgTs, text: err, kind: "error", label: "助手（错误）" })
    }
  }
  for (const p of o.pending ?? []) {
    const ts = asMs(p?.ts)
    if (!ts || ts < from || ts > to) continue
    const sid = String(p?.sid ?? "")
    // 只并入本次导出会话的待注入项；调用方没给会话时（纯队列导出）才全收。
    if (knownSids.size > 0 && !knownSids.has(sid)) continue
    const text = inboundBody(String(p?.text ?? "")).trim()
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
  // R2852：默认“模拟 TG”；完整记录必须显式选择。默认不限制条数/字节；
  // 只有调用方明确给 maxMessages/maxBytes 时才截断。
  const mode: TranscriptMode = o.mode === "full" ? "full" : "tg"
  const filters: TranscriptFilters = {
    reply: filterLevel(o.filters?.reply ?? 2),
    think: filterLevel(o.filters?.think ?? 2),
    tool: filterLevel(o.filters?.tool ?? 2),
    status: filterLevel(o.filters?.status ?? 2),
  }
  const rawMaxMessages = Number(o.maxMessages)
  const rawMaxBytes = Number(o.maxBytes)
  const maxMessages =
    Number.isFinite(rawMaxMessages) && rawMaxMessages > 0
      ? Math.max(1, Math.floor(rawMaxMessages))
      : TRANSCRIPT_MAX_MESSAGES
  const maxBytes =
    Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
      ? Math.max(4096, Math.floor(rawMaxBytes))
      : TRANSCRIPT_MAX_BYTES
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
  const visible = (x: InboundStackItem): boolean => {
    if (mode === "full") return true
    // question 工具在桥上无视 tool 档位，必须送达。
    if (x.force) return true
    // 内部注入提示（自动循环/恢复/换会话/CI/系统）不会出现在 TG 聊天里。
    if (x.kind === "prompt") return false
    if (x.kind === "assistant") return filters.reply > 0
    if (x.kind === "reasoning") return filters.think > 0
    if (x.kind === "tool") return filters.tool > 0
    if (x.kind === "status") return filters.status > 0
    // 用户消息、错误、压缩摘要不受这四类过滤影响（与桥的推送行为一致）。
    return true
  }
  const bodyOf = (x: InboundStackItem): string => {
    if (mode === "full") return x.text
    // question 卡片在桥上总是完整发送，不受“仅标题”档位影响。
    if (x.force) return x.text
    // 档位 1 = 仅标题：与 TG 卡片只显示标题行一致。
    if (x.kind === "assistant" && filters.reply === 1) return ""
    if (x.kind === "reasoning" && filters.think === 1) return ""
    if (x.kind === "tool" && filters.tool === 1) return ""
    if (x.kind === "status" && filters.status === 1) return ""
    return x.text
  }
  const items = collectInboundStack({ from, to, sessions, pending: o.pending }).filter(visible)
  const sids = [...new Set(items.map((x) => x.sid).filter(Boolean))]
  const multi = sids.length > 1
  const titleOf = new Map<string, string>()
  for (const s of sessions) titleOf.set(String(s?.sessionID ?? ""), String(s?.title ?? "").trim())
  const labelFor = (x: InboundStackItem): string => {
    const t = String(x.title ?? titleOf.get(x.sid) ?? "").trim()
    return t ? clip(t, 32).text : String(x.sid ?? "").slice(0, 12)
  }
  const tagFor = (x: InboundStackItem): string => {
    if (x.pending) return `用户（${x.inflight ? "正在注入" : "待注入"}）`
    if (mode === "full") return x.label
    if (x.kind === "assistant") return "💬 回复"
    if (x.kind === "reasoning") return "🧠 思考"
    if (x.kind === "tool") {
      const name = String(x.toolName ?? "tool")
      const disp = name.charAt(0).toUpperCase() + name.slice(1)
      return x.force ? `❓ 询问 · ${disp}` : `🔧 ${disp} 执行`
    }
    if (x.kind === "status") return "✅ 完成"
    if (x.kind === "compaction") return "🗜 压缩"
    if (x.kind === "error") return "❌ 生成失败"
    return x.label
  }

  const blocks: string[] = []
  let bytes = 0
  let truncated = items.length > maxMessages
  for (const x of items) {
    if (blocks.length >= maxMessages) {
      truncated = true
      break
    }
    const tag = `${tagFor(x)}${multi ? ` · ${labelFor(x)}` : ""}`
    const body = bodyOf(x)
    const block = body ? `## ${fmt(x.ts)} · ${tag}\n\n${body}` : `## ${fmt(x.ts)} · ${tag}`
    const blockBytes = new TextEncoder().encode(block).length
    // 至少保留第一条：否则“有消息但文件为空”更难解释。
    if (blocks.length > 0 && bytes + blockBytes > maxBytes) {
      truncated = true
      break
    }
    blocks.push(block)
    bytes += blockBytes
  }

  let heading = String(o.heading ?? (mode === "tg" ? "会话记录（模拟 TG）" : "TG 429 期间会话记录")).trim()
  if (mode === "tg" && heading && !heading.includes("模拟")) heading += "（模拟 TG）"
  heading = heading || (mode === "tg" ? "会话记录（模拟 TG）" : "TG 429 期间会话记录")
  const generatedAt = asMs(o.generatedAt) || Date.now()
  const filenameID = String(o.filenameID ?? "").trim() || "session"
  const count = blocks.length
  const filename = transcriptFilename(filenameID, from, to, mode)
  if (count === 0) return { filename, text: "", count: 0, truncated, from, to, sessions: 0 }
  const titleLine = !multi ? `- 标题：${String(titleOf.get(sids[0] ?? "") ?? "").trim()}` : ""
  const filterLine =
    mode === "tg"
      ? `- 过滤：回复=${FILTER_STATE_LABEL[filters.reply]} / 思考=${FILTER_STATE_LABEL[filters.think]} / 工具=${FILTER_STATE_LABEL[filters.tool]} / 完成=${FILTER_STATE_LABEL[filters.status]}`
      : "- 模式：完整记录（不受 TG 推送过滤影响）"
  const note =
    mode === "tg"
      ? "- 说明：模拟 Telegram 实际会收到的内容——用户消息、助手正文、错误、压缩摘要按时间堆叠；回复/思考/工具/完成按本 Bot 当前过滤档位取舍（工具档位=全部时含入参与结果）；自动循环/CI 恢复等内部提示、命令回复不写入。"
      : "- 说明：按时间堆叠窗口内的用户消息、注入提示（自动循环/恢复/换会话/CI 恢复）、思考、助手正文/错误、压缩摘要、工具卡片（含入参/结果）与完成状态；命令回复未导出。「待注入」是导出时仍在队列里的消息。"
  const header = [
    `# ${heading}`,
    "",
    o.botLabel ? `- Bot：${String(o.botLabel)}` : "",
    multi ? `- 会话：${sids.length} 个` : `- 会话：${sids[0] ?? ""}`,
    titleLine && titleLine !== "- 标题：" ? titleLine : "",
    `- 区间：${fmt(from)} – ${fmt(to)}`,
    `- 记录：${count} 条${truncated ? "（已截断）" : ""}`,
    `- 生成：${fmt(generatedAt)}`,
    filterLine,
    note,
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

/**
 * R2852：Telegram 单文档上限 50MB。超过时按 UTF-8 字节切卷，绝不截断；
 * 优先在换行处切，单行过长才按码点二分。返回的每段拼起来与原文完全一致
 * （依次拼接可还原），且不会切在代理对中间。
 */
export const splitTranscriptUpload = (
  text: string,
  maxBytes = TRANSCRIPT_UPLOAD_PART_BYTES,
): string[] => {
  const s = String(text ?? "")
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || TRANSCRIPT_UPLOAD_PART_BYTES))
  const enc = new TextEncoder()
  const byteLen = (v: string): number => enc.encode(v).length
  if (byteLen(s) <= limit) return [s]
  const out: string[] = []
  let rest = s
  while (rest) {
    if (byteLen(rest) <= limit) {
      out.push(rest)
      break
    }
    // 按码点二分出当前段能放下的最长前缀（UTF-8 字节数随码点前缀单调递增）。
    const chars = Array.from(rest)
    let lo = 1
    let hi = chars.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (byteLen(chars.slice(0, mid).join("")) <= limit) lo = mid
      else hi = mid - 1
    }
    let cut = chars.slice(0, lo).join("").length
    // 优先在换行后切，且换行留在左段：保证 parts.join("") 与原文完全一致。
    const nl = rest.lastIndexOf("\n", cut - 1)
    if (nl > 0) cut = nl + 1
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return out.length ? out : [s]
}
