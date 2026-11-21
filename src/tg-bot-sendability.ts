/**
 * R2851（运营者：「有没有提供全部bot的tg可发性的命令」）：全部 Bot 的 Telegram
 * 可发性探测。
 *
 * 背景：`/tgping` 只报**当前实例**的本地状态（而且会清 activeFrontOverride），
 * `/config` 只列注册表与离线原因，没有一个命令能回答“每个 Bot 此刻能不能把
 * 消息发到 Telegram”。这里补一条只读命令 `/tgpingall`（等价 `/tgping all`）：
 *
 *   1. 读注册表 + 自动发现的 tg-bot*.env（规则与入口 readRegistry 一致）；
 *   2. 每个 token 调 getMe 验 token，并按 Telegram bot id 找同号条目；
 *   3. 对 push chat 调一次 sendChatAction（typing）——它是发送类方法，但不产生
 *      聊天消息，适合作为轻量“可发性”探针；
 *   4. 读取 poll 租约新鲜度与共享 429 冷却标记，区分“API 可发但进程不在线”。
 *
 * 边界：不改任何状态文件、不清前台缓存、不向会话注入内容。探测失败只回报，
 * 不影响桥的正常发送队列/限流闸门。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { STATE_DIR } from "./state-io"

const TG_API = "https://api.telegram.org"
const DEFAULT_TIMEOUT_MS = 8_000
const OWNER_STALE_MS = 90_000
const BOT_ID_RE = /^[a-z0-9_-]{1,24}$/i
const BOT_ENV_RE = /^tg-bot([a-z0-9_-]{1,24})\.env$/i

export type BotRegistryEntry = {
  id: string
  label?: string
  envFile?: string
  pushChat?: string
}

export type BotTarget = {
  id: string
  label: string
  envFile: string
  token: string
  pushChat: string
}

export type TokenState = "ok" | "missing" | "rejected" | "rate" | "network" | "unknown"
export type SendState = "ok" | "skip" | "nochat" | "blocked" | "notfound" | "rate" | "network" | "unknown"

export type BotSendResult = {
  id: string
  label: string
  /** getMe 返回的 @username；失败时为空。 */
  username: string
  chat: string
  state: "ok" | "warn" | "fail"
  tokenState: TokenState
  sendState: SendState
  /** getMe + typing 探测总耗时（毫秒）。 */
  ms: number
  /** 面向运营者的一句补充（错误原因/同号/离线）。 */
  detail: string
  /** true=租约新鲜；false=租约超时；null=没有租约文件（未知）。 */
  online: boolean | null
  /** 同号时指向真正接入的那个 Bot 的显示名。 */
  duplicateOf: string
}

type TgCallResult = {
  status: number
  ok: boolean
  json: any
  ms: number
  error: string
}

type GetMeResult = TgCallResult & {
  botId: string
  username: string
}

/** 解析 dotenv 形态的 env 文件；只取简单 KEY=VALUE，忽略注释与非法键。 */
export const parseEnvText = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const i = line.indexOf("=")
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
    let value = line.slice(i + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export const readEnvFile = (path: string): Record<string, string> => {
  try {
    return parseEnvText(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

/** 注册表 JSON → 合法条目；非法 id 与重复 id 静默跳过（与入口 readRegistry 同规则）。 */
export const parseBotRegistry = (raw: unknown): BotRegistryEntry[] => {
  const j = raw as any
  const out: BotRegistryEntry[] = []
  const seen = new Set<string>()
  for (const b of Array.isArray(j?.bots) ? j.bots : []) {
    const id = String(b?.id ?? "").trim()
    if (!BOT_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: typeof b?.label === "string" && b.label.trim() ? b.label.trim() : undefined,
      envFile: typeof b?.envFile === "string" && b.envFile ? b.envFile : undefined,
      pushChat: typeof b?.pushChat === "string" && b.pushChat ? b.pushChat : undefined,
    })
  }
  return out
}

const firstChat = (value: unknown): string => {
  const s = String(value ?? "").split(",")[0]?.trim() ?? ""
  return s
}

const displayLabel = (raw: unknown, id: string): string => {
  const s = String(raw ?? "").trim().replace(/^@+/, "")
  return s ? `@${s}` : `@${id}`
}

/**
 * 发现全部 Bot：注册表优先，其次自动发现的 `tg-bot*.env`，最后是 primary 的
 * `tg.env` 兜底。返回顺序稳定（注册表顺序 → 目录排序 → primary）。
 *
 * 与入口 readRegistry 的差异：**不按 token 去重**。入口只保留一个轮询者，
 * 而本命令的用途正是把“同号/被顶掉”的条目也如实列出来。
 */
export const discoverBotTargets = (opts: { home?: string; registryPath?: string } = {}): BotTarget[] => {
  const home = opts.home ?? process.env.HOME ?? "/root"
  const registryPath = opts.registryPath ?? process.env.TG_BOTS_PATH ?? `${home}/.config/opencode/tg-bots.json`
  const specs: BotRegistryEntry[] = []
  const seen = new Set<string>()
  const add = (e: BotRegistryEntry): void => {
    if (!BOT_ID_RE.test(e.id) || seen.has(e.id)) return
    seen.add(e.id)
    specs.push(e)
  }

  try {
    for (const e of parseBotRegistry(JSON.parse(readFileSync(registryPath, "utf8")))) add(e)
  } catch {
    /* 无注册表：继续自动发现 */
  }

  for (const dir of [`${home}/.config/opencode`, `${home}/.opencode`]) {
    let names: string[] = []
    try {
      names = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const n of names) {
      const m = BOT_ENV_RE.exec(n)
      if (!m) continue
      const sfx = m[1].toLowerCase()
      const id = sfx.startsWith("bot") ? sfx : `bot${sfx}`
      if (seen.has(id)) continue
      const envFile = `${dir}/${n}`
      const env = readEnvFile(envFile)
      if (!env.TG_BOT_TOKEN) continue
      add({ id, label: env.TG_BOT_LABEL || id, envFile })
    }
  }

  if (!seen.has("primary")) {
    for (const p of [`${home}/.opencode/tg.env`, `${home}/.config/opencode/tg.env`]) {
      if (readEnvFile(p).TG_BOT_TOKEN) {
        add({ id: "primary", label: "CI", envFile: p })
        break
      }
    }
  }

  // 非主 Bot 未单独配置 chat 时，入口会继承 primary 的 chat；这里保持同一口径。
  const primarySpec = specs.find((s) => s.id === "primary")
  const primaryEnvFile =
    primarySpec?.envFile ??
    [`${home}/.opencode/tg.env`, `${home}/.config/opencode/tg.env`].find((p) => existsSync(p)) ??
    ""
  const primaryEnv = readEnvFile(primaryEnvFile)
  const primaryPush = primarySpec?.pushChat || firstChat(primaryEnv.TG_PUSH_CHAT) || firstChat(primaryEnv.TG_ALLOWED_CHAT)

  return specs.map((s) => {
    const env = readEnvFile(s.envFile ?? "")
    const token = env.TG_BOT_TOKEN ?? env.TG_FALLBACK_BOT_TOKEN ?? ""
    const chat = s.pushChat || firstChat(env.TG_PUSH_CHAT) || firstChat(env.TG_ALLOWED_CHAT) || primaryPush || ""
    return {
      id: s.id,
      label: displayLabel(s.label || env.TG_BOT_LABEL || s.id, s.id),
      envFile: s.envFile ?? "",
      token,
      pushChat: chat,
    }
  })
}

/** token 失败的分类（纯函数，便于单测）。 */
export const classifyTokenFailure = (status: number, desc: string): TokenState => {
  const d = String(desc ?? "").toLowerCase()
  if (status === 401 || /unauthori[sz]ed|invalid token/.test(d)) return "rejected"
  if (status === 429 || /too many requests|retry after/.test(d)) return "rate"
  if (status === 0 || /network|fetch failed|timeout|timed out|econn|enotfound|etimedout|eai_again/.test(d)) return "network"
  return "unknown"
}

/** 发送探测失败的分类（纯函数，便于单测）。 */
export const classifySendFailure = (status: number, desc: string): SendState => {
  const d = String(desc ?? "").toLowerCase()
  if (status === 429 || /too many requests|retry after|flood/.test(d)) return "rate"
  if (status === 403 || /blocked|kicked|not enough rights|forbidden|bot was blocked/.test(d)) return "blocked"
  if (status === 400 || /chat not found|user not found|peer_id_invalid|not a member|have no rights|chat_id is empty/.test(d)) return "notfound"
  if (status === 0 || /network|fetch failed|timeout|timed out|econn|enotfound|etimedout|eai_again/.test(d)) return "network"
  return "unknown"
}

const retryAfterOf = (json: any): number => {
  const n = Number(json?.parameters?.retry_after)
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0
}

const descOf = (r: TgCallResult): string => {
  const d = r.json?.description
  return String(d ?? r.error ?? "").slice(0, 80)
}

const tgCall = async (
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  body: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<TgCallResult> => {
  const started = Date.now()
  try {
    const res = await fetchImpl(`${TG_API}/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON 响应：保留状态码 */
    }
    return { status: res.status, ok: res.ok && json?.ok === true, json, ms: Date.now() - started, error: "" }
  } catch (err: any) {
    return { status: 0, ok: false, json: null, ms: Date.now() - started, error: String(err?.message ?? err) }
  }
}

const ownerOnline = (id: string): boolean | null => {
  const path = id === "primary" ? "/tmp/opencode/tg-poll-owner.json" : `/tmp/opencode/tg-poll-owner-${id}.json`
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as any
    const ts = Number(j?.tg?.ts)
    if (!Number.isFinite(ts) || ts <= 0) return null
    return Date.now() - ts <= OWNER_STALE_MS
  } catch {
    return null
  }
}

const activeFlood = (id: string, now: number): { until: number } | null => {
  try {
    const j = JSON.parse(readFileSync(`${STATE_DIR}/bot-flood.json`, "utf8")) as any
    const e = j?.floods?.[id]
    const until = Number(e?.until)
    return Number.isFinite(until) && until > now ? { until } : null
  } catch {
    return null
  }
}

export type ProbeOptions = {
  /** 测试注入；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
  /** 测试注入；默认读 poll 租约文件。 */
  ownerOnline?: (id: string) => boolean | null
  /** 测试注入；默认读共享 bot-flood.json。 */
  floodUntil?: (id: string, now: number) => number
}

/**
 * 探测全部 Bot。网络请求只发往 Telegram 官方 API；不写任何状态。
 * 同号条目只探测真正接入的那一个，其余标记为“未接入”，避免同一 bot 被探测多次。
 */
export const probeAllBots = async (targets: readonly BotTarget[], opts: ProbeOptions = {}): Promise<BotSendResult[]> => {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = Math.max(1_000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const now = opts.now ?? Date.now
  const ownerOf = opts.ownerOnline ?? ownerOnline
  const floodOf = opts.floodUntil ?? ((id: string, at: number) => activeFlood(id, at)?.until ?? 0)
  // getMe 并行：某个 token 卡住时不能把命令拖成 N×timeout。
  const meResults: GetMeResult[] = await Promise.all(
    targets.map(async (t): Promise<GetMeResult> => {
      if (!t.token) {
        return { status: 0, ok: false, json: null, ms: 0, error: "", botId: "", username: "" }
      }
      const r = await tgCall(fetchImpl, t.token, "getMe", undefined, timeoutMs)
      return {
        ...r,
        botId: String(r.json?.result?.id ?? ""),
        username: String(r.json?.result?.username ?? ""),
      }
    }),
  )

  // 按 Telegram bot id 分组：同一 bot 的多个 token/条目只能有一个真正轮询。
  const groups = new Map<string, number[]>()
  meResults.forEach((r, i) => {
    if (!r.ok || !r.botId) return
    const g = groups.get(r.botId)
    if (g) g.push(i)
    else groups.set(r.botId, [i])
  })
  const duplicateOf = new Map<number, number>()
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    const winner = idxs.find((i) => targets[i].id === "primary") ?? idxs[0]
    for (const i of idxs) if (i !== winner) duplicateOf.set(i, winner)
  }

  // 只对每个 bot 的接入条目发 typing；不同 token 是不同 bot，互不抢限流。
  const sendResults = new Map<number, TgCallResult>()
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const me = meResults[i]
    if (duplicateOf.has(i) || !me.ok) continue
    if (!t.pushChat) continue
    if (floodOf(t.id, now()) > now()) continue
    sendResults.set(i, await tgCall(fetchImpl, t.token, "sendChatAction", { chat_id: t.pushChat, action: "typing" }, timeoutMs))
  }

  return targets.map((t, i) => {
    const me = meResults[i]
    const online = ownerOf(t.id)
    const dup = duplicateOf.get(i)
    const dupTarget = dup === undefined ? undefined : targets[dup]
    const send = sendResults.get(i)
    const base: BotSendResult = {
      id: t.id,
      label: t.label,
      username: me.username,
      chat: t.pushChat,
      state: "ok",
      tokenState: "ok",
      sendState: "skip",
      ms: me.ms + (send?.ms ?? 0),
      detail: "",
      online,
      duplicateOf: "",
    }

    if (!t.token) {
      return { ...base, state: "fail", tokenState: "missing", detail: "未配置 token" }
    }
    if (!me.ok) {
      const state = classifyTokenFailure(me.status, descOf(me))
      const ra = retryAfterOf(me.json)
      return {
        ...base,
        state: "fail",
        tokenState: state,
        detail: ra > 0 ? `重试 ${ra}s` : descOf(me),
      }
    }
    if (dup !== undefined && dupTarget) {
      return {
        ...base,
        state: "warn",
        sendState: "skip",
        duplicateOf: dupTarget.label,
        detail: `与 ${dupTarget.label} 同号（同一 Telegram Bot，未接入）`,
      }
    }
    if (!t.pushChat) {
      return { ...base, state: "fail", sendState: "nochat", detail: "未配置推送 chat" }
    }
    const floodUntil = floodOf(t.id, now())
    if (floodUntil > now()) {
      const left = Math.max(1, Math.ceil((floodUntil - now()) / 1000))
      return { ...base, state: "fail", sendState: "rate", detail: `429 冷却中（剩 ${left}s）` }
    }
    if (!send) {
      return { ...base, state: "warn", sendState: "skip", detail: "未执行发送探测" }
    }
    if (!send.ok) {
      const state = classifySendFailure(send.status, descOf(send))
      const ra = retryAfterOf(send.json)
      return {
        ...base,
        state: "fail",
        sendState: state,
        detail: ra > 0 ? `重试 ${ra}s` : descOf(send),
      }
    }
    return {
      ...base,
      state: online === false ? "warn" : "ok",
      sendState: "ok",
      detail: online === false ? "轮询租约超时（进程可能不在）" : "",
    }
  })
}

const TOKEN_LABEL: Record<TokenState, string> = {
  ok: "token OK",
  missing: "缺 token",
  rejected: "token 被拒",
  rate: "token 限流",
  network: "token 网络错误",
  unknown: "token 校验失败",
}

const SEND_LABEL: Record<SendState, string> = {
  ok: "可发",
  skip: "未探测",
  nochat: "未配置 chat",
  blocked: "发送被拦截",
  notfound: "chat 不可达",
  rate: "发送被限流",
  network: "发送网络错误",
  unknown: "发送失败",
}

/** 只保留 chat 的首尾，避免把完整 chat id 暴露在日志/转发里。 */
export const maskChat = (chat: string): string => {
  const s = String(chat ?? "").trim()
  if (!s) return "-"
  if (s.startsWith("@")) return s
  if (s.length <= 6) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

export type SendabilityReport = {
  version: string
  currentBot: string
  results: readonly BotSendResult[]
}

/** 手机可读的一行一 Bot；纯函数，便于回归。 */
export const formatSendabilityReport = (o: SendabilityReport): string => {
  const results = [...o.results]
  const ok = results.filter((r) => r.state === "ok").length
  const warn = results.filter((r) => r.state === "warn").length
  const fail = results.filter((r) => r.state === "fail").length
  const lines = [
    `📡 全部 Bot 连通性 · ver=${o.version} · ${results.length} 个`,
    "🔎 token=getMe · 目标 chat=typing（不产生聊天消息）",
  ]
  for (const r of results) {
    const mark = r.state === "ok" ? "✅" : r.state === "warn" ? "⚠️" : "⛔"
    const me = r.id === o.currentBot ? "（本 Bot）" : ""
    const bits: string[] = []
    if (r.duplicateOf) bits.push("未接入")
    else if (r.tokenState !== "ok") bits.push(TOKEN_LABEL[r.tokenState])
    else if (r.sendState === "ok") bits.push("可发")
    else bits.push(SEND_LABEL[r.sendState])
    if (r.tokenState === "ok" && !r.duplicateOf && r.chat) bits.push(`chat=${maskChat(r.chat)}`)
    if (r.ms > 0) bits.push(`${r.ms}ms`)
    if (r.tokenState === "ok" && !r.duplicateOf) {
      bits.push(r.online === true ? "在线" : r.online === false ? "租约超时" : "租约未知")
    }
    if (r.detail) bits.push(r.detail)
    lines.push(`${mark} ${r.label}${me} · ${bits.join(" · ")}`)
  }
  lines.push(`汇总：可发 ${ok} · 注意 ${warn} · 不可发 ${fail}`)
  lines.push("· 只代表此刻 Telegram API 接受该 Bot 向目标 chat 发送；typing 不产生消息。")
  lines.push("· /tgping 仍测当前 Bot 的本地连通性；/status 看当前 Bot 运行态。")
  return lines.join("\n")
}
